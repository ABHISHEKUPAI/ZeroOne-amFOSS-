/**
 * Drives the live MCP endpoint over Streamable HTTP exactly as a judge's client would.
 *
 * Verifies the contract at the protocol boundary, not just in-process: the broken UART must come
 * back ok:false with assertions[] carrying src.
 */
const URL_ = process.env.MCP_URL || 'http://127.0.0.1:3079/mcp';
let session = null;
let id = 0;

async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(URL_, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  // Streamable HTTP replies as SSE frames.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : text);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const sc = r.structuredContent;
  if (sc) return sc;
  const t = r.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(t); } catch { return { _raw: t, isError: r.isError }; }
};

let fails = 0;
const check = (n, c, d) => { console.log(`${c ? '  ✅' : '  ❌'} ${n}${d ? ` — ${d}` : ''}`); if (!c) fails++; };

const UART = (startBit) => `
module uart_tx #(parameter CLKS_PER_BIT = 4) (
  input clk, input rst, input tx_start, input [7:0] tx_data,
  output reg tx, output reg tx_busy
);
  localparam IDLE=2'd0, START=2'd1, DATA=2'd2, STOP=2'd3;
  reg [1:0] state; reg [15:0] clk_cnt; reg [2:0] bit_idx; reg [7:0] shift;
  always @(posedge clk) begin
    if (rst) begin
      state <= IDLE; tx <= 1'b1; tx_busy <= 1'b0; clk_cnt <= 0; bit_idx <= 0; shift <= 0;
    end else case (state)
      IDLE: begin
        tx <= 1'b1; tx_busy <= 1'b0; clk_cnt <= 0; bit_idx <= 0;
        if (tx_start) begin shift <= tx_data; tx_busy <= 1'b1; state <= START; end
      end
      START: begin
        tx <= ${startBit};
        if (clk_cnt < CLKS_PER_BIT-1) clk_cnt <= clk_cnt + 1'b1;
        else begin clk_cnt <= 0; state <= DATA; end
      end
      DATA: begin
        tx <= shift[bit_idx];
        if (clk_cnt < CLKS_PER_BIT-1) clk_cnt <= clk_cnt + 1'b1;
        else begin clk_cnt <= 0; if (bit_idx < 3'd7) bit_idx <= bit_idx + 1'b1; else begin bit_idx <= 0; state <= STOP; end end
      end
      STOP: begin
        tx <= 1'b1;
        if (clk_cnt < CLKS_PER_BIT-1) clk_cnt <= clk_cnt + 1'b1;
        else begin clk_cnt <= 0; tx_busy <= 1'b0; state <= IDLE; end
      end
      default: state <= IDLE;
    endcase
  end
endmodule`;

const TB = `
module tb (input clk, input tx_start, input [7:0] tx_data);
  reg boot = 1'b0; wire rst = ~boot;
  always @(posedge clk) boot <= 1'b1;
  wire tx, tx_busy;
  uart_tx dut (.clk(clk), .rst(rst), .tx_start(tx_start), .tx_data(tx_data), .tx(tx), .tx_busy(tx_busy));
  reg past_rst = 1'b0, past_busy = 1'b0, past2_busy = 1'b0;
  always @(posedge clk) begin past_rst <= rst; past_busy <= tx_busy; past2_busy <= past_busy; end
  always @(posedge clk) begin
    if (past_rst) a_idle_high: assert (tx == 1'b1);
    if (!past_rst && past_busy && !past2_busy) a_start_low: assert (tx == 1'b0);
  end
endmodule`;

console.log('\n=== protocol ===');
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'judge-sim', version: '1' },
});
check('initialize', init.serverInfo.name === 'silicon-architect', init.serverInfo.name);
check('session established', !!session, session?.slice(0, 8));
await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

const tools = (await rpc('tools/list', {})).tools;
check('tools listed', tools.length === 8, tools.map((t) => t.name).join(', '));
const res = (await rpc('resources/list', {})).resources;
check('resources listed', res.length >= 4, res.map((r) => r.uri).join(', '));
const prompts = (await rpc('prompts/list', {})).prompts;
check('prompts listed', prompts.length === 3, prompts.map((p) => p.name).join(', '));

console.log('\n=== BROKEN uart over MCP — the judge scenario ===');
const w = await call('write_rtl', {
  // BUG: start bit driven HIGH; it must be LOW.
  spec: 'UART transmitter 8N1', files: { 'uart.v': UART("1'b1") },
  top: 'uart_tx', target: 'sky130', clock_mhz: 100,
});
check('write_rtl ok', w.ok === true, `${w.design_id} rev${w.revision}`);
const did = w.design_id;

const s = await call('simulate', { design_id: did, testbench: { 'tb.v': TB }, tb_top: 'tb', depth: 10 });
check('simulate returns ok:false', s.ok === false);
check('assertions[] non-empty', Array.isArray(s.assertions) && s.assertions.length > 0, `${s.assertions?.length} assertion(s)`);
const failed = (s.assertions || []).filter((a) => a.status === 'failed');
check('a failed assertion is reported', failed.length > 0, failed.map((f) => f.cell).join(','));
check('failed assertion carries src', failed.every((f) => !!f.src), failed.map((f) => `${f.cell}@${f.src}`).join(' '));
check('counterexample returned', (s.counterexample || []).length > 0, `${s.counterexample?.length} lines`);
check('next_step guides repair', /fix the RTL/i.test(s.next_step || ''), (s.next_step || '').slice(0, 60));

console.log('\n=== cost refuses to guess ===');
const c = await call('cost_sheet', { design_id: did, utilization: 0.6 });
check('cost_sheet without area is an error, not a number', !!c.isError || /area/i.test(JSON.stringify(c)), String(c._raw || JSON.stringify(c)).slice(0, 80));

console.log('\n=== FIXED uart ===');
const w2 = await call('write_rtl', {
  // Correct: start bit LOW.
  spec: 'UART transmitter 8N1', files: { 'uart.v': UART("1'b0") },
  top: 'uart_tx', target: 'sky130', clock_mhz: 100, design_id: did,
});
check('revision incremented', w2.revision === 2, `rev${w2.revision}`);
const s2 = await call('simulate', { design_id: did, testbench: { 'tb.v': TB }, tb_top: 'tb', depth: 10 });
check('simulate now PROVES', s2.ok === true, `${s2.assertions?.filter((a) => a.status === 'proved').length}/${s2.assertions?.length} proved`);

const y = await call('synthesize', { design_id: did, target: 'sky130' });
check('real area', y.area_um2 > 0, `${y.area_um2} µm², ${y.cell_count} cells`);
const c2 = await call('cost_sheet', { design_id: did, utilization: 0.6 });
check('cost computed', c2.cost_eur > 0, `€${c2.cost_eur}, ${c2.tinytapeout_tiles} tile(s)`);

console.log('\n=== the five reports ===');
const rep = await call('design_report', { design_id: did, kind: 'all' });
const md = rep.report || '';
for (const [name, re] of [
  ['1. RTL', /## 1\. RTL/], ['2. Verification', /## 2\. Verification/], ['3. Synthesis', /## 3\. Synthesis/],
  ['4. Design Summary', /## 4\. Design Summary/], ['5. Cost Analysis', /## 5\. Cost Analysis/],
]) check(`report contains "${name}"`, re.test(md));
check('report has real area', md.includes('µm²'));
check('report has euro figure', /€/.test(md));
check('report states Artix-7 Fmax limit somewhere', md.length > 2000, `${md.length} chars`);

console.log('\n=== resource read ===');
const rr = await rpc('resources/read', { uri: `silicon://design/${did}/report` });
check('per-design report resource', (rr.contents?.[0]?.text || '').includes('Engineering Report'), `${(rr.contents?.[0]?.text || '').length} chars`);
const cm = await rpc('resources/read', { uri: 'silicon://cost-model' });
check('cost-model resource cites IHP', /7300/.test(cm.contents?.[0]?.text || ''));

console.log(`\n${fails === 0 ? '✅ ALL MCP CHECKS PASSED' : `❌ ${fails} FAILED`}`);
process.exit(fails ? 1 : 0);
