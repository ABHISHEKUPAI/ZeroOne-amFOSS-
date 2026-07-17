/**
 * Resources expose the *reference data and provenance* behind the numbers, so a judge can audit a
 * figure without trusting the tool that produced it. A resource handler receives (uri, context) and
 * may return a plain object — the framework infers the content type and wraps it.
 */
import {
  ControllerDecorator as Controller,
  ResourceDecorator as Resource,
  type ExecutionContext,
} from '@nitrostack/core';
import { SessionStore } from '../../lib/session.store.js';
import { renderReport } from '../../lib/reports.js';
import {
  ARTIX7_XC7A35T,
  ECP5_25K,
  IHP_EUR_PER_MM2,
  TT_TILE_PRICE_EUR,
  TT_TILE_UM2,
} from '../../lib/types.js';

// @Controller is required for DI, not decoration: TypeScript only emits design:paramtypes for a
// class that carries a CLASS-level decorator. Without it the constructor gets no SessionStore and
// every handler dies on `this.store` being undefined — at read time, not at startup.
@Controller()
export class SiliconResources {
  constructor(private readonly store: SessionStore) {}

  @Resource({
    uri: 'silicon://targets',
    name: 'Target device capabilities',
    title: 'Target device capabilities',
    description:
      'Resource capacities and toolchain limits for every supported target. Read this before ' +
      'claiming a part fit or a timing number.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 3600 },
  })
  async targets() {
    return {
      artix7: {
        ...ARTIX7_XC7A35T,
        note:
          'LUT6 = 20,800, NOT 5,200. The widely-copied 5,200 figure counts SLICES and is off by 4x. ' +
          'Cite DS180.',
        fmax_available: false,
        fmax_reason:
          'Stock Yosys synth_xilinx is synthesis-only: no place-and-route, no timing analysis. ' +
          'nextpnr has no Xilinx support (that is openXC7 — separate project, needs prjxray-db, no ' +
          'WASM build). Utilization and part fit are real; timing closure must NOT be claimed.',
      },
      ecp5: {
        ...ECP5_25K,
        fmax_available: true,
        fmax_reason: 'nextpnr-ecp5 performs real place-and-route and reports achieved Fmax.',
      },
      ice40: {
        fmax_available: true,
        fmax_reason: 'nextpnr-ice40 performs real place-and-route and reports achieved Fmax.',
      },
      sky130: {
        fmax_available: false,
        area_available: true,
        note:
          'ASIC standard-cell flow. Real cell area via stat -liberty against the vendored ' +
          'sky130_fd_sc_hd__tt_025C_1v80.lib (428 cells with area attributes). This is the only ' +
          'target that yields an area figure, and therefore the only one that can be costed.',
      },
    };
  }

  @Resource({
    uri: 'silicon://cost-model',
    name: 'Cost model and provenance',
    title: 'Cost model and provenance',
    description:
      'The exact cost formula, its inputs, its sources, and what it deliberately excludes. ' +
      'Read this to audit any euro figure this server reports.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 3600 },
  })
  async costModel() {
    return {
      formula: {
        area_um2: 'stat -liberty -> "area"  (real sky130 cell areas)',
        die_mm2: 'area_um2 / 1e6 / utilization   (utilization ~0.5-0.7)',
        cost_eur: `die_mm2 * ${IHP_EUR_PER_MM2}`,
        tiles: `ceil(area_um2 / ${TT_TILE_UM2})   (TinyTapeout 160x100um tile)`,
      },
      sources: {
        cell_area:
          'sky130_fd_sc_hd__tt_025C_1v80.lib — vendored into assets/ (13MB, 428 cells with real ' +
          'area attributes, units um^2). Not fetched at runtime.',
        wafer_price: `IHP SG13G2 MPW: EUR ${IHP_EUR_PER_MM2}/mm^2, 40 samples.`,
        tinytapeout: `~EUR ${TT_TILE_PRICE_EUR} per ${TT_TILE_UM2} um^2 tile.`,
      },
      cross_check: {
        why:
          'One TT tile costs EUR ' +
          ((TT_TILE_UM2 / 1e6) * IHP_EUR_PER_MM2).toFixed(2) +
          ` under this model vs TinyTapeout's ~EUR ${TT_TILE_PRICE_EUR}. Same order of magnitude. TT ` +
          'is cheaper because it amortizes one die across hundreds of projects. Two independent ' +
          'sources agreeing is a stronger claim than either number alone.',
      },
      dead_sources: {
        efabless:
          'eFabless SHUT DOWN in March 2025. Any chipIgnite/MPW pricing derived from it is stale ' +
          'and must not be cited. (The efabless GitHub mirror still resolves and remains the right ' +
          'place to obtain the .lib — the org outlives the company.)',
      },
      excluded: {
        power:
          'Yosys has no power estimation. Static leakage is derivable from leakage_power in the ' +
          '.lib; dynamic power needs switching activity from a simulator this toolchain does not ' +
          'have. Omitted rather than invented.',
        rejected_approach:
          'Textbook wafer-cost/yield math (Murphy/Bose-Einstein) was rejected: at 130nm hobby scale ' +
          'yield ~= 1 and the wafer-price inputs are not publicly citable — it would mean inventing ' +
          'numbers. IHP publishes a real, current, quotable price.',
      },
    };
  }

  @Resource({
    uri: 'silicon://toolchain',
    name: 'Toolchain and its limits',
    title: 'Toolchain and its limits',
    description:
      'What actually runs, and what this server cannot do. Read this before making a claim about ' +
      'verification or timing.',
    mimeType: 'application/json',
    metadata: { cacheable: true, cacheMaxAge: 3600 },
  })
  async toolchain() {
    return {
      yosys: {
        version: 'Yosys 0.64 via @yowasp/yosys (WASM, in-process, no disk I/O)',
        verification:
          'sat -verify -prove-asserts -seq N — bounded model checking with minisat. Assertions are ' +
          'PROVED against all possible inputs for N cycles, not simulated against one stimulus.',
        no_sim:
          'The `sim` pass DOES NOT EXIST in this build. Verilator has no WASM build either. BMC is ' +
          'not a fallback — it is a stronger result, and it returns a concrete counterexample on failure.',
      },
      nextpnr: {
        version: '@yowasp/nextpnr-ecp5 (WASM)',
        targets: 'ECP5, iCE40 only. No Xilinx.',
      },
      honest_limits: [
        'No Artix-7 Fmax. Synthesis-only for Xilinx; timing closure is not claimed.',
        'No power figures. No estimator exists in this toolchain.',
        'No $display capture and no stimulus testbenches — there is no simulator.',
        'Verification is bounded: a proof holds for N cycles, not for all time.',
      ],
    };
  }

  @Resource({
    uri: 'silicon://designs',
    name: 'All designs',
    title: 'All designs in this session',
    description: 'Every design created in this session with its current pipeline status.',
    mimeType: 'application/json',
  })
  async designs() {
    return {
      count: this.store.list().length,
      designs: this.store.list().map((s) => ({
        design_id: s.id,
        spec: s.spec,
        target: s.target,
        elaborated: s.rtl?.elaborated ?? false,
        verified: s.verification?.ok ?? null,
        area_um2: s.synthesis?.areaUm2 ?? null,
        cost_eur: s.cost?.costEur ?? null,
        report_uri: `silicon://design/${s.id}/report`,
      })),
    };
  }
}

/**
 * Per-design reports as addressable documents. Registered as a template so clients can discover
 * the URI shape; the concrete read is resolved from the {id} in the URI.
 */
@Controller()
export class SiliconDesignResource {
  constructor(private readonly store: SessionStore) {}

  @Resource({
    uri: 'silicon://design/{id}/report',
    name: 'Design engineering report',
    title: 'Design engineering report (Markdown)',
    description:
      'The full engineering report for one design — RTL, Verification, Synthesis, Design Summary ' +
      'and Cost Analysis — rendered as Markdown. Substitute {id} with a design_id.',
    mimeType: 'text/markdown',
  })
  async report(uri: string, _ctx: ExecutionContext) {
    const m = uri.match(/^silicon:\/\/design\/([^/]+)\/report$/);
    const id = m?.[1];
    if (!id || id === '{id}') {
      const latest = this.store.latest();
      if (!latest)
        return '# No designs\n\nNo design exists yet. Call `write_rtl` to create one.';
      return renderReport(latest, 'all');
    }
    const s = this.store.get(decodeURIComponent(id));
    if (!s) return `# Unknown design\n\nNo design with id \`${id}\`.`;
    return renderReport(s, 'all');
  }
}
