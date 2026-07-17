/**
 * EDA orchestration. Every Yosys script in the project lives here.
 *
 * The pass ordering in these scripts is load-bearing and was established by probing the real WASM,
 * not by reading docs. See CLAUDE.md "Landmines" before reordering anything.
 */
import { LIB_NAME, extractLastJson, readTreeFile, runYosysScript, sky130Lib } from './yosys.js';
import {
  ARTIX7_XC7A35T,
  IHP_EUR_PER_MM2,
  TT_TILE_PRICE_EUR,
  TT_TILE_UM2,
  type AssertionResult,
  type CostResult,
  type NetlistGraph,
  type GraphNode,
  type GraphEdge,
  type PnrResult,
  type RtlArtifact,
  type RtlModule,
  type SynthesisResult,
  type Target,
  type VerificationResult,
  type Waveform,
  type WaveformSignal,
} from './types.js';

/** Verilog identifier, with Yosys's leading-backslash public-name marker stripped. */
function clean(name: string): string {
  return name.startsWith('\\') ? name.slice(1) : name;
}

interface JsonPort {
  direction: 'input' | 'output' | 'inout';
  bits: unknown[];
}
interface JsonCell {
  type: string;
  attributes?: Record<string, string>;
}
interface JsonModule {
  ports?: Record<string, JsonPort>;
  cells?: Record<string, JsonCell>;
  attributes?: Record<string, unknown>;
}
interface JsonDesign {
  modules?: Record<string, JsonModule>;
}

function fileList(files: Record<string, string>): string {
  return Object.keys(files).join(' ');
}

// --- elaboration ---------------------------------------------------------------------------

/**
 * Parse + elaborate. This is the first real feedback the model gets on its own RTL, so a failure
 * here must come back as data (log with the error), never as a thrown exception.
 */
export async function elaborate(
  files: Record<string, string>,
  top: string,
): Promise<{ artifact: Omit<RtlArtifact, 'revision' | 'updatedAt'>; ok: boolean }> {
  const script = `
read_verilog -sv ${fileList(files)}
hierarchy -check -top ${top}
proc
write_json design.json
`;
  const r = await runYosysScript(script, { ...files });
  const lines = Object.values(files).reduce((n, s) => n + s.split('\n').length, 0);

  let modules: RtlModule[] = [];
  if (r.ok) {
    const raw = readTreeFile(r.files, 'design.json');
    if (raw) {
      try {
        const d = JSON.parse(raw) as JsonDesign;
        modules = Object.entries(d.modules ?? {})
          .filter(([name]) => !name.startsWith('$'))
          .map(([name, m]) => ({
            name: clean(name),
            ports: Object.entries(m.ports ?? {}).map(([pn, p]) => ({
              name: clean(pn),
              direction: p.direction,
              width: Array.isArray(p.bits) ? p.bits.length : 0,
            })),
          }));
      } catch {
        /* leave modules empty; elaboration log still tells the story */
      }
    }
  }

  return {
    ok: r.ok,
    artifact: {
      files,
      top,
      modules,
      lines,
      elaborated: r.ok,
      elaborationLog: tail(r.log, 4000),
    },
  };
}

// --- verification --------------------------------------------------------------------------

/**
 * Common prelude for every proof.
 *
 * `-formal` is mandatory: without it Yosys silently DISCARDS SVA `assert property(...)` and the
 * design arrives with zero assertions — which then "proves" vacuously and reports success. `-sv`
 * alone only admits immediate assertions.
 * `flatten` is mandatory or SAT cannot see into submodules.
 * `async2sync` must precede any `t:$assert` selection: assert cells are type `$check` until then.
 */
function verifyPrelude(files: Record<string, string>, top: string): string {
  return `
read_verilog -sv -formal ${fileList(files)}
hierarchy -check -top ${top}
proc
flatten
opt
async2sync
opt
`.trim();
}

/**
 * Enumerate assert cells and their real source spans. Must run after async2sync.
 *
 * Returns `ok:false` when the design does not even compile — that is emphatically NOT the same as
 * "this design has no assertions", and conflating the two would report a broken testbench as an
 * un-asserted one and send the model chasing the wrong bug.
 */
async function listAsserts(
  files: Record<string, string>,
  top: string,
): Promise<{ ok: boolean; asserts: Array<{ cell: string; src: string | null }>; log: string }> {
  const r = await runYosysScript(`${verifyPrelude(files, top)}\nwrite_json v.json`, { ...files });
  if (!r.ok) return { ok: false, asserts: [], log: r.log };
  const raw = readTreeFile(r.files, 'v.json');
  if (!raw) return { ok: false, asserts: [], log: r.log };
  try {
    const d = JSON.parse(raw) as JsonDesign;
    const out: Array<{ cell: string; src: string | null }> = [];
    for (const m of Object.values(d.modules ?? {})) {
      for (const [cn, c] of Object.entries(m.cells ?? {})) {
        if (c.type === '$assert') out.push({ cell: clean(cn), src: c.attributes?.src ?? null });
      }
    }
    return { ok: true, asserts: out, log: r.log };
  } catch {
    return { ok: false, asserts: [], log: r.log };
  }
}

/**
 * Strip Yosys's AST debug vomit from a log.
 *
 * On certain elaboration errors (e.g. a hierarchical reference to a signal that doesn't exist)
 * Yosys dumps the ENTIRE parsed AST — thousands of `verilog-ast>` / `AST_*` lines — around the one
 * line that matters. Left in, it buries the actionable error under 30KB of noise and makes both the
 * tool result and the report unreadable. Keep everything that isn't AST dump.
 */
function cleanYosysLog(log: string): string {
  return log
    .split('\n')
    .filter((l) => !/^\s*(verilog-ast>|AST_[A-Z]|\[0x[0-9a-f]+\])/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first real, actionable error line, with the noise removed. */
function firstError(log: string): string | null {
  return cleanYosysLog(log).match(/^.*ERROR:.*$/m)?.[0]?.trim() ?? null;
}

/** Yosys has no Verific in the open-source build, so concurrent SVA is a syntax error. */
const SVA_HINT =
  'NOTE: `assert property (@(posedge clk) ...)` (concurrent SVA) is NOT supported by this Yosys ' +
  'build and is a SYNTAX ERROR — SVA requires Verific, which the open-source build does not ship. ' +
  'Use IMMEDIATE assertions inside a clocked always block instead:\n' +
  '    always @(posedge clk) if (!rst) a_name: assert (<expr>);\n' +
  'Implication is expressed with a plain if / ternary, not |-> or |=>.';

const PROOF_OK = /SAT proof finished - no model found: SUCCESS!/;
const PROOF_FAIL = /SAT proof finished - model found: FAIL!/;

/**
 * Bounded model check of every assertion.
 *
 * `sim` does not exist in this Yosys build, so assertions are *proved* over `depth` cycles rather
 * than exercised. Fast path proves all asserts in one run; only on failure do we pay for one run
 * per assert to say precisely which failed.
 */
export async function verifyDesign(
  files: Record<string, string>,
  top: string,
  depth: number,
  onProgress?: (msg: string) => void,
): Promise<VerificationResult> {
  const started = Date.now();
  const fail = (log: string, compileError: string | null = null): VerificationResult => ({
    ok: false,
    method: 'bmc-sat',
    depth,
    top,
    assertions: [],
    counterexample: [],
    trace: null,
    compileError,
    log,
    elapsedMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  });

  // Every early-exit path below is a non-proof: no violation was found, so there is no trace.
  const listed = await listAsserts(files, top);

  // The testbench does not compile. Say that — do not call it "no assertions".
  if (!listed.ok) {
    const err = firstError(listed.log) ?? 'unknown compile error';
    return fail(
      `The design or testbench failed to compile, so no proof was attempted.\n\n${err}\n\n${SVA_HINT}\n\n` +
        `--- log ---\n${tail(cleanYosysLog(listed.log), 2000)}`,
      err,
    );
  }

  const asserts = listed.asserts;

  // No assertions means nothing was proved. Reporting "pass" here would be the single most
  // dishonest thing this server could do — an empty proof trivially succeeds.
  if (asserts.length === 0) {
    return fail(
      `"${top}" compiles but contains NO assertions, so there is nothing to prove. Bounded model ` +
        `checking of zero assertions succeeds vacuously and proves nothing, so this is reported as a ` +
        `failure rather than a pass.\n\n${SVA_HINT}`,
    );
  }

  onProgress?.(`Proving ${asserts.length} assertion(s) over ${depth} cycles...`);

  const all = await runYosysScript(
    `${verifyPrelude(files, top)}
select -assert-count ${asserts.length} t:$assert
sat -verify -prove-asserts -seq ${depth} -show-all ${top}`,
    { ...files },
  );

  if (all.ok && PROOF_OK.test(all.log)) {
    return {
      ok: true,
      method: 'bmc-sat',
      depth,
      top,
      assertions: asserts.map((a) => ({ ...a, status: 'proved' as const, failedAtStep: null })),
      counterexample: [],
      // Proved: the solver found NO model. There is no counterexample, so there is no waveform.
      trace: null,
      compileError: null,
      log: tail(all.log, 3000),
      elapsedMs: Date.now() - started,
      ranAt: new Date().toISOString(),
    };
  }

  // A non-proof error (syntax, missing module) is not a failed assertion — surface it as-is.
  if (!PROOF_FAIL.test(all.log)) {
    const err = all.log.match(/ERROR:[^\n]*/)?.[0];
    if (err && !/proof did fail/.test(err)) {
      return {
        ok: false,
        method: 'bmc-sat',
        depth,
        top,
        assertions: [],
        counterexample: [],
        trace: null,
        compileError: null,
        log: tail(cleanYosysLog(all.log), 4000),
        elapsedMs: Date.now() - started,
        ranAt: new Date().toISOString(),
      };
    }
  }

  // Something failed. Isolate each assert to name the guilty one.
  const results: AssertionResult[] = [];
  for (const a of asserts) {
    onProgress?.(`Isolating assertion ${a.cell}...`);
    const one = await runYosysScript(
      `${verifyPrelude(files, top)}
chformal -remove t:$assert c:${a.cell} %d
select -assert-count 1 t:$assert
sat -verify -prove-asserts -seq ${depth} -show-all ${top}`,
      { ...files },
    );
    const proved = one.ok && PROOF_OK.test(one.log);
    results.push({
      cell: a.cell,
      src: a.src,
      status: proved ? 'proved' : 'failed',
      failedAtStep: proved ? null : failStep(one.log, a.cell),
    });
  }

  const cxLines = counterexampleLines(all.log);
  const trace = parseTrace(cxLines);
  const firstFailed = results.find((r) => r.status === 'failed');
  if (trace && firstFailed) {
    trace.failedAssertion = firstFailed.cell;
    trace.src = firstFailed.src;
    trace.failedAtCycle = firstFailed.failedAtStep;
  }

  return {
    ok: false,
    method: 'bmc-sat',
    depth,
    top,
    assertions: results,
    counterexample: cxLines,
    trace,
    compileError: null,
    log: tail(cleanYosysLog(all.log), 4000),
    elapsedMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  };
}

/**
 * The cycle at which THIS assertion was violated — or null when it cannot be known.
 *
 * `<cell>_EN` is the assertion's enable: 1 on cycles where it is actually checked. This runs on the
 * ISOLATED single-assert proof, so the trace is a counterexample for this assertion alone, and the
 * violation therefore lies on a cycle where EN == 1.
 *
 * When exactly one such cycle exists (the normal case — real assertions are guarded, e.g.
 * `if (past_rst) ...`), that cycle IS the violation. When several exist we cannot tell which one
 * the solver broke without the condition signal, so we return null rather than guess: the waveform
 * then shows the real trace with no marker, instead of a red line on an innocent cycle.
 *
 * (The previous version matched `_EN ... 0` — the cycles where the assertion was NOT checked — for
 * ANY assertion, not just this one. It was wrong in both directions.)
 */
function failStep(log: string, cell: string): number | null {
  const esc = cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(String.raw`^\s*(\d+)\s+\\?${esc}_EN\s+1\s`, 'gm');
  const enabled = [...log.matchAll(re)].map((m) => Number(m[1]));
  return enabled.length === 1 ? enabled[0] : null;
}

/**
 * The counterexample table, whole.
 *
 * Deliberately NOT truncated: this previously sliced to 60 lines, which kept only `init` and cycle
 * 1 and discarded the rest of the trace — i.e. most of the evidence, and everything a waveform
 * needs. The table is bounded by `-seq depth` anyway, so it cannot run away.
 */
function counterexampleLines(log: string): string[] {
  const i = log.search(/Signal Name\s+Dec\s+Hex\s+Bin|SAT proof finished - model found/);
  if (i === -1) return [];
  return log
    .slice(i)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

/** Row shape: `<time> <signal> <dec> <hex> <bin>`, where time is `init` or a cycle number. */
const TRACE_ROW = /^\s*(init|\d+)\s+(\S+)\s+(-?\d+|x+)\s+([0-9a-fx]+)\s+([01x]+)\s*$/i;

/**
 * Turn the SAT counterexample table into a waveform.
 *
 * Skips `$`-prefixed names: those are compiler internals ($auto$async2sync..., $assert$...$_EN)
 * that mean nothing to the engineer reading the trace.
 */
function parseTrace(lines: string[]): Waveform | null {
  const byName = new Map<string, WaveformSignal>();
  const cycles: Array<number | 'init'> = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const m = TRACE_ROW.exec(line);
    if (!m) continue;

    const time: number | 'init' = m[1] === 'init' ? 'init' : Number(m[1]);
    const rawName = m[2];
    if (rawName.startsWith('$')) continue;

    const key = String(time);
    if (!seen.has(key)) {
      seen.add(key);
      cycles.push(time);
    }

    const name = rawName.replace(/^\\/, '');
    let sig = byName.get(name);
    if (!sig) {
      sig = { name, width: m[5].length, isDut: name.includes('.'), values: [] };
      byName.set(name, sig);
    }
    sig.values.push({ cycle: time, dec: m[3], bin: m[5] });
  }

  if (byName.size === 0) return null;
  return {
    cycles,
    signals: [...byName.values()].sort((a, b) => Number(b.isDut) - Number(a.isDut) || a.name.localeCompare(b.name)),
    failedAtCycle: null,
    failedAssertion: null,
    src: null,
  };
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : `... (${s.length - n} chars trimmed)\n${s.slice(-n)}`;
}

// --- synthesis -----------------------------------------------------------------------------

interface StatJson {
  modules?: Record<string, { area?: number; sequential_area?: number }>;
  design?: {
    num_cells?: number;
    area?: number;
    sequential_area?: number;
    num_cells_by_type?: Record<string, number>;
  };
}

/** Yosys emits numbers as strings when -hierarchy is used; coerce defensively. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Bucket FPGA cells by name prefix.
 * We do this ourselves because `-tech` cannot be combined with `-json` (it emits invalid JSON),
 * and `-tech` never reports area anyway.
 */
function bucket(cells: Record<string, number>, target: Target): Record<string, number> {
  const b: Record<string, number> = {};
  const add = (k: string, n: number) => (b[k] = (b[k] ?? 0) + n);
  for (const [type, n] of Object.entries(cells)) {
    const t = type.toUpperCase().replace(/^\\/, '');
    if (target === 'artix7') {
      if (/^LUT[1-6]/.test(t)) add('LUT6', n);
      else if (/^(FD|DFF)/.test(t)) add('FF', n);
      else if (/^RAMB/.test(t)) add('BRAM36', n);
      else if (/^DSP48/.test(t)) add('DSP48', n);
      else if (/^(IBUF|OBUF|BUFG)/.test(t)) add('IO/Clock', n);
      else add('other', n);
    } else if (target === 'ecp5') {
      if (/^(LUT4|CCU2C)/.test(t)) add('LUT4', n);
      else if (/^TRELLIS_FF|^DFF/.test(t)) add('FF', n);
      else if (/^DP16KD|^PDPW16KD/.test(t)) add('BRAM', n);
      else if (/^MULT18/.test(t)) add('DSP', n);
      else add('other', n);
    } else {
      if (/^SB_LUT4/.test(t)) add('LUT4', n);
      else if (/^SB_DFF/.test(t)) add('FF', n);
      else if (/^SB_RAM/.test(t)) add('BRAM', n);
      else add('other', n);
    }
  }
  return b;
}

export async function synthesize(
  files: Record<string, string>,
  top: string,
  target: Target,
  onProgress?: (msg: string) => void,
): Promise<SynthesisResult> {
  const started = Date.now();
  const vfs: Record<string, string | Uint8Array> = { ...files };
  let script: string;

  if (target === 'sky130') {
    // Area comes ONLY from -liberty. dfflibmap MUST precede abc or FFs land in unknown_cell_area.
    onProgress?.('Synthesizing to sky130 standard cells...');
    vfs[LIB_NAME] = await sky130Lib();
    script = `
read_verilog -sv ${fileList(files)}
synth -top ${top}
dfflibmap -liberty ${LIB_NAME}
abc -liberty ${LIB_NAME}
opt_clean
stat -top ${top} -liberty ${LIB_NAME} -json
`;
  } else {
    const pass = target === 'artix7' ? 'synth_xilinx' : target === 'ecp5' ? 'synth_ecp5' : 'synth_ice40';
    onProgress?.(`Synthesizing with ${pass}...`);
    // No -tech here: -tech + -json emits invalid JSON. We bucket by prefix instead.
    script = `
read_verilog -sv ${fileList(files)}
${pass} -top ${top}
stat -top ${top} -json
`;
  }

  const r = await runYosysScript(script, vfs);
  const stat = extractLastJson(r.log) as StatJson | null;
  const design = stat?.design;
  const mod = stat?.modules?.[`\\${top}`] ?? stat?.modules?.[top];

  const cellsByType = design?.num_cells_by_type ?? {};
  const areaUm2 = target === 'sky130' ? num(design?.area) ?? num(mod?.area) : null;
  const seqArea =
    target === 'sky130' ? num(design?.sequential_area) ?? num(mod?.sequential_area) : null;

  const buckets = target === 'sky130' ? null : bucket(cellsByType, target);

  let utilization: SynthesisResult['utilization'] = null;
  if (target === 'artix7' && buckets) {
    const cap: Record<string, number> = {
      LUT6: ARTIX7_XC7A35T.lut6,
      FF: ARTIX7_XC7A35T.ff,
      BRAM36: ARTIX7_XC7A35T.bram36,
      DSP48: ARTIX7_XC7A35T.dsp48,
    };
    utilization = Object.entries(cap)
      .map(([resource, available]) => {
        const used = buckets[resource] ?? 0;
        return { resource, used, available, percent: round((used / available) * 100, 3) };
      })
      .filter((u) => u.used > 0 || u.resource === 'LUT6');
  }

  return {
    target,
    top,
    areaUm2,
    sequentialAreaUm2: seqArea,
    cellCount: num(design?.num_cells) ?? 0,
    cellsByType,
    buckets,
    utilization,
    log: tail(r.log, 4000),
    elapsedMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  };
}

// --- netlist graph -------------------------------------------------------------------------

interface JsonCellFull {
  type: string;
  port_directions?: Record<string, 'input' | 'output' | 'inout'>;
  connections?: Record<string, Array<number | string>>;
  attributes?: Record<string, string>;
}
interface JsonPortFull {
  direction: 'input' | 'output' | 'inout';
  bits: Array<number | string>;
}

const MAX_GRAPH_NODES = 400;

/** sky130_fd_sc_hd output pins. Liberty cells carry no port_directions in write_json output. */
const SKY130_OUTPUTS = new Set(['X', 'Y', 'Q', 'Q_N', 'CO', 'COUT', 'SUM', 'HI', 'LO', 'CO_N']);

/**
 * Port directions for a cell. Generic ($-prefixed) cells carry `port_directions`; mapped sky130
 * standard cells do NOT (Yosys leaves them to the liberty), so infer them from the pin name.
 */
function cellPortDirections(c: JsonCellFull): Record<string, 'input' | 'output' | 'inout'> {
  if (c.port_directions && Object.keys(c.port_directions).length) return c.port_directions;
  const out: Record<string, 'input' | 'output' | 'inout'> = {};
  for (const pn of Object.keys(c.connections ?? {})) {
    out[pn] = SKY130_OUTPUTS.has(pn) ? 'output' : 'input';
  }
  return out;
}

/**
 * Extract the design's netlist as a node/edge graph for visualisation.
 *
 * Nets in Yosys JSON are integer BIT IDS; two ports are connected when they share a bit. The
 * strings "0"/"1"/"x"/"z" are constants, not nets, and are ignored. A module INPUT port is a driver
 * into the design; a module OUTPUT port is a consumer.
 *
 * `level:'rtl'` gives ~10-30 generic cells ($add/$dff/$mux) — one node per RTL construct, readable.
 * `level:'gate'` gives the mapped sky130 standard cells (~100+).
 */
export async function netlistGraph(
  files: Record<string, string>,
  top: string,
  level: 'rtl' | 'gate',
): Promise<NetlistGraph> {
  const vfs: Record<string, string | Uint8Array> = { ...files };
  let script: string;
  if (level === 'gate') {
    vfs[LIB_NAME] = await sky130Lib();
    script = `
read_verilog -sv ${fileList(files)}
synth -top ${top}
dfflibmap -liberty ${LIB_NAME}
abc -liberty ${LIB_NAME}
opt_clean
write_json g.json
`;
  } else {
    script = `
read_verilog -sv ${fileList(files)}
hierarchy -check -top ${top}
proc
opt
write_json g.json
`;
  }

  const r = await runYosysScript(script, vfs);
  const raw = readTreeFile(r.files, 'g.json');
  if (!raw) return { top, level, nodes: [], edges: [], truncated: false };

  const design = JSON.parse(raw) as { modules?: Record<string, { ports?: Record<string, JsonPortFull>; cells?: Record<string, JsonCellFull> }> };
  const mod = design.modules?.[`\\${top}`] ?? design.modules?.[top] ?? Object.values(design.modules ?? {})[0];
  if (!mod) return { top, level, nodes: [], edges: [], truncated: false };

  const nodes: GraphNode[] = [];
  // driver[bit] = the single (node, port) that drives it; consumers[bit] = every input reading it.
  const drivers = new Map<number, { node: string; port: string }>();
  const consumers = new Map<number, Array<{ node: string; port: string }>>();
  const addConsumer = (bit: number, ref: { node: string; port: string }) => {
    const list = consumers.get(bit) ?? [];
    list.push(ref);
    consumers.set(bit, list);
  };
  const realBits = (arr: Array<number | string> = []) =>
    arr.filter((b): b is number => typeof b === 'number');

  // Module ports. An input port drives the design; an output port consumes.
  for (const [pn, p] of Object.entries(mod.ports ?? {})) {
    const id = `port:${clean(pn)}`;
    nodes.push({
      id,
      kind: 'port',
      type: p.direction,
      src: null,
      ports: [{ name: clean(pn), direction: p.direction, width: p.bits.length }],
    });
    for (const bit of realBits(p.bits)) {
      if (p.direction === 'input') drivers.set(bit, { node: id, port: clean(pn) });
      else addConsumer(bit, { node: id, port: clean(pn) });
    }
  }

  // Cells. Cap for readability — but say so rather than dropping silently.
  const cellEntries = Object.entries(mod.cells ?? {});
  const truncated = cellEntries.length > MAX_GRAPH_NODES;
  for (const [cn, c] of cellEntries.slice(0, MAX_GRAPH_NODES)) {
    const id = clean(cn);
    const dirs = cellPortDirections(c);
    const cellPorts = Object.entries(dirs).map(([pn, dir]) => ({
      name: pn,
      direction: dir,
      width: (c.connections?.[pn] ?? []).length,
    }));
    nodes.push({ id, kind: 'cell', type: c.type, src: c.attributes?.src ?? null, ports: cellPorts });

    for (const [pn, dir] of Object.entries(dirs)) {
      for (const bit of realBits(c.connections?.[pn])) {
        if (dir === 'output') drivers.set(bit, { node: id, port: pn });
        else addConsumer(bit, { node: id, port: pn });
      }
    }
  }

  // One edge per driver->consumer pair, width = shared bit count.
  const edgeMap = new Map<string, GraphEdge>();
  for (const [bit, cons] of consumers) {
    const drv = drivers.get(bit);
    if (!drv) continue;
    for (const con of cons) {
      if (drv.node === con.node) continue;
      const key = `${drv.node}.${drv.port}->${con.node}.${con.port}`;
      const existing = edgeMap.get(key);
      if (existing) existing.width++;
      else edgeMap.set(key, { id: key, from: drv, to: con, width: 1 });
    }
  }

  return { top, level, nodes, edges: [...edgeMap.values()], truncated };
}

// --- place & route -------------------------------------------------------------------------

/**
 * Real placement, routing and timing analysis via nextpnr.
 *
 * ECP5/iCE40 only. nextpnr upstream has no Xilinx support (that is openXC7, a separate project with
 * no WASM build), so Artix-7 Fmax is not obtainable here and must not be claimed.
 */
export async function placeAndRoute(
  files: Record<string, string>,
  top: string,
  target: 'ecp5' | 'ice40',
  device: string,
  targetMhz: number | null,
  onProgress?: (msg: string) => void,
): Promise<PnrResult> {
  const started = Date.now();

  onProgress?.(`Synthesizing for ${target}...`);
  const synthPass = target === 'ecp5' ? 'synth_ecp5' : 'synth_ice40';
  const s = await runYosysScript(
    `read_verilog -sv ${fileList(files)}\n${synthPass} -top ${top} -json netlist.json`,
    { ...files },
  );
  const netlist = readTreeFile(s.files, 'netlist.json');
  if (!s.ok || !netlist) {
    return {
      target,
      device,
      fmaxMhz: null,
      targetMhz,
      timingMet: null,
      utilization: [],
      log: tail(s.log, 4000),
      elapsedMs: Date.now() - started,
      ranAt: new Date().toISOString(),
    };
  }

  onProgress?.('Placing and routing with nextpnr...');
  const chunks: string[] = [];
  const dec = new TextDecoder();
  const sink = (b: Uint8Array | null) => {
    if (b) chunks.push(dec.decode(b));
  };

  const args =
    target === 'ecp5'
      ? ['--json', 'netlist.json', `--${device}`, '--textcfg', 'out.cfg', '--freq', String(targetMhz ?? 100)]
      : ['--json', 'netlist.json', `--${device}`, '--asc', 'out.asc', '--freq', String(targetMhz ?? 100)];

  let ok = false;
  try {
    const mod = (await import(
      target === 'ecp5' ? '@yowasp/nextpnr-ecp5' : '@yowasp/nextpnr-ice40'
    )) as unknown as Record<string, (a?: string[], f?: unknown, o?: unknown) => Promise<unknown>>;
    const run = mod.runNextpnrEcp5 ?? mod.runNextpnrIce40;
    await run(args, { 'netlist.json': netlist }, { stdout: sink, stderr: sink, decodeASCII: false });
    ok = true;
  } catch (e) {
    // Exit still carries the log, which is where Fmax lives.
    ok = false;
    if (!(e instanceof Error)) throw e;
  }

  const log = chunks.join('');
  return {
    target,
    device,
    fmaxMhz: parseFmax(log),
    targetMhz,
    timingMet: ok ? !/Max frequency .* FAIL|timing failed/i.test(log) : null,
    utilization: parseNextpnrUtil(log),
    log: tail(log, 4000),
    elapsedMs: Date.now() - started,
    ranAt: new Date().toISOString(),
  };
}

/** nextpnr: "Info: Max frequency for clock '<clk>': 123.45 MHz (PASS at 100.00 MHz)" */
function parseFmax(log: string): number | null {
  const m = [...log.matchAll(/Max frequency for clock\s+'[^']*':\s*([\d.]+)\s*MHz/g)];
  if (!m.length) return null;
  return Math.min(...m.map((x) => Number(x[1])));
}

/**
 * nextpnr: "Info:      TRELLIS_FF:    12/ 24288     0%"
 *
 * nextpnr lists every resource class the device has (~29 for ECP5), almost all zero. Reporting all
 * of them buries the two rows that matter, so unused classes are dropped.
 */
function parseNextpnrUtil(log: string): PnrResult['utilization'] {
  const out: PnrResult['utilization'] = [];
  for (const m of log.matchAll(/^\s*Info:\s+(\w+):\s+(\d+)\/\s*(\d+)\s+(\d+)%/gm)) {
    const used = Number(m[2]);
    const available = Number(m[3]);
    if (available > 0 && used > 0) {
      out.push({
        resource: m[1],
        used,
        available,
        percent: round((used / available) * 100, 3),
      });
    }
  }
  return out.sort((a, b) => b.percent - a.percent);
}

// --- cost ----------------------------------------------------------------------------------

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * Real sky130 cell area -> die area -> IHP MPW price.
 *
 * The TinyTapeout cross-check is deliberate: two independent sources landing on the same order of
 * magnitude is a stronger claim than either number alone.
 */
export function computeCost(areaUm2: number, utilization: number): CostResult {
  const dieMm2 = areaUm2 / 1e6 / utilization;
  const costEur = dieMm2 * IHP_EUR_PER_MM2;
  const tiles = Math.ceil(areaUm2 / TT_TILE_UM2);
  const ourPerTile = (TT_TILE_UM2 / 1e6) * IHP_EUR_PER_MM2;

  return {
    areaUm2: round(areaUm2, 3),
    utilization,
    dieMm2: round(dieMm2, 6),
    eurPerMm2: IHP_EUR_PER_MM2,
    costEur: round(costEur, 2),
    tiles,
    crossCheck: {
      ttTileCostEur: TT_TILE_PRICE_EUR,
      ourPerTileEur: round(ourPerTile, 2),
      ratio: round(ourPerTile / TT_TILE_PRICE_EUR, 2),
      note:
        `One TinyTapeout tile is ${TT_TILE_UM2} um^2 = ${TT_TILE_UM2 / 1e6} mm^2. At IHP's ` +
        `EUR ${IHP_EUR_PER_MM2}/mm^2 that is EUR ${round(ourPerTile, 2)}, versus TinyTapeout's ` +
        `~EUR ${TT_TILE_PRICE_EUR}/tile. Same order of magnitude; TT is cheaper because it amortizes ` +
        `one die across hundreds of projects, while this figure prices a dedicated MPW slot.`,
    },
    source:
      'Cell areas: sky130_fd_sc_hd__tt_025C_1v80.lib (vendored, 428 cells with real area attributes). ' +
      'Wafer price: IHP SG13G2 MPW, EUR 7,300/mm^2, 40 samples. ' +
      'NOTE: eFabless shut down in March 2025 — chipIgnite/MPW pricing is dead and must not be cited.',
    ranAt: new Date().toISOString(),
  };
}
