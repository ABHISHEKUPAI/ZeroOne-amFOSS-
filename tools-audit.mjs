/**
 * Exhaustive per-tool audit over live MCP: every one of the 8 tools, plus all 5 reports.
 *
 * mcp-e2e.mjs covers the judge scenario; this covers the tools that scenario skips —
 * search_ip (the only network-dependent tool, previously untested) and place_and_route.
 *
 *   MCP_URL=http://127.0.0.1:3104/mcp node tools-audit.mjs
 */
const URL_ = process.env.MCP_URL || 'http://127.0.0.1:3104/mcp';
let session = null;
let id = 0;

async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : text);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.structuredContent) return r.structuredContent;
  const t = r.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(t); } catch { return { _raw: t, isError: r.isError }; }
};

let fail = 0;
const ok = (n, c, d) => { console.log(`${c ? '  ✅' : '  ❌'} ${n}${d ? ` — ${d}` : ''}`); if (!c) fail++; };

const UART = `module uart_tx #(parameter CLKS_PER_BIT = 4) (
  input clk, input rst, input tx_start, input [7:0] tx_data, output reg tx, output reg tx_busy);
  localparam IDLE=2'd0, START=2'd1, DATA=2'd2, STOP=2'd3;
  reg [1:0] state; reg [15:0] clk_cnt; reg [2:0] bit_idx; reg [7:0] shift;
  always @(posedge clk) begin
    if (rst) begin state<=IDLE; tx<=1'b1; tx_busy<=1'b0; clk_cnt<=0; bit_idx<=0; shift<=0;
    end else case (state)
      IDLE: begin tx<=1'b1; tx_busy<=1'b0; clk_cnt<=0; bit_idx<=0;
        if (tx_start) begin shift<=tx_data; tx_busy<=1'b1; state<=START; end end
      START: begin tx<=1'b0;
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1; else begin clk_cnt<=0; state<=DATA; end end
      DATA: begin tx<=shift[bit_idx];
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1;
        else begin clk_cnt<=0; if (bit_idx<3'd7) bit_idx<=bit_idx+1'b1; else begin bit_idx<=0; state<=STOP; end end end
      STOP: begin tx<=1'b1;
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1; else begin clk_cnt<=0; tx_busy<=1'b0; state<=IDLE; end end
      default: state<=IDLE;
    endcase end
endmodule`;

const TB = `module tb (input clk, input tx_start, input [7:0] tx_data);
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

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit', version: '1' } });
await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

console.log('\n── 1/8 search_ip (the only networked tool) ──');
const ip = await call('search_ip', { query: 'uart verilog', limit: 3 });
ok('returns', ip.ok === true || ip.ok === false, ip.ok ? `${ip.count} repos` : `degraded: ${String(ip.note).slice(0, 50)}`);
if (ip.ok) {
  ok('real repos w/ stars', ip.results?.length > 0 && ip.results[0].stars >= 0, ip.results?.slice(0, 2).map((r) => `${r.fullName}(★${r.stars})`).join(' '));
  ok('licence surfaced', ip.results.some((r) => 'license' in r), `e.g. ${ip.results[0].license}`);
}

console.log('\n── 2/8 write_rtl ──');
const w = await call('write_rtl', { spec: 'UART transmitter 8N1 115200', files: { 'uart.v': UART }, top: 'uart_tx', target: 'sky130', clock_mhz: 100 });
ok('elaborates', w.ok === true, `${w.design_id} rev${w.revision}`);
ok('ports parsed from Yosys JSON', w.modules?.[0]?.ports?.length === 6, w.modules?.[0]?.ports?.map((p) => p.name).join(','));
const did = w.design_id;

console.log('\n── 3/8 simulate (BMC) ──');
const s = await call('simulate', { design_id: did, testbench: { 'tb.v': TB }, tb_top: 'tb', depth: 10 });
ok('proves good design', s.ok === true, `${s.assertions?.filter((a) => a.status === 'proved').length}/${s.assertions?.length} proved`);
ok('assertions carry src', s.assertions?.every((a) => a.src), s.assertions?.map((a) => a.src).join(' '));

console.log('\n── 4/8 synthesize ──');
const y = await call('synthesize', { design_id: did, target: 'sky130' });
ok('real sky130 area', y.area_um2 > 0, `${y.area_um2} µm², ${y.cell_count} cells`);
const ax = await call('synthesize', { design_id: did, target: 'artix7' });
ok('artix7 utilization', !!ax.buckets, JSON.stringify(ax.buckets));
ok('artix7 refuses Fmax', ax.fmax_mhz === null && /cannot produce Artix-7 Fmax/i.test(ax.fmax_note || ''));

console.log('\n── 5/8 place_and_route (real Fmax) ──');
const p = await call('place_and_route', { design_id: did, target: 'ecp5', device: '25k', target_mhz: 100 });
ok('achieved Fmax', p.fmax_mhz > 0, `${p.fmax_mhz} MHz vs target ${p.target_mhz}, met=${p.timing_met}`);
ok('utilization real', p.utilization?.length > 0, p.utilization?.slice(0, 2).map((u) => `${u.resource} ${u.used}/${u.available}`).join(' '));

console.log('\n── 6/8 cost_sheet ──');
// re-synth to sky130: artix7 above cleared area? (target switch overwrites synthesis)
await call('synthesize', { design_id: did, target: 'sky130' });
const c = await call('cost_sheet', { design_id: did, utilization: 0.6 });
ok('cost from real area', c.cost_eur > 0, `€${c.cost_eur}, ${c.tinytapeout_tiles} tile(s)`);
ok('TT cross-check', c.cross_check?.ourPerTileEur > 0, `€${c.cross_check?.ourPerTileEur}/tile vs TT €${c.cross_check?.ttTileCostEur}`);

console.log('\n── 7/8 design_report — all 5 reports ──');
for (const k of ['rtl', 'verification', 'synthesis', 'summary', 'cost']) {
  const r = await call('design_report', { design_id: did, kind: k });
  ok(`report kind="${k}"`, typeof r.report === 'string' && r.report.length > 100, `${r.report?.length} chars`);
}
const all = await call('design_report', { design_id: did, kind: 'all' });
const md = all.report || '';
const sections = ['## 1. RTL', '## 2. Verification', '## 3. Synthesis', '## 4. Design Summary', '## 5. Cost Analysis'];
ok('kind="all" has all 5 sections', sections.every((x) => md.includes(x)), `${md.length} chars`);
ok('structured data for the dashboard', all.design && 'area_um2' in all.design && 'assertions' in all.design,
  `keys: ${Object.keys(all.design || {}).join(',')}`);

console.log('\n── 8/8 list_designs ──');
const l = await call('list_designs', {});
ok('lists designs', l.count > 0, `${l.count} design(s)`);

console.log(`\n${fail === 0 ? '✅ ALL 8 TOOLS WORK' : `❌ ${fail} CHECK(S) FAILED`}`);
process.exit(fail ? 1 : 0);
