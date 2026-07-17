# Silicon Architect — API Reference

Everything this server exposes, and exactly what each surface runs underneath.

**Summary of what's underneath:** two WASM binaries (Yosys, nextpnr), one vendored data file
(sky130 liberty), and one HTTP API (GitHub repo search). **No other MCP servers are consumed. No
LLM API is called from the server.** The model doing the designing is the client's — this server
only executes EDA tools and reports what they returned.

---

## 1. Tools (8)

| Tool | Underlying engine | Network? |
|---|---|---|
| `search_ip` | GitHub REST API | ✅ only tool that touches the network |
| `write_rtl` | Yosys WASM | ❌ |
| `simulate` | Yosys WASM (SAT/minisat) | ❌ |
| `synthesize` | Yosys WASM + sky130 liberty | ❌ |
| `place_and_route` | Yosys WASM → nextpnr WASM | ❌ |
| `cost_sheet` | pure TypeScript | ❌ |
| `design_report` | pure TypeScript | ❌ |
| `list_designs` | pure TypeScript | ❌ |

### `search_ip`

Find prior-art IP cores before writing RTL.

- **Input:** `query: string`, `limit: number` (1–20, default 5)
- **API:** `GET https://api.github.com/search/repositories?q=<query>+language:verilog&sort=stars&order=desc&per_page=<limit>`
- **Auth:** none. Repo search works unauthenticated.
  **Do not switch to `/search/code`** — it returns 401 without a PAT.
- **Failure mode:** returns `{ok:false, note}` telling the model to proceed from the spec. Never throws.
- **Returns:** `{ok, query, count, results[{name, fullName, url, stars, description, license, updatedAt}]}`

> ⚠️ The only surface with an external dependency at runtime, and the only one not covered by a test
> suite. If GitHub is unreachable during a demo, it degrades gracefully rather than failing the run.

### `write_rtl`

Submit RTL, elaborate it, create or revise a design.

- **Input:** `spec`, `files: Record<filename, verilog>`, `top`, `target` (`sky130|ecp5|ice40|artix7`), `clock_mhz`, `design_id?`
- **Yosys script:**
  ```
  read_verilog -sv <files>
  hierarchy -check -top <top>
  proc
  write_json design.json
  ```
- **Why `write_json`:** module/port interfaces are parsed from Yosys's own JSON, never from regexing the source.
- **Side effect:** on success, **clears** `verification`, `synthesis`, `pnr`, `cost` — they describe the previous revision and would otherwise be stale lies.
- **Returns:** `{ok, design_id, top, revision, modules[], lines, elaboration_log?, next_step, report}`

### `simulate`

Formally verify assertions by bounded model checking. **Does not simulate.**

- **Input:** `design_id`, `testbench: Record<filename, verilog>`, `tb_top`, `depth` (1–50, default 12)
- **`taskSupport: 'optional'`** — reports progress via `ctx.task.updateProgress`
- **Stage 1 — enumerate assertions** (`listAsserts`):
  ```
  read_verilog -sv -formal <files>     # -formal or assertions are SILENTLY DISCARDED
  hierarchy -check -top <tb_top>
  proc
  flatten                              # mandatory: SAT cannot see into submodules
  opt
  async2sync                           # lowers $check -> $assert; must precede t:$assert
  opt
  write_json v.json                    # cells[].attributes.src -> real file:line
  ```
- **Stage 2 — prove all at once** (fast path):
  ```
  select -assert-count <N> t:$assert   # guard: errors instead of proving an empty design
  sat -verify -prove-asserts -seq <depth> -show-all <tb_top>
  ```
- **Stage 3 — isolate** (only on failure, one run per assertion):
  ```
  chformal -remove t:$assert c:<keep> %d
  select -assert-count 1 t:$assert
  sat -verify -prove-asserts -seq <depth> -show-all <tb_top>
  ```
- **Verdict:** exit 0 + `SAT proof finished - no model found: SUCCESS!` = proved.
  Exit 1 + `Called with -verify and proof did fail!` = failed.
- **Returns:** `{ok, design_id, method:'bmc-sat', depth, assertions[{cell, src, status, failedAtStep}], counterexample[], log?, next_step, report}`

**Three refusals built in:**
- Testbench doesn't compile → reported as a **compile error**, not "no assertions".
- Zero assertions → **`ok:false`**. BMC of nothing succeeds vacuously; reporting pass would be the most dishonest thing this server could do.
- Non-proof errors (missing module, syntax) surfaced as-is, not mislabeled as a failed assertion.

### `synthesize`

Map RTL to real cells.

- **Input:** `design_id`, `target?` (defaults to the design's target)
- **sky130** — the only path to area, and therefore to cost:
  ```
  read_verilog -sv <files>
  synth -top <top>
  dfflibmap -liberty sky130.lib      # MUST precede abc, or FFs land in unknown_cell_area
  abc -liberty sky130.lib
  opt_clean
  stat -top <top> -liberty sky130.lib -json
  ```
- **FPGA** (`artix7` → `synth_xilinx`, `ecp5` → `synth_ecp5`, `ice40` → `synth_ice40`):
  ```
  read_verilog -sv <files>
  <synth_pass> -top <top>
  stat -top <top> -json              # NEVER -tech with -json: emits invalid JSON, and -tech has no area
  ```
- **Bucketing:** cells grouped by name prefix in TypeScript (`LUT*`, `FD*`, `RAMB*`, `DSP48*`), because `-tech` is unusable with `-json`.
- **Artix-7 part fit:** against XC7A35T — **20,800 LUT6**, not 5,200 (that figure counts *slices*, off by 4×). Source: Xilinx DS180.
- **Returns:** `{ok, target, cell_count, area_um2, sequential_area_um2, buckets, utilization, fmax_mhz: null, fmax_note, warning?, next_step, report}`

> `fmax_mhz` is **always `null`** here. Synthesis produces no timing. For Artix-7 it can never be
> obtained with this toolchain, and `fmax_note` says so.

### `place_and_route`

The **only** source of a real achieved Fmax.

- **Input:** `design_id`, `target` (`ecp5|ice40`, default `ecp5`), `device` (default `25k`), `target_mhz`
- **Step 1 (Yosys):** `read_verilog -sv <files>` + `synth_ecp5 -top <top> -json netlist.json`
- **Step 2 (nextpnr WASM):** `runNextpnrEcp5(['--json','netlist.json','--25k','--textcfg','out.cfg','--freq','<mhz>'])`
- **Parsing:** Fmax from `Max frequency for clock '<clk>': <N> MHz` (min across clocks); utilization from `Info: <RES>: <used>/<avail> <pct>%`, with unused resource classes dropped (ECP5 reports ~29, nearly all zero).
- **Returns:** `{ok, design_id, device, fmax_mhz, target_mhz, timing_met, utilization[], log?, report}`
- **Verified:** UART → **185.49 MHz**, timing met vs 100 MHz target, ~2.1s.

> No Xilinx. nextpnr upstream supports ECP5/iCE40/Nexus/Gowin/MachXO2 — Artix-7 is openXC7, a
> separate project needing prjxray-db, with **no WASM build**.

### `cost_sheet`

Real area → die area → euros. **Pure TypeScript, no tool call.**

- **Input:** `design_id`, `utilization` (0.1–1, default 0.6)
- **Formula:**
  ```
  die_mm2  = area_um2 / 1e6 / utilization
  cost_eur = die_mm2 * 7300                  # IHP SG13G2 MPW, 40 samples
  tiles    = ceil(area_um2 / 16000)          # TinyTapeout 160x100um tile
  ```
- **Refuses to guess:** throws if no sky130 area exists, naming the exact call to make. An invented area would silently poison every downstream number.
- **Cross-check:** 1 TT tile = 0.016 mm² × €7,300 = **€116.80** vs TT's **~€70/tile**. Same order; TT is cheaper because it amortizes one die across hundreds of projects.
- **Returns:** `{ok, design_id, area_um2, die_mm2, cost_eur, tinytapeout_tiles, cross_check, source, report}`

> **eFabless shut down March 2025.** chipIgnite/MPW pricing is dead. IHP is the live source.

### `design_report`

The five reports. Pure TypeScript render of recorded output.

- **Input:** `design_id?` (defaults to latest), `kind`: `all | rtl | verification | synthesis | summary | cost`
- **Returns:** `{ok, design_id, kind, report: <markdown>, sections[], design{...}}`
- `report` is what a human reads; `design` is structured data that drives the widget.

### `list_designs`

- **Input:** none. **Returns:** `{ok, count, designs[]}` with per-design pipeline status.

---

## 2. Resources (5 authored)

| URI | Type | Backed by |
|---|---|---|
| `silicon://targets` | JSON | constants in `types.ts` (DS180 capacities, per-target limits) |
| `silicon://cost-model` | JSON | the cost formula, its sources, and what it excludes |
| `silicon://toolchain` | JSON | what runs, and what this server **cannot** do |
| `silicon://designs` | JSON | `SessionStore` |
| `silicon://design/{id}/report` | Markdown | `SessionStore` + `reports.ts` (RFC 6570 template) |

The first three exist so a judge can **audit a number without trusting the tool that produced it** —
they state the provenance, the dead sources (eFabless), and the honest limits in the server's own words.

**Also auto-registered by NitroStack** (not authored by me): `health://checks`,
`ui://widget/next-design-report.html`, `widget://examples`.

---

## 3. Prompts (3)

| Name | Arguments | Role |
|---|---|---|
| `design_chip` | `spec*`, `target`, `clock_mhz` | Full flow: architect → IP scout → RTL → verification → physical → cost → writer |
| `verify_design` | `design_id*`, `depth` | Write real assertions and prove them, iterating on failure |
| `cost_review` | `design_id*` | Produce and adversarially audit the cost figure |

All three embed the same `CONTROL_PLANE_RULES` preamble: never state a number the toolchain didn't
produce; `ok:false` is data; zero assertions = not verified; cost needs real area; never claim
Artix-7 timing closure.

> **This is where the proposal's "seven agents" actually live** — as system-prompt roles inside one
> client loop. NitroStack has no agent primitives and no MCP client, so seven services were never
> buildable. Putting the roles in prompts means the *judge's own Claude* picks up the same roles our
> client would use.

---

## 4. Widget (1)

**`design-report`** — `src/widgets/app/design-report/page.tsx`

- Attached via `@Widget('design-report')` to `write_rtl`, `simulate`, `synthesize`, `place_and_route`, `cost_sheet`, `design_report`
- Next.js page → static HTML export → served as MCP resource `ui://widget/next-design-report.html`
- Reads tool output via `useWidgetSDK()` from `@nitrostack/widgets`
- Renders: verdict banner, stat tiles (area/cells/Fmax/cost), assertion table with `src` and pass/fail, counterexample, part-fit bars, next-step hint, full report
- **No external requests** — no fonts, no CDN, no images. Inline styles only.
- Renders **partial** designs: a stage that hasn't run shows "not run", never a zero that could be mistaken for a measurement
- `widget-manifest.json` carries 2 example payloads (verified+costed UART; failed verification) for NitroStudio preview

**Requires `src/widgets/out/design-report.html` at boot** or the server throws. `npm run build`
builds it; plain `npx tsc` does not.

---

## 5. Health checks (2)

| Name | Interval | Checks |
|---|---|---|
| `system` | 30s | uptime, heap, pid, node version |
| `toolchain` | 60s | sky130.lib present and **≥1MB** (a truncated copy would silently produce wrong area); Yosys WASM loaded/lazy |

Exposed at `health://checks`. The `toolchain` check exists because the two things that realistically
break on a fresh host — the 54MB WASM failing to resolve, and the vendored liberty not shipping —
are otherwise silent until the first tool call.

---

## 6. External dependencies — the complete list

| Dependency | Version | Used by | Network at runtime? |
|---|---|---|---|
| `@yowasp/yosys` | 0.65.176-dev (**reports as Yosys 0.64**) | `write_rtl`, `simulate`, `synthesize`, `place_and_route` | ❌ local WASM |
| `@yowasp/nextpnr-ecp5` | 0.11.75-dev | `place_and_route` | ❌ local WASM |
| `assets/sky130.lib` | `sky130_fd_sc_hd__tt_025C_1v80` | `synthesize(sky130)` → `cost_sheet` | ❌ **vendored**, 13MB, 428 cells with real `area` |
| GitHub REST API | — | `search_ip` only | ✅ unauthenticated repo search |
| `@nitrostack/core` | 1.0.13 | framework | ❌ |
| `zod` | 3.x | input schemas | ❌ |

**Not used, despite appearing in the original plan:**

- **No other MCP servers.** This server is a leaf; it consumes nothing.
- **No NVIDIA NIM / LLM API.** Nothing in the server calls a model. `NVIDIA_API_KEY` is unused.
- **No ChipNeMo.** Research-only, not callable. Kept out of the code and off the slides.
- **No Verilator.** No WASM build exists.
- **No `sim` pass.** Does not exist in this Yosys build — hence BMC.
- **No database, Redis, Celery, Docker-for-sandboxing.** Sessions are in-memory (capped at 50); the WASM already sandboxes with a virtual FS.

The "fetched 54MB" progress lines on first use are **local file reads** of
`node_modules/@yowasp/yosys/gen/*` (43MB `core.wasm` + 10.6MB resources tar), not downloads.

---

## 7. Architecture

```
Judge's Claude ──MCP/HTTP──> silicon-architect (/mcp)
                                  │
                                  ├── @Tool      search_ip ──────> GitHub REST API
                                  ├── @Tool      write_rtl ───┐
                                  ├── @Tool      simulate ────┤
                                  ├── @Tool      synthesize ──┼──> Yosys WASM (in-process)
                                  ├── @Tool      place_and_route ─> + nextpnr WASM
                                  ├── @Tool      cost_sheet ──┐
                                  ├── @Tool      design_report┼──> SessionStore (memory)
                                  ├── @Resource  silicon://*  ┘
                                  ├── @Prompt    design_chip, verify_design, cost_review
                                  └── @Widget    design-report ──> rendered inline in the client
```

**One server, no client required.** Everything a judge needs is behind `/mcp`.

---

## 8. Source layout

| File | Responsibility |
|---|---|
| `src/lib/yosys.ts` | **The only place `@yowasp/yosys` is imported.** Catches `Exit` → `{ok, code, log, files}`, so a *failed* run still returns its log. Lazy-loads and caches the WASM. |
| `src/lib/eda.ts` | Every Yosys script in the project. Pass ordering is load-bearing. |
| `src/lib/reports.ts` | The five reports. Renders recorded output only — never estimates. |
| `src/lib/session.store.ts` | In-memory design records, capped at 50. |
| `src/lib/types.ts` | The design record + verified constants (DS180, IHP, TinyTapeout). |
| `src/modules/silicon/*` | Tools, resources, prompts, module wiring. |
| `src/health/toolchain.health.ts` | Proves the toolchain is live in *this* deployment. |
| `e2e.mjs` / `mcp-e2e.mjs` | 22 in-process checks / 28 over live HTTP. |

Read `CLAUDE.md` (verified contracts + landmines) and `log.md` (decisions and why) before
changing any Yosys script.
