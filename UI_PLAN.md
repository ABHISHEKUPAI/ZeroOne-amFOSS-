# Silicon Architect — Capabilities & UI Plan

## Part 1 — What it does right now

Live at `/mcp`. **8 tools, 5 resources, 3 prompts, 1 widget, 2 health checks.** Every number comes
from a real Yosys 0.64 / nextpnr run as WASM in-process. No mocks, no LLM in the server, no keys.

### Core capabilities

| Capability | Tool | What's real |
|---|---|---|
| **Find prior art** | `search_ip` | GitHub repo search, ranked by stars, with SPDX licence |
| **Elaborate RTL** | `write_rtl` | `read_verilog` + `hierarchy -check`; module/port interfaces parsed from Yosys JSON, not regex |
| **Formally verify** | `simulate` | `sat -verify -prove-asserts -seq N` — BMC. Per-assertion verdict + `src` + counterexample |
| **Synthesize (ASIC)** | `synthesize(sky130)` | `stat -liberty` → **real µm²** from 428 vendored foundry cells |
| **Synthesize (FPGA)** | `synthesize(artix7/ecp5/ice40)` | LUT/FF/BRAM/DSP counts; XC7A35T part fit (20,800 LUT6, per DS180) |
| **Close timing** | `place_and_route(ecp5)` | **nextpnr** real P&R → achieved Fmax (~185 MHz on the UART) |
| **Cost the die** | `cost_sheet` | area → die mm² → IHP €7,300/mm², + TinyTapeout cross-check |
| **Report** | `design_report` | RTL · Verification · Synthesis · Summary · Cost |
| **Session** | `list_designs` | revisions, pipeline status, tool-call history |

### Verified reference numbers

| Metric | Value |
|---|---|
| UART cell area | 1,049.76 µm² (101 cells) |
| Cost @60% util | €12.77 · 1 TT tile |
| ECP5 Fmax | 185.49 MHz (timing met vs 100 MHz) |
| Gray counter | 153.9 µm² → €1.87 |
| Cross-check | €116.80/tile vs TT €70 |
| Pipeline peak RSS | ~670 MB (**needs ≥1GB host**) |

### The differentiator — it refuses to lie

- Broken UART → `ok:false`, `a_start_low` failed **at `tb.v:11.48`**, with counterexample; `a_idle_high` still proves. **Fault localisation, not a red light.**
- `cost_sheet` **throws** without real area rather than estimating.
- Zero assertions → **FAIL**, not pass (BMC of nothing succeeds vacuously).
- Artix-7 Fmax → **refused** (synthesis only, no P&R).
- Power → **refused** (no estimator exists).
- Report sections for stages that didn't run say **"not run"**, never a zero.

### Honest limits (the server states these itself)

No simulator (`sim` doesn't exist in this build) · no `$display` · no SVA (`assert property` is a
syntax error — Verific absent) · verification bounded to N cycles · no Artix-7 timing · no power.

---

## Part 2 — The UI plan

### The one constraint that shapes everything

> **There is no simulator.** We cannot show a free-running waveform, because no such data exists.
> Faking one would destroy the only thing that makes this project credible.

**But we don't need to fake it.** `sat -show-all` emits a full per-cycle trace:

```
  Time Signal Name          Dec   Hex   Bin
  init \u.st                  2     2    10
     1 \u.tx                  0     0     0
```

That is **real per-cycle signal data from the solver** — the exact execution that violates your
assertion. Rendering it is a *stronger* demo than a simulation waveform, and it's true:

> "This isn't a simulation I ran hoping to catch the bug. This is the counterexample the solver
> **proved** exists — the precise trace where your UART breaks."

Prototyped against real output: the trace parses cleanly into `{name, width, values[]}` per signal.

### Guiding principles

1. **Never render data a tool didn't produce.** No waveform for a passing design — there is no
   counterexample. Show "proved, no counterexample exists" and mean it.
2. **Widgets before dashboard.** Widgets land *inside the judged artifact*. The dashboard must never
   be load-bearing — if a capability only works there, it doesn't count.
3. **Server-side parsing.** Structured data benefits the judge's Claude too, not just our UI.

---

### Phase 0 — Structured trace (server) · ~2h · **blocks everything**

The linchpin. Do this first; both clients get it free.

**Fix the truncation.** `counterexampleLines()` in `eda.ts` caps at 60 lines, so we currently keep
only `init` + cycle 1 and **throw the rest of the trace away**. Found while prototyping.

**Add to `VerificationResult`:**

```ts
export interface WaveformSignal {
  name: string;              // 'u.tx'  (backslash stripped)
  width: number;             // from Bin length
  values: Array<{ cycle: number | 'init'; dec: string; bin: string }>;
  isDut: boolean;            // u.* vs testbench-local
  changedAtFailure: boolean; // highlight what actually moved
}
export interface Waveform {
  cycles: (number | 'init')[];
  signals: WaveformSignal[];
  failedAtCycle: number | null;
  failedAssertion: string | null;   // 'a_start_low'
  src: string | null;               // 'tb.v:11.48-11.80'
}
```

**Filter** `$auto$*` / `$assert$*` compiler internals — keep what the engineer wrote. Keep assert
enables as a separate marker row.

**Deliverable:** `simulate` returns `trace` alongside `counterexample`. Judge's Claude can now
describe the waveform in words even with no UI at all.

---

### Phase 1 — Widgets · ~1 day · **highest leverage**

These render in the judge's own Claude. This is the scored artifact.

**1a. `waveform` widget** — the money shot
- Digital timing diagram, SVG, no libraries (CSP blocks CDNs anyway)
- 1-bit signals: square wave. Multi-bit: value-bus lozenges with hex/dec
- **Failing cycle: red vertical marker**, assertion name + `src` pinned to it
- DUT vs testbench signals grouped and visually separated
- Hover → per-cycle value readout
- Empty state for a *passing* design: "✅ Proved over N cycles — no counterexample exists." Not a blank chart.

**1b. `design-report` polish**
- Current widget is functional but generic. Wants: real typographic hierarchy, a proper stage
  rail (RTL → Verify → Synth → P&R → Cost) with per-stage state, tighter stat tiles
- Cost panel: make the TinyTapeout reconciliation visual (two bars, €116.80 vs €70) — the
  "two independent sources agree" story told in one glance
- Keep "not run" visually distinct from zero. Non-negotiable.

**1c. `cell-treemap` widget** (optional)
- 101 cells → treemap by area. Shows *where* the µm² went (33 dfxtp_1 flip-flops dominate)
- Real `cellsByType` + liberty areas. Cheap, and it looks like real EDA.

---

### Phase 2 — Dashboard · ~2 days · Next.js + OpenAI

Now the realtime story. **Separate app** (`dashboard/`), never a dependency of the server.

**Architecture**

```
Browser ──SSE──> Next.js route handler ──MCP/HTTP──> silicon-architect
                        │
                        └── OpenAI (tool calling, your key)
```

The agent loop runs **server-side in the route handler** and streams SSE to the browser. This
sidesteps the MCP progress limitation entirely (there are no MCP progress notifications, only
`notifications/tasks/status`) — we emit our own events around each tool call.

**Loop**
```ts
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// tools/list from MCP -> OpenAI function defs (inputSchema is already JSON Schema)
// stream: 'tool_call_start' | 'tool_call_end' | 'token' | 'stage' | 'done'
```
Model: `gpt-4o` / `gpt-4.1` class — **must support tool calling**. Seed the system prompt from the
server's own `design_chip` prompt so the dashboard and the judge's Claude share one brain.

**Realtime progress, honestly**
- `tool_call_start` → stage rail lights up, spinner + elapsed timer
- Sub-progress from `ctx.task.updateProgress` (already wired: "Proving 2 assertion(s) over 10 cycles…", "Isolating assertion a_start_low…")
- `tool_call_end` → real elapsed ms (we already return `elapsedMs`)
- Show the **actual tool name and arguments**. The control-plane claim *is* the demo — don't hide it behind a progress bar.

**Layout**
```
┌──────────────────────────────────────────────────────────┐
│ spec input          │  stage rail: RTL→Verify→Synth→P&R→€ │
├─────────────────────┼────────────────────────────────────┤
│ RTL (Monaco,        │  ▸ live tool-call stream            │
│  read-only,         │  ▸ waveform (on failure)            │
│  revision diff)     │  ▸ stat tiles / cost                │
└─────────────────────┴────────────────────────────────────┘
```
- **Revision diff** is a great touch: rev1 → rev2 highlighting the one-character start-bit fix
- Cost panel with a utilization slider (0.5–0.7) — recompute live, and label it the softest input

**Design direction:** dark, technical, high information density. Reference: an EDA tool, not a SaaS
landing page. JetBrains Mono for signals/values, tabular numerals everywhere, restrained accent
colour used *only* for pass/fail. No gradients, no glass. Let the data be the design.

---

### Phase 3 — Witness traces (stretch) · ~half day

The gap: **a passing design has no waveform**, because no counterexample exists.

Fix honestly — ask SAT for a *witness* instead of a violation: `sat -seq N -show-all -set <sig> <val>`
finds a real execution reaching a condition (e.g. "show me a trace where `tx_busy` rises"). Same
solver, same rigour, positive framing:

> "Not only can it not break — here's the solver-generated trace of it working."

Label it **SAT witness**, never "simulation".

---

### Order & effort

| Phase | Effort | Why this order |
|---|---|---|
| 0 · structured trace | ~2h | Blocks 1a. Improves the judge's experience with zero UI. |
| 1 · widgets | ~1 day | Inside the judged artifact. Highest score-per-hour. |
| 2 · dashboard | ~2 days | Impressive, but **not scored** if the widget already tells the story. |
| 3 · witness | ~4h | Only if Phase 2 lands early. |

**If time runs short, cut Phase 2, not Phase 1.** The dashboard is the part a judge never has to
open. That is the whole reason the widget exists.

### What not to build

- ❌ Waveform for a passing design without Phase 3 — fabrication
- ❌ A fake progress bar with invented percentages — we know real elapsed times; use them
- ❌ Any capability that exists only in the dashboard
- ❌ Charting libraries — CSP blocks external hosts; inline SVG only
- ❌ NVIDIA NIM. You have an OpenAI key; the server needs no LLM at all
