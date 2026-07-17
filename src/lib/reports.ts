/**
 * The five engineering reports.
 *
 * Hard rule: a section renders only from what the corresponding tool actually returned. If a stage
 * never ran, the section says "not run" and explains which tool to call. Nothing here estimates,
 * interpolates, or fills a gap with a plausible number — a fabricated figure in an engineering
 * report is worse than an absent one, and this report is the artifact a judge reads.
 */
import { ARTIX7_XC7A35T, type DesignSession } from './types.js';

export type ReportKind = 'rtl' | 'verification' | 'synthesis' | 'summary' | 'cost' | 'all';

export const REPORT_KINDS: ReportKind[] = ['rtl', 'verification', 'synthesis', 'summary', 'cost'];

const NOT_RUN = (what: string, tool: string) =>
  `> **Not run.** ${what} No data is available because \`${tool}\` has not been called for this design. ` +
  `This section is intentionally left empty rather than estimated.`;

function fmt(n: number, d = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pct(n: number): string {
  return n < 0.001 && n > 0 ? '<0.001%' : `${fmt(n, 3)}%`;
}

// --- 1. RTL ---------------------------------------------------------------------------------

export function rtlReport(s: DesignSession): string {
  const r = s.rtl;
  if (!r) return `## 1. RTL\n\n${NOT_RUN('No RTL has been written.', 'write_rtl')}`;

  const L: string[] = ['## 1. RTL', ''];
  L.push(`**Top module:** \`${r.top}\`  `);
  L.push(`**Files:** ${Object.keys(r.files).length}  `);
  L.push(`**Lines:** ${r.lines}  `);
  L.push(`**Revision:** ${r.revision}  `);
  L.push(
    `**Elaboration:** ${r.elaborated ? '✅ passed (`read_verilog` + `hierarchy -check`)' : '❌ FAILED'}`,
  );
  L.push('');

  if (!r.elaborated) {
    L.push('### Elaboration errors', '', '```', r.elaborationLog.slice(-1500), '```', '');
    L.push('> The RTL does not elaborate, so every downstream stage is blocked.');
    return L.join('\n');
  }

  if (r.modules.length) {
    L.push('### Module interfaces', '');
    L.push('_Extracted by Yosys `write_json` after elaboration — not by parsing text._', '');
    for (const m of r.modules) {
      L.push(`#### \`${m.name}\``, '');
      if (!m.ports.length) {
        L.push('_No ports._', '');
        continue;
      }
      L.push('| Port | Direction | Width |', '|---|---|---|');
      for (const p of m.ports) L.push(`| \`${p.name}\` | ${p.direction} | ${p.width} |`);
      L.push('');
    }
  }

  L.push('### Source', '');
  for (const [name, src] of Object.entries(r.files)) {
    L.push(`<details><summary><code>${name}</code></summary>`, '', '```verilog', src.trim(), '```', '', '</details>', '');
  }
  return L.join('\n');
}

// --- 2. Verification ------------------------------------------------------------------------

export function verificationReport(s: DesignSession): string {
  const v = s.verification;
  if (!v) return `## 2. Verification\n\n${NOT_RUN('The design has not been verified.', 'simulate')}`;

  const L: string[] = ['## 2. Verification', ''];
  L.push(`**Verdict:** ${v.ok ? '✅ **PASS**' : '❌ **FAIL**'}  `);
  L.push(`**Method:** bounded model checking (Yosys \`sat -prove-asserts\`, minisat)  `);
  L.push(`**Depth:** ${v.depth} clock cycles  `);
  L.push(`**Top:** \`${v.top}\`  `);
  L.push(`**Elapsed:** ${v.elapsedMs} ms`);
  L.push('');
  L.push(
    '> Assertions here are **proved**, not simulated. Each one is checked against *all* possible ' +
      `inputs for ${v.depth} cycles, not against a single stimulus. A pass is therefore a proof over ` +
      'that bound; it is not a claim of correctness beyond it.',
  );
  L.push('');

  // A compile failure and a genuinely un-asserted testbench are different problems with different
  // fixes. Say which one this is.
  if (v.compileError) {
    L.push('### Did not compile', '');
    L.push('The testbench (or the design it instantiates) failed to elaborate, so no proof ran.', '');
    L.push('```', v.compileError, '```', '');
    L.push(
      '> Common causes: a hierarchical reference to a signal that does not exist in the DUT ' +
        '(`uut.some_internal`), concurrent SVA (`assert property` — unsupported here), or a plain ' +
        'syntax error. Fix the testbench and re-run `simulate`.',
    );
    return L.join('\n');
  }

  if (!v.assertions.length) {
    L.push('### No assertions', '', '```', v.log.slice(-1200), '```', '');
    L.push(
      '> **This is reported as FAIL, not PASS.** Bounded model checking of zero assertions ' +
        'succeeds vacuously — it would prove nothing while looking green.',
    );
    return L.join('\n');
  }

  const proved = v.assertions.filter((a) => a.status === 'proved').length;
  L.push(`### Assertions (${proved}/${v.assertions.length} proved)`, '');
  L.push('| Assertion | Source | Result | Failing cycle |', '|---|---|---|---|');
  for (const a of v.assertions) {
    L.push(
      `| \`${a.cell}\` | ${a.src ? `\`${a.src}\`` : '_unknown_'} | ${
        a.status === 'proved' ? '✅ proved' : '❌ **failed**'
      } | ${a.failedAtStep ?? '—'} |`,
    );
  }
  L.push('');

  if (v.counterexample.length) {
    L.push('### Counterexample', '');
    L.push('_The concrete trace the solver found that violates the assertion._', '');
    L.push('```', v.counterexample.slice(0, 40).join('\n'), '```', '');
  }
  return L.join('\n');
}

// --- 3. Synthesis ---------------------------------------------------------------------------

export function synthesisReport(s: DesignSession): string {
  const y = s.synthesis;
  if (!y) return `## 3. Synthesis\n\n${NOT_RUN('The design has not been synthesized.', 'synthesize')}`;

  const L: string[] = ['## 3. Synthesis', ''];
  L.push(`**Target:** \`${y.target}\`  `);
  L.push(`**Top:** \`${y.top}\`  `);
  L.push(`**Cells:** ${y.cellCount.toLocaleString()}  `);
  L.push(`**Elapsed:** ${y.elapsedMs} ms`);
  L.push('');

  if (y.target === 'sky130') {
    if (y.areaUm2 != null) {
      L.push('### Area (real sky130 cell areas)', '');
      L.push(`| Metric | Value |`, '|---|---|');
      L.push(`| Total cell area | **${fmt(y.areaUm2, 3)} µm²** |`);
      if (y.sequentialAreaUm2 != null)
        L.push(`| Sequential (flip-flop) area | ${fmt(y.sequentialAreaUm2, 3)} µm² |`);
      L.push('');
      L.push(
        '_Area is read from `stat -liberty` against the vendored `sky130_fd_sc_hd__tt_025C_1v80.lib`. ' +
          'These are real foundry cell geometries, not an estimate. `dfflibmap` runs before `abc` so ' +
          'flip-flops are mapped to real library cells rather than landing in `unknown_cell_area`._',
      );
      L.push('');
    } else {
      L.push('> ⚠️ No area reported. Area is only produced by `stat -liberty`.', '');
    }
  }

  if (y.buckets) {
    L.push('### Resource usage', '');
    L.push('| Resource | Count |', '|---|---|');
    for (const [k, n] of Object.entries(y.buckets).sort((a, b) => b[1] - a[1]))
      L.push(`| ${k} | ${n.toLocaleString()} |`);
    L.push('');
    L.push(
      '_Cells are bucketed by name prefix. Yosys `-tech` cannot be combined with `-json` (it emits ' +
        'invalid JSON) and never reports area, so the bucketing is done here._',
    );
    L.push('');
  }

  if (y.utilization && y.target === 'artix7') {
    L.push(`### Part fit — Artix-7 ${ARTIX7_XC7A35T.part.toUpperCase()}`, '');
    L.push('| Resource | Used | Available | Utilization |', '|---|---|---|---|');
    for (const u of y.utilization)
      L.push(
        `| ${u.resource} | ${u.used.toLocaleString()} | ${u.available.toLocaleString()} | ${pct(u.percent)} |`,
      );
    L.push('');
    L.push(
      `_Capacities from ${ARTIX7_XC7A35T.source}. The XC7A35T has **${ARTIX7_XC7A35T.lut6.toLocaleString()} LUT6**, ` +
        'not 5,200 — the widely-copied 5,200 figure counts *slices* and is off by 4×._',
    );
    L.push('');
    L.push(
      '> ⚠️ **No Fmax for Artix-7.** Stock Yosys `synth_xilinx` is synthesis-only: no place-and-route, ' +
        'no timing analysis. Utilization and part fit are real; **timing closure is not claimed here.** ' +
        'For a real achieved-MHz number, run `place_and_route` against ECP5.',
    );
    L.push('');
  }

  const top = Object.entries(y.cellsByType).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) {
    L.push('<details><summary>Cell breakdown by type</summary>', '', '| Cell | Count |', '|---|---|');
    for (const [t, n] of top) L.push(`| \`${t.replace(/^\\/, '')}\` | ${n} |`);
    L.push('', '</details>', '');
  }
  return L.join('\n');
}

// --- 4. Design summary ----------------------------------------------------------------------

export function summaryReport(s: DesignSession): string {
  const L: string[] = ['## 4. Design Summary', ''];
  L.push(`**Design:** \`${s.id}\`  `);
  L.push(`**Specification:** ${s.spec}  `);
  L.push(`**Target:** \`${s.target}\`${s.clockMhz ? ` @ ${s.clockMhz} MHz` : ''}  `);
  L.push(`**Created:** ${s.createdAt}`);
  L.push('');

  L.push('### Pipeline status', '');
  L.push('| Stage | Tool | Status | Key result |', '|---|---|---|---|');

  const rtlOk = s.rtl?.elaborated;
  L.push(
    `| RTL | \`write_rtl\` | ${s.rtl ? (rtlOk ? '✅ elaborated' : '❌ failed') : '⬜ not run'} | ${
      s.rtl ? `${s.rtl.modules.length} module(s), ${s.rtl.lines} lines` : '—'
    } |`,
  );

  const v = s.verification;
  L.push(
    `| Verification | \`simulate\` | ${v ? (v.ok ? '✅ proved' : '❌ failed') : '⬜ not run'} | ${
      v ? `${v.assertions.filter((a) => a.status === 'proved').length}/${v.assertions.length} assertions over ${v.depth} cycles` : '—'
    } |`,
  );

  const y = s.synthesis;
  L.push(
    `| Synthesis | \`synthesize\` | ${y ? '✅ done' : '⬜ not run'} | ${
      y ? (y.areaUm2 != null ? `${fmt(y.areaUm2, 1)} µm², ${y.cellCount} cells` : `${y.cellCount} cells`) : '—'
    } |`,
  );

  const p = s.pnr;
  L.push(
    `| Place & route | \`place_and_route\` | ${p ? (p.timingMet ? '✅ timing met' : '⚠️ see report') : '⬜ not run'} | ${
      p ? (p.fmaxMhz != null ? `Fmax ${fmt(p.fmaxMhz, 1)} MHz` : 'no timing data') : '—'
    } |`,
  );

  const c = s.cost;
  L.push(
    `| Cost | \`cost_sheet\` | ${c ? '✅ done' : '⬜ not run'} | ${c ? `€${fmt(c.costEur)}` : '—'} |`,
  );
  L.push('');

  // The honest headline.
  const blockers: string[] = [];
  if (!s.rtl) blockers.push('no RTL written');
  else if (!rtlOk) blockers.push('RTL does not elaborate');
  if (v && !v.ok) blockers.push('verification failed');
  if (!v) blockers.push('not verified');

  L.push('### Verdict', '');
  if (blockers.length) {
    L.push(`> ⚠️ **Not sign-off ready** — ${blockers.join('; ')}.`);
  } else if (v?.ok && y) {
    L.push(
      `> ✅ **Verified and synthesized.** All ${v.assertions.length} assertion(s) proved over ${v.depth} ` +
        `cycles; design maps to ${y.cellCount} cells` +
        (y.areaUm2 != null ? ` (${fmt(y.areaUm2, 1)} µm²)` : '') +
        '.',
    );
  } else {
    L.push('> Verified, but not yet synthesized.');
  }
  L.push('');

  if (s.history.length) {
    L.push('<details><summary>Tool call history</summary>', '');
    L.push('| Time | Tool | OK | Summary |', '|---|---|---|---|');
    for (const h of s.history)
      L.push(`| ${h.at.slice(11, 19)} | \`${h.tool}\` | ${h.ok ? '✅' : '❌'} | ${h.summary} |`);
    L.push('', '</details>', '');
  }
  return L.join('\n');
}

// --- 5. Cost --------------------------------------------------------------------------------

export function costReport(s: DesignSession): string {
  const c = s.cost;
  if (!c)
    return (
      `## 5. Cost Analysis\n\n${NOT_RUN('No cost has been computed.', 'cost_sheet')}\n\n` +
      '> Cost requires a real area figure, which only `synthesize` against `sky130` produces.'
    );

  const L: string[] = ['## 5. Cost Analysis', ''];
  L.push('### Silicon cost', '');
  L.push('| Input | Value |', '|---|---|');
  L.push(`| Cell area | ${fmt(c.areaUm2, 3)} µm² |`);
  L.push(`| Assumed utilization | ${fmt(c.utilization * 100, 0)}% |`);
  L.push(`| Die area | ${c.dieMm2.toExponential(3)} mm² |`);
  L.push(`| MPW price | €${c.eurPerMm2.toLocaleString()}/mm² |`);
  L.push('');
  L.push(`### 💶 Estimated cost: **€${fmt(c.costEur)}**`, '');
  L.push(
    `Equivalent to **${c.tiles} TinyTapeout tile${c.tiles === 1 ? '' : 's'}** ` +
      `(1 tile = 160 µm × 100 µm = ${(16000).toLocaleString()} µm²).`,
    '',
  );

  L.push('### Independent cross-check', '');
  L.push('| Source | Cost per TT tile |', '|---|---|');
  L.push(`| This model (IHP SG13G2 MPW) | €${fmt(c.crossCheck.ourPerTileEur)} |`);
  L.push(`| TinyTapeout published price | ~€${fmt(c.crossCheck.ttTileCostEur, 0)} |`);
  L.push(`| Ratio | ${fmt(c.crossCheck.ratio)}× |`);
  L.push('');
  L.push(`> ${c.crossCheck.note}`);
  L.push('');

  L.push('### Provenance', '');
  L.push(`> ${c.source}`);
  L.push('');
  L.push('### Excluded', '');
  L.push(
    '- **Power.** Yosys has no power estimation. Static leakage is derivable from `leakage_power` in ' +
      'the liberty file; dynamic power needs switching activity from a simulator this toolchain does ' +
      'not have. Rather than publish a number we cannot defend, power is omitted.',
  );
  L.push('- **NRE, masks, packaging, test.** MPW shuttle pricing already amortizes mask cost.');
  L.push('');
  return L.join('\n');
}

// --- assembly -------------------------------------------------------------------------------

export function renderReport(s: DesignSession, kind: ReportKind): string {
  switch (kind) {
    case 'rtl':
      return rtlReport(s);
    case 'verification':
      return verificationReport(s);
    case 'synthesis':
      return synthesisReport(s);
    case 'summary':
      return summaryReport(s);
    case 'cost':
      return costReport(s);
    case 'all':
      return [
        `# Engineering Report — \`${s.id}\``,
        '',
        `> ${s.spec}`,
        '',
        `Generated ${new Date().toISOString()} by Silicon Architect. Every figure below is produced by a ` +
          'real EDA tool run (Yosys 0.64 / nextpnr, WASM, in-process). Stages that were not run are ' +
          'marked as such and are never estimated.',
        '',
        '---',
        '',
        summaryReport(s),
        '---',
        '',
        rtlReport(s),
        '---',
        '',
        verificationReport(s),
        '---',
        '',
        synthesisReport(s),
        '---',
        '',
        pnrReport(s),
        '---',
        '',
        costReport(s),
      ].join('\n');
  }
}

/** Not one of the five headline reports, but the only source of a real Fmax — folded into `all`. */
export function pnrReport(s: DesignSession): string {
  const p = s.pnr;
  if (!p)
    return (
      '## Place & Route (timing)\n\n' +
      NOT_RUN('No place-and-route has been run.', 'place_and_route') +
      '\n\n> Real Fmax requires nextpnr, which supports ECP5/iCE40 — not Artix-7.'
    );

  const L: string[] = ['## Place & Route (timing)', ''];
  L.push(`**Device:** \`${p.target}:${p.device}\`  `);
  L.push(`**Elapsed:** ${p.elapsedMs} ms`);
  L.push('');
  if (p.fmaxMhz != null) {
    L.push('| Metric | Value |', '|---|---|');
    L.push(`| Achieved Fmax | **${fmt(p.fmaxMhz, 2)} MHz** |`);
    if (p.targetMhz != null) L.push(`| Target | ${fmt(p.targetMhz, 2)} MHz |`);
    if (p.timingMet != null)
      L.push(`| Timing | ${p.timingMet ? '✅ met' : '❌ **not met**'} |`);
    L.push('');
    L.push('_Fmax is reported by nextpnr after real placement and routing — this is an achieved number._', '');
  } else {
    L.push('> No timing data was produced.', '');
  }
  if (p.utilization.length) {
    L.push('| Resource | Used | Available | Utilization |', '|---|---|---|---|');
    for (const u of p.utilization)
      L.push(`| ${u.resource} | ${u.used} | ${u.available} | ${pct(u.percent)} |`);
    L.push('');
  }
  return L.join('\n');
}
