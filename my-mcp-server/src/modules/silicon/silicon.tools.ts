/**
 * The EDA control plane.
 *
 * Tools return a RAW object — NitroStack wraps it in content blocks itself. Returning
 * `{content:[...]}` here would double-wrap. (Resources are the opposite; see silicon.resources.ts.)
 *
 * Every tool is written so that FAILURE IS DATA: a broken design comes back as a structured result
 * with `ok:false` and the log, never as a thrown error. That is what lets the model read the last
 * result and choose the next call — the control plane the whole project claims to be.
 */
import {
  ControllerDecorator as Controller,
  ToolDecorator as Tool,
  Widget,
  z,
  type ExecutionContext,
} from '@nitrostack/core';
import { computeCost, elaborate, placeAndRoute, synthesize, verifyDesign } from '../../lib/eda.js';
import { SessionStore } from '../../lib/session.store.js';
import { renderReport, REPORT_KINDS, type ReportKind } from '../../lib/reports.js';
import type { IpCandidate, Target } from '../../lib/types.js';

const TARGETS = ['sky130', 'ecp5', 'ice40', 'artix7'] as const;

@Controller()
export class SiliconTools {
  constructor(private readonly store: SessionStore) {}

  // --- IP reuse ---------------------------------------------------------------------------

  @Tool({
    name: 'search_ip',
    title: 'Search for existing IP cores',
    description:
      'Search GitHub for existing open-source Verilog/VHDL IP cores before writing RTL from scratch. ' +
      'Use this FIRST when the spec names a standard block (UART, SPI, I2C, FIFO, AXI), so the design ' +
      'can reference proven prior art. Returns repositories ranked by stars.',
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .describe('What to search for, e.g. "uart verilog" or "spi master rtl"'),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    invocation: { invoking: 'Searching for existing IP...', invoked: 'IP search complete' },
  })
  async searchIp(
    input: { query: string; limit: number },
    ctx: ExecutionContext,
  ): Promise<{ ok: boolean; query: string; count: number; results: IpCandidate[]; note?: string }> {
    // Repo search works unauthenticated. Code search (/search/code) returns 401 without a PAT —
    // do not switch to it.
    const url =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(input.query + ' language:verilog')}` +
      `&sort=stars&order=desc&per_page=${input.limit}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'silicon-architect' },
      });
      if (!res.ok) {
        return {
          ok: false,
          query: input.query,
          count: 0,
          results: [],
          note: `GitHub search returned ${res.status}. Proceed by writing RTL from the specification instead.`,
        };
      }
      const body = (await res.json()) as {
        items?: Array<{
          name: string;
          full_name: string;
          html_url: string;
          stargazers_count: number;
          description: string | null;
          license: { spdx_id: string } | null;
          updated_at: string;
        }>;
      };
      const results: IpCandidate[] = (body.items ?? []).map((r) => ({
        name: r.name,
        fullName: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count,
        description: r.description,
        license: r.license?.spdx_id ?? null,
        updatedAt: r.updated_at,
      }));

      const latest = this.store.latest();
      if (latest) latest.ip = results;
      ctx.logger.info(`search_ip "${input.query}" -> ${results.length} hits`);
      return { ok: true, query: input.query, count: results.length, results };
    } catch (e) {
      return {
        ok: false,
        query: input.query,
        count: 0,
        results: [],
        note: `IP search unavailable (${(e as Error).message}). Proceed by writing RTL from the specification.`,
      };
    }
  }

  // --- RTL --------------------------------------------------------------------------------

  @Tool({
    name: 'write_rtl',
    title: 'Submit RTL and elaborate it',
    description:
      'Submit Verilog/SystemVerilog for a design and elaborate it with Yosys (read_verilog + ' +
      'hierarchy -check). Creates a new design, or revises an existing one when design_id is given. ' +
      'Returns the elaboration verdict and the parsed module interfaces. If ok is false, read ' +
      'elaboration_log, fix the RTL, and call this again with the same design_id.',
    inputSchema: z.object({
      spec: z
        .string()
        .describe('The natural-language specification this RTL implements, e.g. "UART tx at 115200 baud"'),
      files: z
        .record(z.string())
        .describe('Map of filename to Verilog source, e.g. {"uart.v": "module uart(...)..."}'),
      top: z.string().describe('Name of the top module'),
      target: z.enum(TARGETS).default('sky130').describe('Fabrication/FPGA target'),
      clock_mhz: z.number().positive().nullable().default(null),
      design_id: z
        .string()
        .optional()
        .describe('Omit to create a new design; pass an existing id to revise its RTL'),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
    invocation: { invoking: 'Elaborating RTL...', invoked: 'RTL elaborated' },
  })
  @Widget('design-report')
  async writeRtl(
    input: {
      spec: string;
      files: Record<string, string>;
      top: string;
      target: Target;
      clock_mhz: number | null;
      design_id?: string;
    },
    ctx: ExecutionContext,
  ) {
    if (!Object.keys(input.files).length) throw new Error('files must contain at least one Verilog file.');

    const session = input.design_id
      ? this.store.require(input.design_id)
      : this.store.create(input.spec, input.target, input.clock_mhz);

    const prevRev = session.rtl?.revision ?? 0;
    const { artifact, ok } = await elaborate(input.files, input.top);

    session.rtl = { ...artifact, revision: prevRev + 1, updatedAt: new Date().toISOString() };
    // RTL changed: everything downstream describes the old design and is now a lie.
    session.verification = null;
    session.synthesis = null;
    session.pnr = null;
    session.cost = null;

    this.store.record(session.id, {
      tool: 'write_rtl',
      ok,
      summary: ok
        ? `rev ${session.rtl.revision}: elaborated ${artifact.modules.length} module(s)`
        : `rev ${session.rtl.revision}: elaboration FAILED`,
    });
    ctx.logger.info(`write_rtl ${session.id} rev${session.rtl.revision} ok=${ok}`);

    return {
      ok,
      design_id: session.id,
      top: input.top,
      revision: session.rtl.revision,
      modules: artifact.modules,
      lines: artifact.lines,
      elaboration_log: ok ? undefined : artifact.elaborationLog,
      next_step: ok
        ? 'Elaboration passed. Call simulate with a testbench module containing assert() statements to prove correctness.'
        : 'Elaboration FAILED. Read elaboration_log, fix the RTL, and call write_rtl again with the same design_id.',
      report: renderReport(session, 'rtl'),
    };
  }

  // --- verification -----------------------------------------------------------------------

  @Tool({
    name: 'simulate',
    title: 'Verify assertions (bounded model checking)',
    description:
      'Formally verify a design by proving its assertions with bounded model checking (Yosys `sat ' +
      '-prove-asserts`). This does NOT simulate a stimulus: each assertion is proved against ALL ' +
      'possible inputs for `depth` clock cycles, and a failure returns a concrete counterexample. ' +
      'The testbench must be a MODULE with clk/rst inputs that instantiates the DUT and contains ' +
      'IMMEDIATE assertions inside a clocked always block:\n' +
      '    always @(posedge clk) if (!rst) a_name: assert (<expr>);\n' +
      'Concurrent SVA — `assert property (@(posedge clk) ... |-> ...)` — is a SYNTAX ERROR here ' +
      '(it needs Verific, which the open-source Yosys does not ship). Express implication with a ' +
      'plain if, not |-> or |=>. An initial block will not work and $display is not captured. ' +
      'Returns ok:false plus per-assertion results with source locations when a proof fails.',
    inputSchema: z.object({
      design_id: z.string(),
      testbench: z
        .record(z.string())
        .describe(
          'Map of filename to testbench source. Must define a module with clk/rst inputs containing ' +
            'immediate assertions in an always block, e.g. ' +
            '"module tb(input clk, input rst); wire q; dut u(.clk(clk),.rst(rst),.q(q)); ' +
            'always @(posedge clk) if (!rst) a_q: assert (q == 1\'b1); endmodule". No SVA properties.',
        ),
      tb_top: z.string().describe('Name of the testbench module'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(12)
        .describe('Number of clock cycles to prove over'),
    }),
    annotations: { readOnlyHint: true },
    // ~seconds for a UART; a task lets the client show progress. There are no MCP progress
    // notifications, only notifications/tasks/status.
    taskSupport: 'optional',
    invocation: { invoking: 'Proving assertions...', invoked: 'Verification complete' },
  })
  @Widget('design-report')
  async simulate(
    input: { design_id: string; testbench: Record<string, string>; tb_top: string; depth: number },
    ctx: ExecutionContext,
  ) {
    const session = this.store.require(input.design_id);
    if (!session.rtl?.elaborated)
      throw new Error(
        `Design "${session.id}" has no elaborated RTL. Call write_rtl successfully before simulate.`,
      );

    const files = { ...session.rtl.files, ...input.testbench };
    const result = await verifyDesign(files, input.tb_top, input.depth, (m) => {
      ctx.task?.updateProgress(m);
      ctx.logger.debug(m);
    });

    session.verification = result;
    this.store.record(session.id, {
      tool: 'simulate',
      ok: result.ok,
      summary: result.ok
        ? `proved ${result.assertions.length} assertion(s) over ${result.depth} cycles`
        : `FAILED: ${result.assertions.filter((a) => a.status === 'failed').length}/${result.assertions.length} assertion(s) violated`,
    });

    const failed = result.assertions.filter((a) => a.status === 'failed');
    return {
      ok: result.ok,
      design_id: session.id,
      method: result.method,
      depth: result.depth,
      // The critical contract: a broken design returns ok:false with non-empty assertions[]
      // carrying src. This is the proof the pass/fail signal is real and not self-graded.
      assertions: result.assertions,
      counterexample: result.counterexample.slice(0, 40),
      log: result.ok ? undefined : result.log,
      next_step: result.ok
        ? 'All assertions proved. Call synthesize to map the design to real cells.'
        : failed.length
          ? `Assertion(s) violated: ${failed.map((f) => `${f.cell} at ${f.src ?? '?'}`).join(', ')}. ` +
            'Read the counterexample, fix the RTL, and call write_rtl with the same design_id.'
          : 'Verification did not produce a proof. Read log.',
      report: renderReport(session, 'verification'),
    };
  }

  // --- synthesis --------------------------------------------------------------------------

  @Tool({
    name: 'synthesize',
    title: 'Synthesize to real cells',
    description:
      'Synthesize the design with Yosys. For target sky130 this returns REAL cell area in µm² from ' +
      'the vendored liberty file (the input the cost model needs). For artix7/ecp5/ice40 it returns ' +
      'resource counts, and for artix7 a part fit against the XC7A35T. ' +
      'Note: Artix-7 synthesis reports utilization only — it cannot produce Fmax.',
    inputSchema: z.object({
      design_id: z.string(),
      target: z
        .enum(TARGETS)
        .optional()
        .describe("Defaults to the design's target. Use sky130 to obtain area for costing."),
    }),
    annotations: { readOnlyHint: true },
    taskSupport: 'optional',
    invocation: { invoking: 'Synthesizing...', invoked: 'Synthesis complete' },
  })
  @Widget('design-report')
  async synthesizeTool(input: { design_id: string; target?: Target }, ctx: ExecutionContext) {
    const session = this.store.require(input.design_id);
    if (!session.rtl?.elaborated)
      throw new Error(`Design "${session.id}" has no elaborated RTL. Call write_rtl first.`);

    const target = input.target ?? session.target;
    const result = await synthesize(session.rtl.files, session.rtl.top, target, (m) => {
      ctx.task?.updateProgress(m);
    });

    session.synthesis = result;
    this.store.record(session.id, {
      tool: 'synthesize',
      ok: true,
      summary: `${target}: ${result.cellCount} cells${result.areaUm2 != null ? `, ${result.areaUm2.toFixed(1)} µm²` : ''}`,
    });

    const unverified = !session.verification?.ok;
    return {
      ok: true,
      design_id: session.id,
      target,
      cell_count: result.cellCount,
      area_um2: result.areaUm2,
      sequential_area_um2: result.sequentialAreaUm2,
      buckets: result.buckets,
      utilization: result.utilization,
      fmax_mhz: null,
      fmax_note:
        target === 'artix7'
          ? 'Stock Yosys cannot produce Artix-7 Fmax (synthesis only, no place-and-route). Utilization is real; timing closure is NOT claimed. Use place_and_route on ecp5 for a real achieved-MHz figure.'
          : 'Synthesis does not produce timing. Call place_and_route (ecp5/ice40) for a real Fmax.',
      warning: unverified
        ? 'This design has not passed verification. Synthesis results describe unverified RTL.'
        : undefined,
      next_step:
        result.areaUm2 != null
          ? 'Area obtained. Call cost_sheet to price the die.'
          : 'For a cost estimate, call synthesize again with target "sky130" to obtain real cell area.',
      report: renderReport(session, 'synthesis'),
    };
  }

  // --- place & route ----------------------------------------------------------------------

  @Tool({
    name: 'place_and_route',
    title: 'Place, route and close timing',
    description:
      'Run real place-and-route with nextpnr and report the ACHIEVED Fmax. This is the only tool ' +
      'that produces a genuine timing number. ECP5 and iCE40 only — nextpnr has no Artix-7 support, ' +
      'so Fmax cannot be obtained for Xilinx parts with this toolchain.',
    inputSchema: z.object({
      design_id: z.string(),
      target: z.enum(['ecp5', 'ice40']).default('ecp5'),
      device: z
        .string()
        .default('25k')
        .describe('Device size, e.g. "25k" for ECP5 or "up5k" for iCE40'),
      target_mhz: z.number().positive().nullable().default(null),
    }),
    annotations: { readOnlyHint: true },
    taskSupport: 'optional',
    invocation: { invoking: 'Placing and routing...', invoked: 'Place & route complete' },
  })
  @Widget('design-report')
  async placeAndRouteTool(
    input: { design_id: string; target: 'ecp5' | 'ice40'; device: string; target_mhz: number | null },
    ctx: ExecutionContext,
  ) {
    const session = this.store.require(input.design_id);
    if (!session.rtl?.elaborated)
      throw new Error(`Design "${session.id}" has no elaborated RTL. Call write_rtl first.`);

    const result = await placeAndRoute(
      session.rtl.files,
      session.rtl.top,
      input.target,
      input.device,
      input.target_mhz ?? session.clockMhz,
      (m) => ctx.task?.updateProgress(m),
    );

    session.pnr = result;
    this.store.record(session.id, {
      tool: 'place_and_route',
      ok: result.fmaxMhz != null,
      summary: result.fmaxMhz != null ? `Fmax ${result.fmaxMhz.toFixed(1)} MHz` : 'no timing produced',
    });

    return {
      ok: result.fmaxMhz != null,
      design_id: session.id,
      device: `${result.target}:${result.device}`,
      fmax_mhz: result.fmaxMhz,
      target_mhz: result.targetMhz,
      timing_met: result.timingMet,
      utilization: result.utilization,
      log: result.fmaxMhz == null ? result.log : undefined,
      report: renderReport(session, 'summary'),
    };
  }

  // --- cost -------------------------------------------------------------------------------

  @Tool({
    name: 'cost_sheet',
    title: 'Price the die',
    description:
      'Convert real synthesized cell area into a fabrication cost using IHP SG13G2 MPW pricing ' +
      '(€7,300/mm²), with a TinyTapeout cross-check. Requires a prior sky130 synthesis — this tool ' +
      'will not invent an area figure.',
    inputSchema: z.object({
      design_id: z.string(),
      utilization: z
        .number()
        .min(0.1)
        .max(1)
        .default(0.6)
        .describe('Core utilization (placement density), typically 0.5-0.7'),
    }),
    annotations: { readOnlyHint: true },
    invocation: { invoking: 'Costing die...', invoked: 'Cost sheet ready' },
  })
  @Widget('design-report')
  async costSheet(input: { design_id: string; utilization: number }, ctx: ExecutionContext) {
    const session = this.store.require(input.design_id);
    const area = session.synthesis?.areaUm2;

    if (area == null) {
      // Refuse rather than guess. An invented area silently poisons every number downstream.
      throw new Error(
        `Design "${session.id}" has no area figure. Cost requires real cell area, which only ` +
          '`synthesize` with target "sky130" produces (area comes from stat -liberty). ' +
          `Call synthesize({design_id:"${session.id}", target:"sky130"}) first.`,
      );
    }

    const cost = computeCost(area, input.utilization);
    session.cost = cost;
    this.store.record(session.id, {
      tool: 'cost_sheet',
      ok: true,
      summary: `€${cost.costEur.toFixed(2)} for ${cost.dieMm2.toExponential(2)} mm²`,
    });
    ctx.logger.info(`cost_sheet ${session.id} -> EUR ${cost.costEur}`);

    return {
      ok: true,
      design_id: session.id,
      area_um2: cost.areaUm2,
      die_mm2: cost.dieMm2,
      cost_eur: cost.costEur,
      tinytapeout_tiles: cost.tiles,
      cross_check: cost.crossCheck,
      source: cost.source,
      report: renderReport(session, 'cost'),
    };
  }

  // --- reports ----------------------------------------------------------------------------

  @Tool({
    name: 'design_report',
    title: 'Generate the engineering report',
    description:
      'Produce the final engineering report for a design: RTL, Verification, Synthesis, Design ' +
      'Summary, and Cost Analysis. Use kind="all" for the complete costed report. Sections whose ' +
      'stage has not run are reported as "not run" rather than estimated.',
    inputSchema: z.object({
      design_id: z
        .string()
        .optional()
        .describe('Defaults to the most recent design'),
      kind: z
        .enum(['all', 'rtl', 'verification', 'synthesis', 'summary', 'cost'])
        .default('all')
        .describe('Which report to render'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    invocation: { invoking: 'Writing engineering report...', invoked: 'Report ready' },
  })
  @Widget('design-report')
  async designReport(input: { design_id?: string; kind: ReportKind }, ctx: ExecutionContext) {
    const session = input.design_id ? this.store.require(input.design_id) : this.store.latest();
    if (!session)
      throw new Error('No designs exist yet. Call write_rtl to create one before requesting a report.');

    const markdown = renderReport(session, input.kind);
    ctx.logger.info(`design_report ${session.id} kind=${input.kind}`);

    return {
      ok: true,
      design_id: session.id,
      kind: input.kind,
      // Structured data drives the widget; markdown is what a human/judge reads.
      report: markdown,
      sections: input.kind === 'all' ? REPORT_KINDS : [input.kind],
      design: {
        spec: session.spec,
        target: session.target,
        top: session.rtl?.top ?? null,
        verified: session.verification?.ok ?? null,
        assertions: session.verification?.assertions ?? null,
        area_um2: session.synthesis?.areaUm2 ?? null,
        cell_count: session.synthesis?.cellCount ?? null,
        utilization: session.synthesis?.utilization ?? null,
        fmax_mhz: session.pnr?.fmaxMhz ?? null,
        cost_eur: session.cost?.costEur ?? null,
        tiles: session.cost?.tiles ?? null,
        history: session.history,
      },
    };
  }

  @Tool({
    name: 'list_designs',
    title: 'List designs',
    description: 'List every design in this session with its pipeline status.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true },
  })
  async listDesigns() {
    const all = this.store.list();
    return {
      ok: true,
      count: all.length,
      designs: all.map((s) => ({
        design_id: s.id,
        spec: s.spec,
        target: s.target,
        top: s.rtl?.top ?? null,
        elaborated: s.rtl?.elaborated ?? false,
        verified: s.verification?.ok ?? null,
        area_um2: s.synthesis?.areaUm2 ?? null,
        cost_eur: s.cost?.costEur ?? null,
        created_at: s.createdAt,
      })),
    };
  }
}
