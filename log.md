# Decision Log

Newest first. One entry per decision or stage-blocking surprise: what was decided, **why**, and what it
costs us. Evidence lives in `research.md`; conventions live in `CLAUDE.md`. This file is the *reasoning*
— read it when a past decision looks wrong, before reversing it.

---

## 2026-07-17 — Built. Pipeline verified end to end against real tools.

**Status: DONE.** Flights starter stripped; `silicon-architect` serves 8 tools, 5 resources,
3 prompts, 1 widget, 2 health checks over Streamable HTTP at `/mcp`.

**Verified, not assumed** — two suites, both green: `e2e.mjs` (22 checks, in-process) and
`mcp-e2e.mjs` (28 checks, over the live HTTP endpoint as a judge's client would).

**The critical assertion holds.** Same testbench, one-character RTL difference:

| design | result |
|---|---|
| start bit `1'b0` (correct) | `ok:true`, 2/2 assertions **proved** |
| start bit `1'b1` (broken) | `ok:false`, `a_start_low` **failed** @ `tb.v:11.48-11.80`, 40-line counterexample, `a_idle_high` still proved |

Precise fault localisation, not a blanket failure — and `cost_sheet` **refuses** to run without a
real area rather than estimating one. Real numbers from the run: **1,049.76 µm²** (sky130,
`stat -liberty`), **€12.77**, **185.49 MHz** achieved Fmax (nextpnr ECP5, timing met vs 100 MHz).
The TinyTapeout cross-check lands at **€116.80/tile vs TT's €70** — the reconciliation predicted in
the cost decision below, reproduced from real tool output.

**Design choice — reports never fabricate.** A stage that did not run renders as "not run" with the
tool to call, never as a zero or a dash. `cost_sheet` throws instead of guessing area; a proof with
zero assertions is reported as **FAIL**, not pass, because BMC of nothing succeeds vacuously.

**Landmines that cost real time** (all now in `CLAUDE.md`): `@Module({providers})` exposes nothing —
tools must be in `controllers`; resource/prompt classes need `@Controller()` or DI silently injects
`undefined`; `read_verilog` needs `-formal` or assertions are discarded; concurrent SVA is a syntax
error; hierarchical refs into the DUT alias to a stale copy after `flatten`.

**Deferred:** `search_ip` is unit-tested but not exercised against live GitHub in CI.

---

## 2026-07-17 — `sim` does not exist in YoWASP. Verification is now formal BMC via `sat`.

**Status: RESOLVED. Reverses the "Yosys `sim` replaces Verilator" decision below.**

**The surprise:** `@yowasp/yosys` (published 0.65.176-dev, reports itself as **Yosys 0.64**, *not* 0.67)
**does not ship the `sim` pass at all**. A real run returns:

```
ERROR: No such command: sim (type 'help' for a command overview)
```

So `sim -assert -summary summary.json` — the structured-JSON verdict this project's entire pass/fail
claim was built on — **cannot be called.** Verilator was already cut for having no WASM build; `sim` was
its replacement, and `sim` isn't there either. Both prior verification plans were dead simultaneously.

**Decision:** verify with **`sat -verify -prove-asserts -seq N`** — bounded model checking. Confirmed by
probe against the real WASM, both directions:

| design | exit | signal |
|---|---|---|
| assertion that must fail | `ok:false`, code 1 | `ERROR: Called with -verify and proof did fail!` + counterexample trace |
| assertion that must hold | `ok:true`, code 0 | `SAT proof finished - no model found: SUCCESS!` |

**This is an upgrade, not a consolation.** `sim` simulates one stimulus and reports what happened; `sat
-prove-asserts` **proves the assertion holds over all inputs for N cycles**, and on failure returns a
concrete counterexample trace. "We formally proved it" beats "we ran a testbench" on stage, and the
counterexample is exactly what the repair loop needs.

**`src` survives.** Yosys names each assert cell `$assert$<file>:<line>$<id>` (e.g.
`$assert$tb.v:5$5_EN` appears verbatim in the failure trace), so file:line is recoverable by parsing the
cell name. The critical assertion in `CLAUDE.md` — *broken UART ⇒ `ok:false` with non-empty
`assertions[]` carrying `src`* — **still holds**, just sourced from the trace rather than a JSON summary.

**Landmines found while proving this:**
- **`flatten` is mandatory before `sat`.** Without it: `ERROR: No SAT model available for cell u (dut)` —
  SAT cannot see into submodules. Costs a full run to diagnose.
- **`async2sync` is required** for clocked assertions.
- **Do not pass `-tempinduct-def`** with `-seq` here; plain `-seq N` BMC is what gives the clean verdict.
- The testbench must be a **module with clk/rst as inputs**, not an `initial`-block stimulus TB — there
  is no simulator to run stimulus. Assertions are proved, not exercised.

**Cost:** we lose `$display`/`display_output` (no simulator) and arbitrary stimulus testbenches. The TB
style changes from "drive and check" to "constrain and assert". Acceptable — and the UART demo is
expressible either way.

---

## 2026-07-17 — Open: the hackathon itself is unidentified

**Status: BLOCKING. Unresolved.**

The public NitroStack hackathon page describes a **48-hour sprint on Apr 17–19, 2026 — already past** —
organized by **NitroStack alone, with no partner named anywhere in the page HTML**. Searching for
"Weekan Enterprise" returns **nothing**: not on the page, not in search. Nearest match is Wekan, an
unrelated kanban board.

**Why it matters:** the rule *"judges will test your endpoint directly; local-only projects receive zero
points"* is the single constraint driving the whole architecture — it's why everything must be hosted,
which is why we're all-WASM, which is why Verilator is cut. If that rule isn't real for *our* event, a
large part of this design is unnecessary.

**Action:** confirm with the organizer — rules page, deadline, and deploy target — before hour 0b.

---

## 2026-07-17 — Docs are not trustworthy; verify against shipped code

**Decision:** treat `.d.ts` / `dist` / upstream C++ source as truth, and vendor docs as aspiration.

**Why:** the docs were wrong repeatedly, and each one would have cost hours:

- NitroStack docs instruct `nitrostack login` / `nitrostack deploy`. **Neither command exists** in CLI 1.0.14.
- The hackathon page references `npx nitrostack-test`. **No such package exists on npm.**
- A WebFetch summary claimed `"design"` nests inside `"modules"` in `stat -json`. **The source says
  sibling.**
- Research initially concluded `synth_ecp5` was removed (its `techlibs/ecp5/` dir *is* gone).
  **Wrong** — it survives as a wrapper in `synth_lattice.cc`. Only reading the source caught it.
- Search results and SEO tables report Artix-7 **slice** counts labeled as **LUT** counts. **Off by 4×.**

**Cost:** research took longer. **Worth it** — every one of the above is a mid-sprint failure avoided.

---

## 2026-07-17 — Cost sheet: real foundry data, not a formula

**Decision:** `stat -liberty` against the real sky130 `.lib` → true µm² → **IHP MPW €7,300/mm²**. Publish
the TinyTapeout cross-check alongside it.

**Why:** this is the most credible number in the project — actual foundry cell areas (428 cells with
`area` attributes, units confirmed µm² by cross-checking known cell geometry), not an estimate. The
`.lib` is one self-contained 13MB file: no open_pdks build, no Docker. And the reconciliation is the
real demo: 1 TT tile = 0.016mm² × €7,300 = **€117** vs TT's ~€70/tile — same order, TT cheaper because
it amortizes one die across hundreds of projects. **Showing two independent sources agree is stronger
than either number alone.**

**Rejected:** textbook wafer-cost/yield math (Murphy/Bose-Einstein). At 130nm hobby scale yield ≈ 1 and
the wafer-price inputs aren't publicly citable — **we'd be inventing numbers.** IHP's price list is real,
current, and quotable.

**Landmine:** **eFabless shut down March 2025.** Every chipIgnite/MPW figure still floating around is
stale, and a judge who follows this space would catch it instantly. IHP is the live source. (The
`efabless/` GitHub mirror still resolves and is still the right place to get the `.lib` — the org
outlives the company.)

**Deferred:** power. Yosys has no power estimation. Static leakage is computable from `leakage_power` in
the `.lib`; dynamic needs VCD toggle counts and is a large lift. Report leakage only (labeled "static
leakage only") or cut it.

---

## 2026-07-17 — Target: ECP5 for real Fmax, Artix-7 for the narrative

**Decision:** demo ECP5 (real utilization **and** real achieved-MHz) while still reporting Artix-7
LUT/FF/BRAM/DSP and part fit.

**Why:** stock Yosys **cannot give Artix-7 Fmax** — `synth_xilinx` is synthesis-only, no P&R, no timing.
Real Fmax needs nextpnr, which upstream supports for iCE40/ECP5/Nexus/Gowin/MachXO2 but *not* Xilinx
(that's openXC7 — separate repo, needs prjxray-db, **and has no WASM build**). A real achieved-MHz number
is what sells "it actually closed timing," so we need a target that can produce one.

**Cost:** we cannot claim timing closure on Artix-7. The proposal's Artix-7 framing survives for
utilization and part selection only. **Do not overstate this on stage.**

---

## 2026-07-17 — Everything hosted → all-WASM → Verilator cut

**Decision:** the entire toolchain runs as WASM in-process on NitroCloud. **Verilator is cut.** Yosys's
`sim` pass replaces it.

**Why:** the hackathon rule is *"judges will test your endpoint directly; local-only projects receive
zero points."* Verilator has no WASM build (`@yowasp/verilator` 404s), so it **cannot be hosted** — any
design depending on it needs a VM we control, which is exactly the single point of failure the rule
punishes. YoWASP ships real Yosys 0.67 and nextpnr as WASM on npm, with a virtual filesystem (no disk
I/O) and — critically — `Exit` carries both `code` **and** `files`, so a *failed* run still returns its
log. That's the genuine pass/fail signal the whole self-correction loop reads.

**The tradeoff turned out to be a win.** `sim -assert -summary` gives:
- non-zero exit on a failed assertion → `Exit{code, files}` → real pass/fail, and
- structured JSON: `{steps, top, assertions:[{step, type, path, src}], display_output:[...]}`

**Assertions come back with `src` (source file:line), and `display_output` captures `$display`.** For an
agent repair loop this is *better* than Verilator: the model gets the failing line directly instead of
scraping a log. We lose arbitrary SystemVerilog testbenches — acceptable for the UART demo.

**Also de-risked:** NitroStack's server build is plain `npx tsc` with **no bundler** (esbuild only touches
widgets), so the `gen/*.wasm` assets survive in `node_modules`. This was the biggest technical risk and
it evaporated on inspection.

---

## 2026-07-17 — The seven agents become one MCP client loop

**Decision:** NitroStack exposes the EDA toolchain as MCP tools. The proposal's seven agents become
system-prompt roles inside a single client loop we write against NVIDIA NIM. **We do not build seven
services.**

**Why:** forced, not chosen. **NitroStack has no agent primitives and no MCP client** — verified from the
shipped `.d.ts` (it's NestJS-style: `@Tool`, `@Module`, `@McpApp`, DI, guards, OAuth) and by grepping the
whole core tarball for `agent|client|sampling|elicit` (only hit is OAuth client registration). **The
proposal's "NitroStack Orchestrator" box cannot be built as written.**

**This makes the pitch stronger, not weaker.** "MCP as a control plane" becomes literal: the tools *are*
the control plane, and the model picks the next call from what the last one returned.

**Consequence — the highest-leverage property in the plan:** the MCP server must be **self-sufficient**,
so a judge can point their own Claude at it and watch it design hardware without our client. The demo
then survives our dashboard breaking, and judges can reproduce it without us. **Never let a capability
exist only in our dashboard.**

**Bonus discovered later:** `@Widget` lets the MCP server ship its own UI — a Next.js page bundled to
self-contained HTML, served as an MCP resource, fed the tool's output via `structuredContent`. **The
dashboard and visualizer land inside the judged artifact for free**, rendered inline in the judge's own
Claude. (Set `NITROSTACK_APP_MODE=universal`; the default targets ChatGPT.)

---

## 2026-07-17 — All-TypeScript, lean stack

**Decision:** NitroStack MCP server (TS) + Next.js dashboard that *is* the MCP client. **Dropped FastAPI,
Redis, Celery, and Docker-for-sandboxing** from the proposal.

**Why:** TypeScript is forced at the server anyway — NitroCloud hosts it and the YoWASP packages are npm.
Adding a Python orchestrator means two languages and two deploys for zero scored points. With <24h to
judging, the proposal's full stack (Next + FastAPI + Redis + Postgres + Celery + Docker) is realistically
unbuildable, and **none of it is what judges score** — they score the tool-calls. Docker sandboxing is
moot regardless: YoWASP already runs in a WASM sandbox with a virtual FS.

**Cost:** no durable job queue or cross-restart persistence. NitroStack tasks are in-memory
(`TaskManager.tasks` is a Map) — single replica, or sticky sessions. Acceptable for a demo.
