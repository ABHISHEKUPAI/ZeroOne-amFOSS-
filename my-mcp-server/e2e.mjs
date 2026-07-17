/**
 * End-to-end check of the real pipeline against the compiled server code.
 *
 * The assertion that matters: a deliberately BROKEN uart must come back ok:false with a non-empty
 * assertions[] carrying src. If that ever passes, the pass/fail signal is fake and the project's
 * central claim is false.
 */
import { elaborate, verifyDesign, synthesize, computeCost } from './dist/lib/eda.js';

const UART_GOOD = `
module uart_tx #(parameter CLKS_PER_BIT = 87) (
  input        clk,
  input        rst,
  input        tx_start,
  input  [7:0] tx_data,
  output reg   tx,
  output reg   tx_busy
);
  localparam IDLE = 2'd0, START = 2'd1, DATA = 2'd2, STOP = 2'd3;
  reg [1:0]  state;
  reg [15:0] clk_cnt;
  reg [2:0]  bit_idx;
  reg [7:0]  shift;

  always @(posedge clk) begin
    if (rst) begin
      state   <= IDLE;
      tx      <= 1'b1;      // UART idles HIGH
      tx_busy <= 1'b0;
      clk_cnt <= 16'd0;
      bit_idx <= 3'd0;
      shift   <= 8'd0;
    end else begin
      case (state)
        IDLE: begin
          tx      <= 1'b1;
          tx_busy <= 1'b0;
          clk_cnt <= 16'd0;
          bit_idx <= 3'd0;
          if (tx_start) begin
            shift   <= tx_data;
            tx_busy <= 1'b1;
            state   <= START;
          end
        end
        START: begin
          tx <= 1'b0;       // start bit is LOW
          if (clk_cnt < CLKS_PER_BIT - 1) clk_cnt <= clk_cnt + 1'b1;
          else begin clk_cnt <= 16'd0; state <= DATA; end
        end
        DATA: begin
          tx <= shift[bit_idx];
          if (clk_cnt < CLKS_PER_BIT - 1) clk_cnt <= clk_cnt + 1'b1;
          else begin
            clk_cnt <= 16'd0;
            if (bit_idx < 3'd7) bit_idx <= bit_idx + 1'b1;
            else begin bit_idx <= 3'd0; state <= STOP; end
          end
        end
        STOP: begin
          tx <= 1'b1;       // stop bit is HIGH
          if (clk_cnt < CLKS_PER_BIT - 1) clk_cnt <= clk_cnt + 1'b1;
          else begin clk_cnt <= 16'd0; tx_busy <= 1'b0; state <= IDLE; end
        end
        default: state <= IDLE;
      endcase
    end
  end
endmodule
`;

// The ONLY difference: the start bit is driven HIGH instead of LOW. A real, subtle protocol bug —
// the line never frames, so no receiver would ever sync.
const UART_BAD = UART_GOOD.replace('tx <= 1\'b0;       // start bit is LOW', 'tx <= 1\'b1;       // BUG: start bit must be LOW');

const TB = `
module tb (input clk, input tx_start, input [7:0] tx_data);
  // BMC starts from an ARBITRARY state, so reset must be driven, not assumed. Registers with an
  // initialiser carry an init attribute that the SAT solver constrains — that is what pins cycle 1.
  reg boot = 1'b0;
  wire rst = ~boot;
  always @(posedge clk) boot <= 1'b1;

  wire tx, tx_busy;
  uart_tx #(.CLKS_PER_BIT(4)) dut (
    .clk(clk), .rst(rst), .tx_start(tx_start), .tx_data(tx_data), .tx(tx), .tx_busy(tx_busy)
  );

  // Assert on PORTS ONLY. A hierarchical reference into the DUT (dut.state) aliases to a stale
  // copy once "flatten" runs, so the guard silently reads the wrong signal.
  // past_* start LOW: at cycle 1 reset has not been applied and the outputs are unconstrained,
  // so no check may fire until cycle 2.
  reg past_rst   = 1'b0;
  reg past_busy  = 1'b0;
  reg past2_busy = 1'b0;
  always @(posedge clk) begin
    past_rst   <= rst;
    past_busy  <= tx_busy;
    past2_busy <= past_busy;
  end

  // Immediate assertions in a clocked always block. Concurrent SVA (assert property) is a syntax
  // error in this Yosys build — no Verific.
  always @(posedge clk) begin
    // The cycle after reset, the line must idle HIGH.
    if (past_rst) a_idle_high: assert (tx == 1'b1);
    // tx is REGISTERED, so it lags the state by one cycle: one cycle after tx_busy RISES the
    // transmitter is driving the start bit, which must be LOW.
    if (!past_rst && past_busy && !past2_busy) a_start_low: assert (tx == 1'b0);
  end
endmodule
`;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

console.log('\n=== 1. elaborate (good UART) ===');
const el = await elaborate({ 'uart.v': UART_GOOD }, 'uart_tx');
check('elaborates', el.ok, el.ok ? `${el.artifact.modules.length} module(s)` : el.artifact.elaborationLog.slice(-300));
const ports = el.artifact.modules.find((m) => m.name === 'uart_tx')?.ports ?? [];
check('ports parsed', ports.length === 6, `${ports.length} ports: ${ports.map((p) => `${p.name}[${p.width}]`).join(' ')}`);

console.log('\n=== 2. elaborate (syntax error) — failure must be DATA, not a throw ===');
const bad = await elaborate({ 'x.v': 'module broken(input clk; endmodule' }, 'broken');
check('returns ok:false instead of throwing', bad.ok === false);
check('carries the error log', /ERROR|syntax/i.test(bad.artifact.elaborationLog));

console.log('\n=== 3. verify GOOD uart — must PROVE ===');
const vg = await verifyDesign({ 'uart.v': UART_GOOD, 'tb.v': TB }, 'tb', 10);
check('ok:true', vg.ok, `${vg.assertions.filter((a) => a.status === 'proved').length}/${vg.assertions.length} proved in ${vg.elapsedMs}ms`);
check('found both assertions', vg.assertions.length === 2, vg.assertions.map((a) => a.cell).join(', '));
if (!vg.ok) console.log(vg.log.slice(-1500));

console.log('\n=== 4. verify BROKEN uart — THE CRITICAL ASSERTION ===');
const vb = await verifyDesign({ 'uart.v': UART_BAD, 'tb.v': TB }, 'tb', 10);
check('ok:false', vb.ok === false);
check('assertions[] non-empty', vb.assertions.length > 0, `${vb.assertions.length} assertion(s)`);
const failed = vb.assertions.filter((a) => a.status === 'failed');
check('at least one assertion FAILED', failed.length > 0, failed.map((f) => f.cell).join(', '));
check('failed assertion carries src', failed.every((f) => !!f.src), failed.map((f) => `${f.cell}@${f.src}`).join(', '));
check('the START-bit assertion is the one that failed', failed.some((f) => f.cell.includes('start')), failed.map((f) => f.cell).join(', '));
check('the idle assertion still proves', vb.assertions.some((a) => a.cell.includes('idle') && a.status === 'proved'));
check('counterexample present', vb.counterexample.length > 0, `${vb.counterexample.length} trace lines`);

console.log('\n=== 5. verify with NO assertions — must NOT report pass ===');
const vn = await verifyDesign({ 'uart.v': UART_GOOD, 'tb2.v': "module tb2(input clk, input rst); wire t; uart_tx d(.clk(clk),.rst(rst),.tx_start(1'b0),.tx_data(8'd0),.tx(t),.tx_busy()); endmodule" }, 'tb2', 5);
check('vacuous proof reported as ok:false', vn.ok === false, vn.log.slice(0, 90));

console.log('\n=== 6. synthesize sky130 — real area ===');
const sy = await synthesize({ 'uart.v': UART_GOOD }, 'uart_tx', 'sky130');
check('area present', sy.areaUm2 != null && sy.areaUm2 > 0, `${sy.areaUm2} µm², ${sy.cellCount} cells, ${sy.elapsedMs}ms`);
check('sequential area present', sy.sequentialAreaUm2 != null && sy.sequentialAreaUm2 > 0, `${sy.sequentialAreaUm2} µm²`);
check('mapped to real sky130 cells', Object.keys(sy.cellsByType).some((c) => c.includes('sky130')), Object.keys(sy.cellsByType).slice(0, 3).join(', '));
check('no unknown_cell_area (dfflibmap ran before abc)', !/unknown_cell_area/.test(sy.log));

console.log('\n=== 7. synthesize artix7 — utilization, and NO Fmax claim ===');
const ax = await synthesize({ 'uart.v': UART_GOOD }, 'uart_tx', 'artix7');
check('buckets present', !!ax.buckets, JSON.stringify(ax.buckets));
const lut = ax.utilization?.find((u) => u.resource === 'LUT6');
check('LUT6 capacity is 20800 (not 5200)', lut?.available === 20800, `${lut?.used}/${lut?.available}`);
check('area is null for FPGA target', ax.areaUm2 === null);

console.log('\n=== 8. cost ===');
const cs = computeCost(sy.areaUm2, 0.6);
check('cost > 0', cs.costEur > 0, `€${cs.costEur} for ${cs.dieMm2.toExponential(2)} mm², ${cs.tiles} TT tile(s)`);
check('cross-check ~€117/tile', Math.abs(cs.crossCheck.ourPerTileEur - 116.8) < 1, `€${cs.crossCheck.ourPerTileEur}/tile vs TT €70`);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
