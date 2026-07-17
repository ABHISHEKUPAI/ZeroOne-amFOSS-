/**
 * The design record.
 *
 * Every field here is written ONLY from real tool output. The report layer renders this record and
 * nothing else — if a stage never ran, its section says so rather than guessing. A fabricated
 * number in an engineering report is worse than a missing one.
 */

export type Target = 'sky130' | 'ecp5' | 'ice40' | 'artix7';

export interface RtlModule {
  name: string;
  ports: Array<{ name: string; direction: 'input' | 'output' | 'inout'; width: number }>;
}

export interface RtlArtifact {
  /** filename -> verilog source */
  files: Record<string, string>;
  top: string;
  /** parsed via Yosys hierarchy, not regex */
  modules: RtlModule[];
  lines: number;
  /** elaboration (read_verilog + hierarchy) succeeded */
  elaborated: boolean;
  elaborationLog: string;
  revision: number;
  updatedAt: string;
}

export interface AssertionResult {
  /** Yosys assert cell name, e.g. $assert$tb.v:5$5 */
  cell: string;
  /** parsed out of the cell name — file:line */
  src: string | null;
  status: 'proved' | 'failed';
  /** cycle at which the counterexample violates it (failures only) */
  failedAtStep: number | null;
}

export interface WaveformSignal {
  /** '\u.tx' -> 'u.tx' */
  name: string;
  /** bit width, from the Bin column */
  width: number;
  /** hierarchical name => lives inside the DUT rather than the testbench */
  isDut: boolean;
  values: Array<{ cycle: number | 'init'; dec: string; bin: string }>;
}

/**
 * A concrete execution, extracted from the SAT counterexample.
 *
 * This is NOT a simulation — there is no simulator. It is the trace the solver proved exists, in
 * which the design violates its assertion. It follows that a PROVED design has no waveform at all:
 * `trace` is null on success, and rendering anything there would be invention.
 */
export interface Waveform {
  cycles: Array<number | 'init'>;
  signals: WaveformSignal[];
  failedAtCycle: number | null;
  failedAssertion: string | null;
  /** file:line span of the violated assertion, e.g. 'tb.v:11.48-11.80' */
  src: string | null;
}

export interface VerificationResult {
  ok: boolean;
  method: 'bmc-sat';
  /** cycles of bounded proof */
  depth: number;
  top: string;
  assertions: AssertionResult[];
  /** counterexample trace lines (failures only) */
  counterexample: string[];
  /** structured form of the counterexample. NULL when the proof succeeds — no violation exists. */
  trace: Waveform | null;
  log: string;
  elapsedMs: number;
  ranAt: string;
}

export interface SynthesisResult {
  target: Target;
  top: string;
  /** sky130 only: real cell area in um^2 from stat -liberty */
  areaUm2: number | null;
  sequentialAreaUm2: number | null;
  cellCount: number;
  cellsByType: Record<string, number>;
  /** FPGA targets: bucketed by name prefix (never -tech with -json) */
  buckets: Record<string, number> | null;
  /** part-fit for artix7, from DS180 LUT6 counts */
  utilization: Array<{ resource: string; used: number; available: number; percent: number }> | null;
  log: string;
  elapsedMs: number;
  ranAt: string;
}

export interface PnrResult {
  target: 'ecp5' | 'ice40';
  device: string;
  /** achieved MHz from nextpnr timing analysis — the only real Fmax we can claim */
  fmaxMhz: number | null;
  targetMhz: number | null;
  timingMet: boolean | null;
  utilization: Array<{ resource: string; used: number; available: number; percent: number }>;
  log: string;
  elapsedMs: number;
  ranAt: string;
}

export interface CostResult {
  areaUm2: number;
  utilization: number;
  dieMm2: number;
  eurPerMm2: number;
  costEur: number;
  tiles: number;
  /** TinyTapeout cross-check — two independent sources agreeing is the demo */
  crossCheck: {
    ttTileCostEur: number;
    ourPerTileEur: number;
    ratio: number;
    note: string;
  };
  source: string;
  ranAt: string;
}

export interface IpCandidate {
  name: string;
  fullName: string;
  url: string;
  stars: number;
  description: string | null;
  license: string | null;
  updatedAt: string;
}

export interface HistoryEvent {
  at: string;
  tool: string;
  ok: boolean;
  summary: string;
}

export interface DesignSession {
  id: string;
  spec: string;
  target: Target;
  clockMhz: number | null;
  createdAt: string;
  rtl: RtlArtifact | null;
  verification: VerificationResult | null;
  synthesis: SynthesisResult | null;
  pnr: PnrResult | null;
  cost: CostResult | null;
  ip: IpCandidate[] | null;
  history: HistoryEvent[];
}

/** Artix-7 XC7A35T. LUT6 = 20800, NOT 5200 — the common tables report slices (off by 4x). DS180. */
export const ARTIX7_XC7A35T = {
  part: 'xc7a35t',
  lut6: 20800,
  ff: 41600,
  bram36: 50,
  dsp48: 90,
  source: 'Xilinx DS180 (7 Series Overview)',
} as const;

export const ECP5_25K = {
  device: '25k',
  lut4: 24288,
  ff: 24288,
} as const;

/** IHP SG13G2 MPW. eFabless shut down March 2025 — chipIgnite pricing is dead, do not cite it. */
export const IHP_EUR_PER_MM2 = 7300;
/** TinyTapeout tile: 160um x 100um = 16000 um^2 */
export const TT_TILE_UM2 = 16000;
export const TT_TILE_PRICE_EUR = 70;
