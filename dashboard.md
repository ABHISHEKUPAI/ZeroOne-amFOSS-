# Silicon Architect Dashboard — Build Guide for OpenCode

Build prompts for a **separate** dashboard repo. The dashboard is an **MCP client + OpenAI agent
loop**. It does not contain, import, or depend on the MCP server's source.

Everything an implementing agent needs is **in this file**. Every schema below was dumped from the
running server — copy them, do not infer them.

---

## CONTEXT — paste this into OpenCode first

> ### What I am building
> A Next.js dashboard for **Silicon Architect**, a hosted MCP server that designs digital hardware.
> The dashboard is an **MCP client**. It runs an **OpenAI tool-calling loop** against the server's
> tools and streams the whole thing to the browser over SSE.
>
> ### What the MCP server is
> It runs a real EDA toolchain — **Yosys 0.64** and **nextpnr**, compiled to WebAssembly, in-process.
> Given a Verilog design it will: elaborate it, **formally prove** its assertions by bounded model
> checking, synthesize it to real sky130 standard cells (real µm²), place-and-route it on an ECP5
> for a real achieved Fmax, and price the die. It contains **no LLM**. The intelligence is the
> client's — that is the whole point: *the model picks the next tool from what the last tool
> returned.*
>
> ### Endpoint
> `MCP_URL` = `https://silicon-arch-zeroone-amfoss-amrita-university-amritapuri-campus.app.nitrocloud.ai/mcp`
> Local alternative: `http://localhost:3000/mcp`. **No auth. No API key. No headers.**
>
> ### THE RULE THAT OVERRIDES EVERYTHING
> **Never render a number the toolchain did not produce.** This server's entire value is that it
> refuses to lie — it throws rather than estimate an area, it reports zero assertions as FAIL, it
> declines to give Artix-7 timing. A dashboard that invents a value destroys the product.
>
> Concretely, and these are not negotiable:
> - **There is no simulator.** The only waveform that exists is the **counterexample** from a FAILED
>   proof. `trace` is `null` when a proof succeeds. Never render a waveform for a passing design.
> - A stage that has not run renders the literal text **"not run"**. Never `0`, never `—`, never a
>   skeleton that implies pending data.
> - Never invent a progress percentage. Real elapsed milliseconds are returned by every tool.
> - Never recompute area/cost/Fmax in the browser. Call the tool.

---

## THE MCP WIRE PROTOCOL — exact, copy this

Streamable HTTP. Responses are **SSE frames**, even for ordinary calls. This trips people up:

```
POST <MCP_URL>
Headers: Content-Type: application/json
         Accept: application/json, text/event-stream
         Mcp-Session-Id: <from the initialize response header, on every call after the first>
Body:    {"jsonrpc":"2.0","id":1,"method":"...","params":{...}}

Response body looks like:
event: message
data: {"result":{...},"jsonrpc":"2.0","id":1}
```

**Handshake, in order:**
1. `initialize` → read the **`mcp-session-id` response header** and keep it.
2. `notifications/initialized` (no id, no response).
3. Any of: `tools/list`, `tools/call`, `resources/read`, `prompts/get`.

**Tool result shape:**
```jsonc
{ "content": [ { "type": "text", "text": "<JSON string>" } ],
  "structuredContent": { ... },   // present sometimes — prefer it
  "isError": true }               // tool threw; text is the message, NOT JSON
```
Rule: use `structuredContent` when present, else `JSON.parse(content[0].text)`, and if
`isError` is true treat `text` as a plain error string.

---

## THE 8 TOOLS — dumped from the live server

`*` = required. `=` = default.

```
search_ip(query*:string, limit?:integer =5)
write_rtl(spec*:string, files*:object, top*:string,
          target?:"sky130"|"ecp5"|"ice40"|"artix7" ="sky130",
          clock_mhz?:number|null =null, design_id?:string)
simulate(design_id*:string, testbench*:object, tb_top*:string, depth?:integer =12)
synthesize(design_id*:string, target?:"sky130"|"ecp5"|"ice40"|"artix7")
place_and_route(design_id*:string, target?:"ecp5"|"ice40" ="ecp5",
                device?:string ="25k", target_mhz?:number|null =null)
cost_sheet(design_id*:string, utilization?:number =0.6)
design_report(design_id?:string, kind?:"all"|"rtl"|"verification"|"synthesis"|"summary"|"cost" ="all")
list_designs()
```

`files` / `testbench` are `{ "<filename>.v": "<verilog source>" }`.

**Do not hardcode these into the OpenAI request.** Fetch `tools/list` and map — `inputSchema` is
already valid JSON Schema:

```ts
const tools = (await listTools()).map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));
```

### Resources
`silicon://targets` · `silicon://cost-model` · `silicon://toolchain` · `silicon://designs` ·
`silicon://design/{id}/report` (markdown) · `health://checks`

### Prompts
`design_chip(spec*, target?, clock_mhz?)` · `verify_design(design_id*, depth?)` ·
`cost_review(design_id*)`

---

## RESPONSE SHAPES — verified against real output

### `write_rtl`
```jsonc
{ "ok": true, "design_id": "design-1-h7bz3", "top": "uart_tx", "revision": 1,
  "modules": [ { "name": "uart_tx",
    "ports": [ { "name": "clk", "direction": "input", "width": 1 },
               { "name": "tx_data", "direction": "input", "width": 8 } ] } ],
  "lines": 34,
  "elaboration_log": "...",     // ONLY when ok:false
  "next_step": "Elaboration passed. Call simulate ...",
  "report": "## 1. RTL\n..." }
```
`ok:false` ⇒ the RTL does not compile. `elaboration_log` holds the Yosys error. This is **data, not
a crash** — the model reads it, fixes the RTL, and calls `write_rtl` again with the same `design_id`.

### `simulate` — the important one
```jsonc
{ "ok": false, "design_id": "design-1-h7bz3", "method": "bmc-sat", "depth": 10,
  "assertions": [
    { "cell": "a_idle_high", "src": "tb.v:5.19-5.51",   "status": "proved", "failedAtStep": null },
    { "cell": "a_start_low", "src": "tb.v:6.111-6.140", "status": "failed", "failedAtStep": 4 }
  ],
  "trace": {                      // <-- NULL WHEN ok:true. A proved design has NO counterexample.
    "cycles": ["init",1,2,3,4,5,6,7,8,9,10],
    "signals": [
      { "name": "dut.tx", "width": 1, "isDut": true,
        "values": [ { "cycle": "init", "dec": "0", "bin": "0" },
                    { "cycle": 1, "dec": "0", "bin": "0" },
                    { "cycle": 4, "dec": "1", "bin": "1" } ] },
      { "name": "dut.state", "width": 2, "isDut": true, "values": [ /* ... */ ] }
    ],
    "failedAtCycle": 4,           // may be null — see the note below
    "failedAssertion": "a_start_low",
    "src": "tb.v:6.111-6.140"
  },
  "counterexample": ["Time Signal Name ...", "..."],   // raw text; prefer `trace`
  "next_step": "Assertion(s) violated: a_start_low at tb.v:6.111-6.140. Read the counterexample, fix the RTL, ..."
}
```

**Facts you must respect:**
- `trace === null` when `ok === true`. **Not an error — there is no counterexample.**
- `failedAtCycle` **may be null** even on failure: it is only reported when the server can prove
  which cycle broke. Null ⇒ draw **no marker**. Do not fall back to a guess.
- Signal names are hierarchical: `dut.tx` is inside the DUT (`isDut:true`), `past_rst` is a
  testbench local. Group them.
- Names ending `_EN` (e.g. `a_start_low_EN`) are assertion **enables**: 1 on cycles where that
  assertion is checked. Useful as a marker lane.
- A signal may have **no value at some cycle**. Render a gap. Do not carry the last value forward.
- `assertions[].src` format is `file:line.col-line.col`. The line is the first number after `:`.

### `synthesize`
```jsonc
{ "ok": true, "target": "sky130", "cell_count": 101,
  "area_um2": 1049.7568, "sequential_area_um2": 660.6336,
  "buckets": null,               // sky130: null.  artix7: {"LUT6":20,"FF":33,"IO/Clock":14,"other":8}
  "utilization": null,           // artix7 only: [{resource,used,available,percent}]
  "fmax_mhz": null,              // ALWAYS null. Synthesis produces no timing.
  "fmax_note": "Stock Yosys cannot produce Artix-7 Fmax (synthesis only, no place-and-route)...",
  "next_step": "Area obtained. Call cost_sheet to price the die." }
```
`area_um2` is **only** non-null for `target:"sky130"`. Display `fmax_note` verbatim where a user
might expect a frequency — that refusal is a feature.

### `place_and_route`
```jsonc
{ "ok": true, "device": "ecp5:25k", "fmax_mhz": 220.02, "target_mhz": 100, "timing_met": true,
  "utilization": [ { "resource": "TRELLIS_FF", "used": 33, "available": 24288, "percent": 0.136 } ] }
```

### `cost_sheet`
```jsonc
{ "ok": true, "area_um2": 1049.757, "die_mm2": 0.00175, "cost_eur": 12.77,
  "tinytapeout_tiles": 1,
  "cross_check": { "ttTileCostEur": 70, "ourPerTileEur": 116.8, "ratio": 1.67, "note": "..." },
  "source": "Cell areas: sky130_fd_sc_hd__tt_025C_1v80.lib ..." }
```
Throws (`isError`) when no sky130 synthesis exists. **That refusal is correct — surface it, do not
paper over it.**

### `design_report`
```jsonc
{ "ok": true, "kind": "all",
  "report": "# Engineering Report ...",   // markdown, ~6800 chars for kind:"all"
  "design": { "spec": "...", "target": "sky130", "top": "uart_tx",
    "verified": true, "assertions": [ /* as above */ ],
    "area_um2": 1049.7568, "cell_count": 101, "utilization": null,
    "fmax_mhz": 220.02, "cost_eur": 12.77, "tiles": 1,
    "history": [ { "at": "2026-07-17T09:25:18Z", "tool": "write_rtl", "ok": true,
                   "summary": "rev 1: elaborated 1 module(s)" } ] } }
```
`design` is the dashboard's state object. **`history[]` is the stage rail, already recorded.**

---

## KNOWN-GOOD TEST DESIGN — use this verbatim to test

A UART whose start bit is inverted. `write_rtl` succeeds; `simulate` **fails** on `a_start_low`
and **proves** `a_idle_high`. Change `1'b1` to `1'b0` in the `START` state to fix it.

```verilog
// uart.v  — BROKEN: START drives tx HIGH; a UART start bit must be LOW.
module uart_tx #(parameter CLKS_PER_BIT = 4) (
  input clk, input rst, input tx_start, input [7:0] tx_data,
  output reg tx, output reg tx_busy);
  localparam IDLE=2'd0, START=2'd1, DATA=2'd2, STOP=2'd3;
  reg [1:0] state; reg [15:0] clk_cnt; reg [2:0] bit_idx; reg [7:0] shift;
  always @(posedge clk) begin
    if (rst) begin state<=IDLE; tx<=1'b1; tx_busy<=1'b0; clk_cnt<=0; bit_idx<=0; shift<=0;
    end else case (state)
      IDLE: begin tx<=1'b1; tx_busy<=1'b0; clk_cnt<=0; bit_idx<=0;
        if (tx_start) begin shift<=tx_data; tx_busy<=1'b1; state<=START; end end
      START: begin tx<=1'b1;   // BUG (fix: 1'b0)
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1; else begin clk_cnt<=0; state<=DATA; end end
      DATA: begin tx<=shift[bit_idx];
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1;
        else begin clk_cnt<=0; if (bit_idx<3'd7) bit_idx<=bit_idx+1'b1; else begin bit_idx<=0; state<=STOP; end end end
      STOP: begin tx<=1'b1;
        if (clk_cnt<CLKS_PER_BIT-1) clk_cnt<=clk_cnt+1'b1; else begin clk_cnt<=0; tx_busy<=1'b0; state<=IDLE; end end
      default: state<=IDLE;
    endcase end
endmodule
```
```verilog
// tb.v — testbench. NOTE: immediate assertions in an always block.
// Concurrent SVA (`assert property`) is a SYNTAX ERROR on this toolchain (no Verific).
module tb (input clk, input tx_start, input [7:0] tx_data);
  reg boot = 1'b0; wire rst = ~boot;          // BMC starts from an arbitrary state: drive reset.
  always @(posedge clk) boot <= 1'b1;
  wire tx, tx_busy;
  uart_tx dut (.clk(clk), .rst(rst), .tx_start(tx_start), .tx_data(tx_data), .tx(tx), .tx_busy(tx_busy));
  reg past_rst = 1'b0, past_busy = 1'b0, past2_busy = 1'b0;
  always @(posedge clk) begin past_rst <= rst; past_busy <= tx_busy; past2_busy <= past_busy; end
  always @(posedge clk) begin
    if (past_rst) a_idle_high: assert (tx == 1'b1);
    if (!past_rst && past_busy && !past2_busy) a_start_low: assert (tx == 1'b0);
  end
endmodule
```
Expected: `simulate` → `ok:false`, `a_start_low` failed @ `tb.v:6.111-6.140`, `failedAtCycle:4`,
`trace.cycles` = `["init",1..10]`, ~22 signals. Fixed → `ok:true`, `trace:null`.

---

## DESIGN BRIEF

Reference: **XOD IDE** (dark node graph, ported nodes, inspector) + **Code Composer Studio /
logic analyzer** (dense debug panels, waveform, decoded data table). *Serious EDA tooling; reads
clean.* Density comes from real cross-linked data, not chrome.

| | |
|---|---|
| Theme | Dark only. `--bg:#0d1117` `--panel:#161b22` `--panel-2:#1c2128` `--border:#30363d` |
| Text | `--fg:#e6edf3` `--fg-dim:#8b949e` `--fg-faint:#6e7681` |
| State | `--ok:#3fb950` `--fail:#f85149` `--run:#d29922` `--idle:#6e7681` `--accent:#58a6ff` |
| Type | UI: system sans. **All data: JetBrains Mono + `font-variant-numeric:tabular-nums`** |
| Colour | Greyscale carries structure. Colour carries **state only**. No gradients, no glass, no shadows |
| Motion | Only to show change. Never ambient |
| Scroll | The page body never scrolls. Panels scroll independently |

---

# PART 1 — Scaffold + design system

```
Create a Next.js 14 dashboard (TypeScript, App Router, no Tailwind, ESLint).

It is an MCP client for a hosted EDA server. Read the CONTEXT and DESIGN BRIEF above first.

- npx create-next-app@14 . --ts --app --no-tailwind --eslint
- deps: openai reactflow elkjs @monaco-editor/react zustand
- .env.local.example:
    OPENAI_API_KEY=sk-...
    MCP_URL=https://silicon-arch-zeroone-amfoss-amrita-university-amritapuri-campus.app.nitrocloud.ai/mcp
- app/globals.css: CSS variables from the DESIGN BRIEF table. No Tailwind, no UI library.
  html,body { background:var(--bg); color:var(--fg); margin:0; overflow:hidden }
  Add a .mono utility: font-family:'JetBrains Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums
- components/Panel.tsx    — titled panel. Header: 11px, uppercase, letter-spacing .06em, --fg-dim,
                            optional right-side status chip. Body: overflow:auto. 1px --border, radius 6.
- components/StatusDot.tsx— 6px dot, prop: 'ok'|'fail'|'running'|'idle' -> the state vars.
- components/NotRun.tsx   — renders the literal text "not run" in --fg-faint, optional `hint` prop
                            shown after it (e.g. "needs synthesize(sky130)").
                            EVERY panel uses this for absent data. NEVER render 0 or '—' instead.
- app/layout.tsx — full-viewport CSS grid, no page scroll:
    row 1 (40px): top bar — "Silicon Architect", MCP connection StatusDot, model name
    row 2 (1fr) : left 380px | center 1fr | right 420px, each independently scrollable
  Static placeholders in each region for now.

DO NOT: add Tailwind or a component library; use gradients/shadows/glass; use colour decoratively;
implement any panel yet.

ACCEPTANCE: npm run dev -> the 3-region shell renders, body does not scroll, regions scroll alone.
```

# PART 2 — MCP client

```
Add lib/mcp.ts — a Streamable HTTP MCP client. Server-side only (it is called from route handlers).
Follow "THE MCP WIRE PROTOCOL" above EXACTLY. Do not use an SDK; it is ~80 lines.

Requirements:
- POST JSON-RPC to process.env.MCP_URL with
    Accept: 'application/json, text/event-stream'
- Parse the SSE frame: take the line starting with 'data: ', JSON.parse the remainder.
  Responses are SSE EVEN FOR NORMAL CALLS. If you JSON.parse the whole body it will fail.
- On initialize, read the 'mcp-session-id' RESPONSE HEADER; send it as the Mcp-Session-Id header on
  every subsequent request. Then send notifications/initialized (no id, expect no response body).
- Throw on body.error with body.error.message.
- Export: initialize(), listTools(), callTool(name, args), readResource(uri), getPrompt(name, args)
- callTool() must normalise the result:
    if (r.structuredContent) return r.structuredContent
    const text = r.content?.find(c => c.type === 'text')?.text
    if (r.isError) return { isError: true, message: text }     // text is a plain string, not JSON
    try { return JSON.parse(text) } catch { return { _raw: text } }
- No auth. No API key. Do not add headers beyond those listed.

ACCEPTANCE: a scratch script calling initialize() then listTools() prints exactly 8 tools:
search_ip write_rtl simulate synthesize place_and_route cost_sheet design_report list_designs
```

# PART 3 — OpenAI agent loop + SSE

```
Add app/api/design/route.ts — POST { spec, target, clockMhz } -> SSE stream. Node runtime.

- const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })   // SERVER-SIDE ONLY.
  The key must never reach the browser.
- Build the tool list from MCP tools/list. inputSchema is ALREADY JSON Schema — pass it straight
  through as `parameters`. Do not rewrite or hand-copy the schemas.
- SYSTEM PROMPT: call getPrompt('design_chip', { spec, target, clock_mhz }) and use the returned
  message content VERBATIM. Do NOT write your own rules — the server's prompt already encodes them
  (no SVA, cost needs real area, no Artix-7 Fmax, zero assertions = FAIL). Duplicating them in the
  client is how they drift.
- Model 'gpt-4o'. Loop: chat.completions.create -> if tool_calls, run each via mcp.callTool,
  append {role:'tool', tool_call_id, content: JSON.stringify(result)}, repeat. Cap 24 iterations.
- Emit SSE lines `data: ${JSON.stringify(evt)}\n\n`:
    {type:'status',   text}
    {type:'tool_start', id, name, args}                  // BEFORE the call
    {type:'tool_end',   id, name, ok, elapsedMs, result} // AFTER; measure elapsedMs yourself
    {type:'stage', stage:'rtl'|'verify'|'synth'|'pnr'|'cost', state:'running'|'ok'|'fail'}
    {type:'done',  designId}
    {type:'error', message}
  stage mapping: write_rtl->rtl, simulate->verify, synthesize->synth, place_and_route->pnr,
  cost_sheet->cost. Other tools emit no stage event.
  ok for tool_end = result.ok === true && !result.isError.

Add lib/store.ts (zustand): consume the stream -> { toolCalls[], stages{}, design, designId }.

Add components/ToolStream.tsx — the live log, one row per call:
  StatusDot | tool name (mono) | elapsed ms (right, tabular) | <details> args + result JSON
This panel IS the product's thesis: the model choosing the next tool from the last result.

DO NOT: invent progress percentages; hide tool names behind friendly labels; summarise args into
prose; stop the loop on a tool error (an error is DATA — render the row red and continue).

ACCEPTANCE: "Design a UART transmitter for sky130 at 100MHz" streams real tool calls in order with
real elapsed ms. If the model ships a bug, a red simulate row appears, followed by another write_rtl.
```

# PART 4 — Waveform + analyzer  ← the most convincing panel

```
Add components/Waveform.tsx and components/AnalyzerTable.tsx.
Data: the `trace` field of a simulate result. RE-READ the `simulate` response shape above.

Waveform.tsx — inline SVG. No charting library.
- Left gutter 140px, sticky: signal names, mono 11px. Signals with isDut:true grouped under a "DUT"
  heading; the rest under "TB". Names ending _EN are assertion enables — put them in their own
  "ASSERTIONS" group at the top.
- Lanes: one row per signal, 22px tall, 48px per cycle, horizontally scrollable.
  * width===1 -> square wave: high = line at lane top, low = at lane bottom, vertical edge on change.
  * width>1  -> value bus: hexagon lozenge per cycle with the value centred in mono; render `dec`
    when width<=8 else hex. Only break the lozenge where the value CHANGES.
  * cycle "init" is the first column, labelled 'init', separated by a 1px --border rule.
  * A signal with no value at a cycle -> render a GAP. Never carry the previous value forward.
- failedAtCycle (when NOT null): full-height 2px --fail vertical line, with a chip at the top
  showing failedAssertion + src. When failedAtCycle IS null, draw NO marker — the server could not
  determine the cycle and a guess would be a lie.
- Cycle ruler on top. Hover a lane -> tooltip { cycle, dec, bin }.

EMPTY STATE — the important one. When trace === null and the design verified ok:
  render exactly:
    "✅ Proved over {depth} cycles — no counterexample exists."
    "Bounded model checking proves the assertions hold for all inputs over this bound. There is no
     trace to show because the solver could not find a violation."
  DO NOT render an empty grid, a skeleton, or any fabricated waveform. There is no simulator; a
  passing design has no trace. This is the single most important rule in the dashboard.

AnalyzerTable.tsx (right region) — columns: Assertion | Source | Result | Failing cycle
  from simulate.assertions[]. proved -> --ok dot; failed -> --fail dot. Failing cycle "—" when null.
  Clicking a failed row scrolls the waveform to failedAtStep.

ACCEPTANCE (use the KNOWN-GOOD TEST DESIGN):
  broken -> 11 columns (init..10), ~22 signals, red marker at cycle 4, "a_start_low tb.v:6.111" chip
  fixed  -> the "no counterexample exists" message. NOT a blank chart.
```

# PART 5 — RTL editor, stage rail, stats, cost

```
- components/RtlEditor.tsx (left) — @monaco-editor/react, readOnly, theme 'vs-dark',
  language 'verilog', fontFamily mono, minimap off. One tab per file from the write_rtl args
  (the dashboard already has them: they are the `files` you sent).
  When >1 revision exists, offer a DiffEditor between revisions — the repair loop's one-line fix is
  a strong demo beat.
- components/StageRail.tsx (top of right) — 5 stages: RTL, Verify, Synth, P&R, Cost.
  StatusDot + name + real elapsed ms once done; amber while running; --idle + <NotRun/> if never run.
  Drive from the 'stage' SSE events.
- components/Stats.tsx — tiles: Area (µm²), Cells, Fmax (MHz), Cost (€). Mono, tabular-nums.
  Absent -> <NotRun hint="needs synthesize(sky130)" /> etc. NEVER 0.
  Fmax comes ONLY from place_and_route. synthesize always returns fmax_mhz:null — if the user asks
  about Artix-7 timing, show `fmax_note` verbatim.
- components/CostPanel.tsx —
  * cost_eur, die_mm2, tinytapeout_tiles
  * utilization slider 0.5–0.7 -> RE-CALL cost_sheet (never recompute client-side) -> live update.
    Label it: "the softest input in this model; area is measured, €7,300/mm² is published".
  * cross_check as two horizontal bars: ourPerTileEur (116.8) vs ttTileCostEur (70), with the
    one-line reason. This visual IS the credibility argument — give it room.
- components/ReportView.tsx — design_report kind:'all' markdown, read-only, copy button.
  Use <pre> or a ~20-line renderer. Do not add a heavy markdown dependency.

DO NOT: recompute any number in the browser. The ONLY client-side computation allowed is the
utilization slider re-CALLING cost_sheet.

ACCEPTANCE: full run -> stage rail advances live; cost slider re-calls the tool and the figure
moves; every un-run stage shows "not run".
```

# PART 6 — Netlist graph (optional, best looks-per-hour)

```
REQUIRES a `netlist_graph` tool on the server. Run `tools/list` FIRST — if netlist_graph is absent,
SKIP THIS PART ENTIRELY and tell me. Do not fabricate a graph from the module port list.

If present, it returns { nodes:[{id,kind,type,src,ports:[{name,direction,width}]}],
                        edges:[{id,from:{node,port},to:{node,port},width}], truncated:boolean }

- components/NetlistGraph.tsx (center) with reactflow + elkjs.
- Custom node, XOD style — NOT the default reactflow node:
  body --panel-2, 1px --border, radius 4; title = cell type in mono 11px ('$add',
  'sky130_fd_sc_hd__dfxtp_1'); INPUT ports as 7px circles on the LEFT, OUTPUT ports on the RIGHT,
  each labelled; multi-bit ports show width as a small superscript. kind==='port' nodes render as
  --accent pills.
- Layout with elkjs 'layered', direction RIGHT, spacing.nodeNode 40. Positions come from elk ONLY —
  never hardcode coordinates.
- Edges bezier 1px --fg-faint; width>1 -> 2px.
- Click a node -> parse its `src` ('u.v:5.30-5.33' -> line 5) -> RtlEditor reveals that line.
  This cross-link is what makes it feel like a real tool.
- Hover -> highlight that node's edges, dim others to 25%.
- truncated:true -> a chip "showing first N of M nodes". Never silently drop.

ACCEPTANCE: readable left-to-right graph; ports on correct sides; clicking a node jumps the editor.
```

---

## Order & what to cut

| Part | Effort | Notes |
|---|---|---|
| 1 scaffold | 3h | everything sits on it |
| 2 mcp client | 2h | **do not skip the SSE framing** — the #1 thing that breaks |
| 3 agent loop | 4h | this IS "internal working in realtime" |
| 4 waveform | 4h | **the demo.** Keep even if everything else is cut |
| 5 editor/stats/cost | 4h | trim to Stats + StageRail if short |
| 6 netlist graph | 4h | optional; needs a server tool that may not exist yet |

**Cut order: 6 → 5 → 3.** Parts 2 and 4 are the product.

## Final checklist before you call it done

- [ ] A passing design shows **"no counterexample exists"**, not a blank chart
- [ ] Un-run stages show **"not run"**, never `0`
- [ ] `failedAtCycle: null` ⇒ **no** red marker
- [ ] Artix-7 shows `fmax_note`, never a MHz figure
- [ ] `cost_sheet` errors surface as errors, not as `€0`
- [ ] `OPENAI_API_KEY` never appears in a client bundle
- [ ] Every number on screen traces to a tool call in the ToolStream

---

# ADDENDUM — new server capabilities (2026-07-17)

Three server changes landed. Feed these to OpenCode as additional parts.

## New: `netlist_graph` tool (chip visualisation is now real)

The server exposes a **9th tool**. Verified shapes:

```
netlist_graph(design_id*:string, level?:"rtl"|"gate" ="rtl")
```
```jsonc
{ "ok": true, "top": "uart_tx", "level": "rtl",
  "node_count": 50, "edge_count": 105, "truncated": false,
  "nodes": [
    { "id": "$add$uart.v:8$3", "kind": "cell", "type": "$add",
      "src": "uart.v:8.30-8.33",
      "ports": [ { "name": "A", "direction": "input",  "width": 16 },
                 { "name": "Y", "direction": "output", "width": 16 } ] },
    { "id": "port:clk", "kind": "port", "type": "input", "src": null,
      "ports": [ { "name": "clk", "direction": "input", "width": 1 } ] }
  ],
  "edges": [
    { "id": "$add..Y->port:q.q", "from": { "node": "$add..", "port": "Y" },
      "to": { "node": "port:q", "port": "q" }, "width": 4 } ] }
```
Facts: `level:'rtl'` → ~10-50 readable generic cells (`$add`/`$dff`/`$mux`), `level:'gate'` → mapped
sky130 cells (100+). `kind:'port'` nodes are module ports. `src` is `null` for ports **and** for
Yosys-inserted cells (honest — those aren't clickable). Edges carry `width`. `truncated:true` when
capped at 400 nodes.

### PROMPT — netlist graph panel (this is DASHBOARD_BUILD Part 6, now unblocked)
```
Add components/NetlistGraph.tsx to the centre region. reactflow + elkjs (add both deps).
Data: call the MCP tool netlist_graph({design_id, level}). Shape is in the ADDENDUM above.

- Custom node (XOD-style), NOT reactflow's default:
    body var(--panel-2), 1px var(--border), radius 4; title = node.type in mono 11px;
    INPUT ports (direction 'input') as 7px circles on the LEFT, OUTPUT ports on the RIGHT, labelled;
    width>1 shown as a small superscript. kind==='port' nodes render as var(--accent) pills.
- Layout with elkjs 'layered', elk.direction 'RIGHT', spacing.nodeNode 40. Positions from elk ONLY.
- Edges bezier 1px var(--fg-faint); width>1 -> 2px.
- Click a node with a non-null src ('uart.v:8.30-8.33' -> line 8) -> RtlEditor reveals that line.
- Hover -> highlight that node's edges, dim others to 25%.
- A 'rtl | gate' toggle re-fetches with the other level.
- truncated:true -> chip "showing first 400 of N". Never silently drop.
- Empty state: <NotRun hint="run write_rtl first" />.

DO NOT invent nodes/ports/edges — render exactly what the tool returns. Positions from elk only.
ACCEPTANCE: UART rtl level -> readable left-to-right graph, ports on correct sides, clicking a
$add/$dff node jumps the editor to its line; toggling to gate shows sky130 cells.
```

## Changed: `simulate` now returns `compile_error`

When the testbench/design does not COMPILE (vs. a real assertion failure), the result carries a
clean one-line `compile_error` and `trace` is null. The 30KB Yosys AST dump is gone.

```jsonc
{ "ok": false, "compile_error": "tb.v:5: ERROR: Don't know how to detect sign and width ...",
  "trace": null, "assertions": [],
  "next_step": "The testbench did not compile: ... — this is a TESTBENCH bug, not a proof failure ..." }
```

### PROMPT — handle compile errors distinctly
```
In components/AnalyzerTable.tsx / the verify panel:
- If simulate result has compile_error (non-null): render a distinct "Did not compile" state —
  the compile_error string in a mono block, amber (var(--run)) not red, with the note
  "testbench bug, not a proof failure". Do NOT render the assertions table or waveform.
- This is DIFFERENT from a proof failure (assertions with status:'failed' + a trace) and from
  a proved pass (trace null, ok true -> "no counterexample exists"). Three distinct states.
```

## Feature: download reports

`design_report({kind:'all'})` already returns full markdown in `.report`. Pure client feature.

### PROMPT — download report
```
In components/ReportView.tsx add a "Download .md" button:
- const blob = new Blob([design.report ?? ''], {type:'text/markdown'})
- trigger a download named `${designId}-report.md` via a temporary <a download>.
Also add "Copy" (navigator.clipboard.writeText). Both no-ops (disabled) when no report yet.
Optional: a "Download .json" of the full design object (design_report's `design` field) for the
raw numbers.
```

## Reminder — the loop must feed results back

If write_rtl or simulate returns ok:false, that is the INPUT to self-correction, not a stop. The
agent loop (route.ts) MUST append the tool result and call the model again, up to the 24 cap. gpt-4o
writes weaker Verilog than Claude (undefined params, hierarchical refs into the DUT), so expect
2-4 repair rounds per design. Do not lower the iteration cap.
