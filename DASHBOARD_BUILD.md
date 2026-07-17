# Dashboard Build — Parts & Prompts

Each part is **self-contained**: exact files, exact types, acceptance criteria, and a copy-paste
prompt. Run them **in order**. Do not start a part before its predecessor's acceptance passes.

The prompts are written to be *boring and literal* on purpose. Every type below was verified against
real tool output — an agent implementing these must **copy the shapes, not invent them**.

---

## Design brief

Reference: **XOD IDE** (dark node graph, ported nodes, inspector, project tree) + **Code Composer
Studio / logic analyzer** (dense debug panels, waveform, decoded data table).

The goal: *looks like serious EDA tooling, reads clean.* Density is earned by hierarchy, not by
cramming. Concretely:

| Property | Rule |
|---|---|
| Theme | Dark only. `#0d1117` canvas, `#161b22` panels, `#30363d` borders |
| Type | UI: Inter/system. **All data: JetBrains Mono, tabular-nums.** Signals, values, cell names, µm², MHz |
| Colour | Greyscale carries structure. Colour carries **state only**: green=proved, red=failed, amber=running, grey=not run. No decorative colour, no gradients, no glass |
| Density | Panels are resizable, scroll independently, and never scroll the page body |
| Motion | Only to show *change* (a stage flipping state). Never ambient |
| Empty states | A stage that has not run says **"not run"** in grey. Never a 0, never a dash, never a skeleton implying data |

**The aesthetic comes from real density** — 18 netlist nodes with real ports, a real 10-cycle trace,
101 real cells. Not from chrome.

---

## The data contract — read before any part

> **This UI must never render a number the toolchain did not produce.** That property is the entire
> project. A fabricated waveform is worse than no waveform.

**Real, available today:**

| Data | Source | Shape |
|---|---|---|
| Module ports | `write_rtl` → `modules[].ports[]` | `{name, direction, width}` |
| Netlist cells + nets | Yosys `write_json` | `cells{type, port_directions, connections, attributes.src}` |
| Assertions | `simulate` → `assertions[]` | `{cell, src, status, failedAtStep}` |
| **Counterexample trace** | `simulate` → SAT `-show-all` | `Time | Signal | Dec | Hex | Bin` per cycle |
| Area / cells | `synthesize` | `area_um2`, `cellsByType` |
| Fmax / utilization | `place_and_route` | `fmax_mhz`, `utilization[]` |
| Cost | `cost_sheet` | `cost_eur`, `cross_check` |
| Stage history | any tool | `history[] {at, tool, ok, summary}` |
| Timings | every tool | `elapsedMs` (real) |

**Forbidden — there is no simulator:**

- ❌ A waveform for a **passing** design. No counterexample exists. Show *"Proved over N cycles — no counterexample exists"*.
- ❌ `$display` output. Not captured.
- ❌ Artix-7 Fmax. Show the refusal text the server returns.
- ❌ Power. Not computed.
- ❌ Invented progress percentages. Use real `elapsedMs` and the real `updateProgress` strings.

---

## PART 0 — Full trace capture + parser (server) · ~2h · **blocks Parts 5**

### Goal
`simulate` returns a structured waveform. Also fixes a real bug: `counterexampleLines()` in
`src/lib/eda.ts` slices to 60 lines, so **most of the trace is currently thrown away**.

### Verified raw format
```
  Time Signal Name                    Dec       Hex       Bin
  ---- -------------------------- -------- --------- ---------
  init \u.st                             2         2        10
     1 \u.tx                             0         0         0
```

### Files
- `src/lib/types.ts` — add types
- `src/lib/eda.ts` — remove the 60-line cap; add `parseTrace()`; populate `VerificationResult.trace`
- `src/modules/silicon/silicon.tools.ts` — return `trace` from `simulate`

### PROMPT
```
In /home/saharsh-baiju/nitrostack, add a structured waveform to the verification result.

1. src/lib/types.ts — add exactly:

export interface WaveformSignal {
  name: string;        // '\u.tx' -> 'u.tx' (strip one leading backslash)
  width: number;       // length of the Bin column
  isDut: boolean;      // name contains '.' (hierarchical => inside the DUT)
  values: Array<{ cycle: number | 'init'; dec: string; bin: string }>;
}
export interface Waveform {
  cycles: Array<number | 'init'>;   // in order, 'init' first if present
  signals: WaveformSignal[];
  failedAtCycle: number | null;
  failedAssertion: string | null;   // e.g. 'a_start_low'
  src: string | null;               // e.g. 'tb.v:11.48-11.80'
}
Add `trace: Waveform | null;` to VerificationResult.

2. src/lib/eda.ts
   - In counterexampleLines(): REMOVE the `.slice(0, 60)` cap. Keep the whole table.
     Explain in a comment that truncating discards most of the trace.
   - Add parseTrace(lines: string[]): Waveform | null
     * Match rows with: /^\s*(init|\d+)\s+(\S+)\s+(-?\d+|x+)\s+([0-9a-fx]+)\s+([01x]+)\s*$/i
       groups: 1=time 2=name 3=dec 5=bin
     * SKIP any name starting with '$' (compiler internals: $auto$*, $assert$*).
     * Strip ONE leading backslash from the name.
     * width = bin.length ; isDut = name.includes('.')
     * cycles = unique times in first-seen order.
     * Return null if no rows matched.
   - In verifyDesign(): set trace = parseTrace(all.log split by '\n') on the FAILURE path only.
     Set failedAssertion/src from the first assertion whose status === 'failed'.
     failedAtCycle = that assertion's failedAtStep.
     On the success path trace stays null — a proved design HAS no counterexample. Do not invent one.

3. silicon.tools.ts — simulate() returns `trace: result.trace` alongside `assertions`.
   In the tool description add: "trace is non-null ONLY when a proof fails; a proved design has no
   counterexample."

CONSTRAINTS
- Do not change any Yosys script or pass ordering. Read CLAUDE.md first.
- Do not add dependencies.
- Do not touch the success path's behaviour.

ACCEPTANCE — must print a trace with >2 cycles and real signals (u.tx, u.st):
  npm run build && npm run verify
  node -e "
  import('./dist/lib/eda.js').then(async ({verifyDesign}) => {
    // reuse the BROKEN uart + TB from e2e.mjs (start bit 1'b1)
  })"
Then: npm run verify:tools   (all 8 tools must still pass)
```

---

## PART 1 — Netlist graph (server) · ~3h · **blocks Part 4**

### Goal
A real cell-level graph with source cross-links. Verified shape from `write_json`:

```json
"cells": { "$add$u.v:5$3": {
  "type": "$add",
  "port_directions": { "A": "input", "B": "input", "Y": "output" },
  "connections": { "A": [15,16,...], "B": ["1","0",...], "Y": [31,32,...] },
  "attributes": { "src": "u.v:5.30-5.33" } } },
"ports": { "clk": { "direction": "input", "bits": [2] } }
```
Nets are **bit ids**; two ports connect when they share a bit. Constants are the strings `"0"`/`"1"`.

### Files
- `src/lib/types.ts`, `src/lib/eda.ts` (new `netlistGraph()`), new tool in `silicon.tools.ts`

### PROMPT
```
In /home/saharsh-baiju/nitrostack, expose the netlist as a graph.

1. src/lib/types.ts — add exactly:

export interface GraphNode {
  id: string;          // cell name, or 'port:<name>'
  kind: 'cell' | 'port';
  type: string;        // '$add' | '$dff' | 'sky130_fd_sc_hd__dfxtp_1' | 'input' | 'output'
  src: string | null;  // 'u.v:5.30-5.33' -> click-to-source
  ports: Array<{ name: string; direction: 'input' | 'output' | 'inout'; width: number }>;
}
export interface GraphEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
  width: number;
}
export interface NetlistGraph {
  top: string;
  level: 'rtl' | 'gate';
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;   // true if node count was capped
}

2. src/lib/eda.ts — add:
   export async function netlistGraph(files, top, level: 'rtl'|'gate'): Promise<NetlistGraph>
   - level 'rtl'  script: read_verilog -sv <files> / hierarchy -check -top <top> / proc / opt / write_json g.json
   - level 'gate' script: read_verilog -sv <files> / synth -top <top> / dfflibmap -liberty sky130.lib /
                          abc -liberty sky130.lib / opt_clean / write_json g.json
     (pass sky130Lib() into the VFS as LIB_NAME, exactly like synthesize() already does)
   - Build nodes: one per cell (kind 'cell'), one per module port (kind 'port', id 'port:<name>').
     ports[] from port_directions; width = connections[port].length.
   - Build edges by shared bit id:
     * driver = the (node, port) whose direction is 'output' and whose bits contain the id.
       A module INPUT port drives into the design (treat 'input' ports as drivers).
     * consumers = every (node, port) with direction 'input' containing that id.
       A module OUTPUT port is a consumer.
     * IGNORE bits that are the strings "0"/"1"/"x"/"z" (constants, not nets).
     * One edge per driver->consumer pair. width = number of shared bits.
   - Cap at 400 nodes: if exceeded, keep the first 400 and set truncated=true. Never silently drop.

3. silicon.tools.ts — new tool `netlist_graph`:
   inputSchema: { design_id: z.string(), level: z.enum(['rtl','gate']).default('rtl') }
   description: "Return the design's netlist as a node/edge graph for visualisation. level 'rtl'
   gives ~10-30 generic cells ($add/$dff/$mux) — readable, one node per RTL construct. level 'gate'
   gives the mapped sky130 standard cells (~100+). Every node carries `src` (file:line) for
   click-to-source."
   annotations: { readOnlyHint: true }
   taskSupport: 'optional'
   Return raw object: { ok: true, design_id, ...graph }
   Requires session.rtl?.elaborated, else throw the same style of error as synthesize().

CONSTRAINTS
- Do NOT combine -tech with -json anywhere (emits invalid JSON). See CLAUDE.md.
- Do NOT add dependencies.
- Reuse runYosysScript / sky130Lib / readTreeFile from lib/yosys.js. Do not import @yowasp/yosys.

ACCEPTANCE
  npm run build && npm run verify:tools
  # then, for the UART: level 'rtl' must return >5 nodes, >5 edges, and every cell node must have a
  # non-null src. Assert this in a scratch script before finishing.
```

---

## PART 2 — Dashboard scaffold + design system · ~3h

### PROMPT
```
Create a Next.js 14 dashboard at /home/saharsh-baiju/nitrostack/dashboard.
It is a SEPARATE app. The MCP server must never depend on it.

- npx create-next-app@14 dashboard --ts --app --no-tailwind --eslint
- Add deps: openai, @modelcontextprotocol/sdk, reactflow, elkjs, monaco-editor,
  @monaco-editor/react, zustand
- dashboard/.env.local.example:
    OPENAI_API_KEY=sk-...
    MCP_URL=http://localhost:3000/mcp
- dashboard/app/globals.css — CSS variables ONLY (no Tailwind):
    --bg:#0d1117; --panel:#161b22; --panel-2:#1c2128; --border:#30363d;
    --fg:#e6edf3; --fg-dim:#8b949e; --fg-faint:#6e7681;
    --ok:#3fb950; --fail:#f85149; --run:#d29922; --idle:#6e7681; --accent:#58a6ff;
    --mono:'JetBrains Mono',ui-monospace,monospace;
  Global: html,body{background:var(--bg);color:var(--fg);margin:0;overflow:hidden}
  All numeric/data text: font-family:var(--mono); font-variant-numeric:tabular-nums.
- dashboard/components/Panel.tsx — titled panel: header (11px uppercase, letter-spacing .06em,
  --fg-dim), optional right-side status chip, body with overflow:auto. Border 1px --border, radius 6.
- dashboard/components/StatusDot.tsx — 6px dot: ok|fail|running|idle -> the vars above.
- dashboard/components/NotRun.tsx — renders the literal text "not run" in --fg-faint, 400 weight.
  EVERY panel uses this for absent data. Never render 0 or '-' for a stage that did not run.
- dashboard/app/layout.tsx — full-viewport CSS grid shell, no page scroll:
    row1 (40px): top bar — app name, MCP connection dot, model name
    row2 (1fr):  left 380px | center 1fr | right 420px, each independently scrollable
  Put static placeholders in each region for now.

CONSTRAINTS
- Dark theme only. No Tailwind. No component library. No gradients/shadows/glass.
- Colour ONLY for state (ok/fail/running/idle) + one accent. Structure is greyscale.
- Do not implement panels yet. This part is the shell only.

ACCEPTANCE
  cd dashboard && npm run dev  -> http://localhost:3001 renders the 3-region shell,
  page body does NOT scroll, regions scroll independently.
```

---

## PART 3 — Realtime agent loop (SSE + OpenAI) · ~4h · **the "internal working, live" part**

### Why SSE server-side
There are **no MCP progress notifications** (only `notifications/tasks/status`). Running the loop in
a route handler and streaming our own events sidesteps that entirely, and every event is real.

### PROMPT
```
In /home/saharsh-baiju/nitrostack/dashboard, add the agent loop.

1. lib/mcp.ts — minimal Streamable HTTP MCP client (no SDK transport needed):
   - POST JSON-RPC to process.env.MCP_URL, Accept: 'application/json, text/event-stream'
   - Responses are SSE frames: take the line starting with 'data: ' and JSON.parse the rest
   - Capture the 'mcp-session-id' response header on initialize; send it on every later call
   - Send notifications/initialized after initialize
   - export: initialize(), listTools(), callTool(name, args), readResource(uri), getPrompt(name,args)

2. app/api/design/route.ts — POST { spec, target, clockMhz }, returns a ReadableStream (SSE).
   - const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
   - Map MCP tools -> OpenAI functions 1:1 (inputSchema is ALREADY JSON Schema, pass it through):
       { type:'function', function:{ name:t.name, description:t.description, parameters:t.inputSchema } }
   - System prompt: fetch the server's own prompt via getPrompt('design_chip', {spec, target,
     clock_mhz}) and use its message content VERBATIM. Do not write your own rules — the server's
     prompt already encodes them (no SVA, cost needs real area, no Artix-7 Fmax, zero assertions = fail).
   - Model: 'gpt-4o'. Loop: create -> if tool_calls, call each via MCP, append results, repeat.
     Cap at 24 iterations.
   - Emit SSE events (JSON per line, `data: {...}\n\n`), each with a real timestamp:
       {type:'status', text}                                  // model prose
       {type:'tool_start', id, name, args}                    // BEFORE the MCP call
       {type:'tool_end', id, name, ok, elapsedMs, result}     // AFTER; elapsedMs measured here
       {type:'stage', stage:'rtl'|'verify'|'synth'|'pnr'|'cost', state:'running'|'ok'|'fail'}
       {type:'done', designId}
       {type:'error', message}
     Derive `stage` from the tool name: write_rtl->rtl, simulate->verify, synthesize->synth,
     place_and_route->pnr, cost_sheet->cost.

3. lib/store.ts (zustand) — consume the stream: tool call log, per-stage state, latest design object.

4. components/ToolStream.tsx — the live log. For each call show:
     status dot | tool name (mono) | elapsed ms (real, right-aligned, tabular)
     collapsed args + result JSON (<details>)
   This panel IS the product's thesis — the model choosing the next tool from the last result.
   Show the real tool name and real arguments. Do not summarise them into prose.

CONSTRAINTS
- NEVER invent a progress percentage. Show elapsed ms (real) and a running dot.
- NEVER hide the tool names behind a friendly label.
- Errors are DATA: an isError result renders red in the log; the loop continues.
- The OpenAI key is server-side only. It must never reach the browser.

ACCEPTANCE
  Ask "Design a UART transmitter for sky130 at 100MHz" -> the log streams real tool calls in order,
  each with real elapsed ms, and the stage rail advances. If the model ships a bug, the failed
  simulate appears red and a second write_rtl follows it.
```

---

## PART 4 — Netlist graph panel (the XOD look) · ~4h

### PROMPT
```
In /home/saharsh-baiju/nitrostack/dashboard, add the netlist graph (centre region).

- components/NetlistGraph.tsx using reactflow + elkjs.
- Data: call the MCP tool `netlist_graph` (Part 1) -> { nodes, edges, truncated }.
- Custom node (XOD-style), NOT the default reactflow node:
    * body: --panel-2, 1px --border, radius 4
    * title row: cell type in mono, 11px ('$add', 'sky130_fd_sc_hd__dfxtp_1')
    * input ports on the LEFT, output ports on the RIGHT, as 7px circles with labels
    * multi-bit ports show width as a small superscript (e.g. [8])
    * kind==='port' nodes render differently: pill-shaped, --accent border
- Layout with elkjs: 'layered', elk.direction 'RIGHT', spacing.nodeNode 40,
  spacing.edgeNode 24. Never random positions.
- Edges: bezier, 1px --fg-faint. Width>1 -> 2px. No labels; width shown on the port.
- Interaction:
    * click a node -> emit selection { src } -> the RTL editor (Part 6) scrolls to that line
    * hover -> highlight the node's edges only, dim the rest to 25% opacity
    * fit-to-view on load; zoom/pan; a 'rtl | gate' toggle re-fetches with level
- If truncated: show a chip "showing first 400 of N nodes". Never silently drop.
- Empty state: <NotRun/> plus "run write_rtl first".

CONSTRAINTS
- Positions come from elk only. Never hardcode coordinates.
- Do NOT invent nodes/ports/edges — render exactly what netlist_graph returns.
- Do not use a CDN. All deps via npm (this is the dashboard, not a widget — no CSP limit).

ACCEPTANCE
  UART at level 'rtl' -> a readable left-to-right graph, ports on the correct sides, clicking a
  node reveals its src. Toggling to 'gate' shows the sky130 cells.
```

---

## PART 5 — Waveform + logic analyzer (the CCS look) · ~4h · **needs Part 0**

### PROMPT
```
In /home/saharsh-baiju/nitrostack/dashboard, add the waveform panel (bottom of centre region).

Data: simulate -> trace: Waveform (Part 0). NON-NULL ONLY ON FAILURE.

- components/Waveform.tsx — inline SVG, no charting library.
  * Left gutter (140px): signal names, mono 11px. DUT signals (isDut) grouped under a 'DUT' label;
    testbench signals under 'TB'. Sticky while the lane area scrolls horizontally.
  * Lane area: one row per signal, 22px tall, 48px per cycle.
    - width===1: square wave. High = a line at row top, low = at row bottom, vertical edge on change.
    - width>1: a value bus — hexagon lozenge per cycle, value centred in mono. Render dec if
      width<=8 else hex. Draw the lozenge break only where the value CHANGES.
    - 'init' is the first column, labelled 'init', visually separated by a 1px --border rule.
  * failedAtCycle: full-height vertical --fail line, 2px, with a label chip at the top carrying
    failedAssertion + src.
  * Cycle ruler along the top: 0,1,2...
  * Hover a lane -> tooltip with { cycle, dec, bin }.
- components/AnalyzerTable.tsx (the CCS "Analyzers" panel, right region):
    columns: Assertion | Source | Result | Failing cycle
    from simulate.assertions[]. Rows: proved -> --ok dot, failed -> --fail dot.
    Clicking a row scrolls the waveform to failedAtStep.
- EMPTY STATE — this is the important one. When trace === null and verification.ok === true:
    render the literal text:
      "✅ Proved over N cycles — no counterexample exists."
      "Bounded model checking proves the assertions hold for all inputs over this bound.
       There is no trace to show because the solver could not find a violation."
    DO NOT render an empty grid, a skeleton, or a fabricated waveform.

CONSTRAINTS
- Every value must come from trace.signals[].values[]. Never interpolate, never extend a signal
  past its last real cycle, never invent a clock row.
- If a signal has no value at a cycle, render a gap. Do not carry the previous value forward.

ACCEPTANCE
  Broken UART -> waveform of the real counterexample, red marker at the failing cycle, a_start_low
  + tb.v:11.48 pinned to it.
  Fixed UART -> the "no counterexample exists" message. NOT a blank chart.
```

---

## PART 6 — Inspector, RTL editor, reports, cost · ~4h

### PROMPT
```
In /home/saharsh-baiju/nitrostack/dashboard:

- components/RtlEditor.tsx (left region) — @monaco-editor/react, readOnly, theme vs-dark,
  language 'verilog', fontFamily var(--mono), minimap off, lineNumbers on.
    * Source from design.rtl.files (one tab per file).
    * Selecting a graph node (Part 4) -> parse its src 'u.v:5.30-5.33' -> reveal + highlight line 5.
    * A revision selector (rev1/rev2/...) -> when >1 revision exists, offer a diff view
      (monaco DiffEditor) so the repair loop's one-line fix is visible. This is a strong demo beat.
- components/StageRail.tsx (top of right region) — 5 stages: RTL, Verify, Synth, P&R, Cost.
    Each: StatusDot + name + real elapsed ms once done. Amber pulse while running.
    State from the SSE 'stage' events. Never-run stages are --idle + <NotRun/>.
- components/Stats.tsx — tiles: Area (µm²), Cells, Fmax (MHz), Cost (€).
    Values from the design object. Absent -> <NotRun/> with the tool needed, e.g.
    "needs synthesize(sky130)". Mono, tabular-nums.
- components/CostPanel.tsx —
    * the euro figure, die mm², tiles
    * utilization slider 0.5-0.7 -> re-call cost_sheet -> live update. LABEL IT: "the softest input
      in this model; area is measured, €7,300/mm² is published".
    * cross-check as two horizontal bars: this model €116.80/tile vs TinyTapeout €70/tile, with the
      one-line reason. This visual IS the credibility argument — do not bury it in text.
- components/ReportView.tsx — design_report kind 'all' markdown, rendered read-only,
  with a copy button. Use a tiny local markdown renderer or <pre>. Do NOT add a heavy md lib.

CONSTRAINTS
- Absent data -> <NotRun/>. Never 0, never '—', never a spinner that never resolves.
- Do not re-derive any number in the browser. Cost comes from cost_sheet, area from synthesize.
  The ONLY client-side computation permitted is the utilization slider re-CALLING the tool.

ACCEPTANCE
  Full run -> stage rail advances live; clicking a graph node jumps the editor to the right line;
  the cost slider re-calls the tool and the figure moves; every un-run stage shows "not run".
```

---

## PART 7 — Widget parity (optional) · ~3h

The dashboard is **not scored**. The widget renders inside the judge's Claude. If Parts 0/1 land,
port the waveform into `src/widgets/app/design-report/page.tsx` as inline SVG.

### PROMPT
```
Port the Part 5 waveform into the MCP widget at
/home/saharsh-baiju/nitrostack/src/widgets/app/design-report/page.tsx.

- Read trace from getToolOutput().trace (Part 0).
- Inline SVG only. NO npm charting libs, NO CDN — the widget CSP blocks external hosts and the
  bundle must stay self-contained.
- Same empty state rule: proved -> "no counterexample exists", never a blank chart.
- Keep the existing report/stat-tile sections. The waveform goes directly under the verdict banner.

ACCEPTANCE
  npm run build   (must emit src/widgets/out/design-report.html or the server throws at boot)
  npm run verify:mcp
```

---

## Order, effort, and what to cut

| Part | Effort | Cut it? |
|---|---|---|
| 0 · trace parser | 2h | **Never.** Fixes a real bug; helps the judge's Claude with zero UI. |
| 1 · netlist graph | 3h | Only if you drop Part 4. |
| 2 · shell | 3h | No — everything sits on it. |
| 3 · SSE loop | 4h | No — this *is* "internal working in realtime". |
| 4 · graph panel | 4h | Cut if short. Highest looks-per-hour, but the waveform tells the story. |
| 5 · waveform | 4h | **Keep.** The single most convincing panel. |
| 6 · inspector/cost | 4h | Trim to Stats + StageRail if short. |
| 7 · widget parity | 3h | Do it if Parts 0–5 land early — it's the only part a *judge* sees. |

**Cut order if time runs out: 7 → 4 → 6 → 3.** Parts 0 and 5 are the demo.

## The rule that makes it look expensive

Every panel shows **real, dense, cross-linked data**: a node's `src` jumps the editor to the line;
an assertion row jumps the waveform to the cycle; a cell type maps to a real sky130 area. That
cross-linking is what makes CCS and XOD feel like professional tools — not the colour scheme.
