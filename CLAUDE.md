# Silicon Architect

Autonomous AI hardware architect for the NitroStack MCP Hackathon. Natural-language spec in
("Design a UART for Artix-7 at 100MHz"), verified RTL + costed engineering report out.

The pitch: **MCP as a control plane, not a data connector.** The model chooses which EDA tool to call
next based on what the last tool actually returned. Not a hardwired pipeline.

See `research.md` for the evidence behind every claim here, and `log.md` for decisions and why.

## Architecture

```
Judge's Claude ──┐
                 ├──MCP──> silicon-architect-mcp (NitroStack, NitroCloud)
Our dashboard ───┘             │  @Tool  search_ip, write_rtl, simulate,
  (Next.js +                   │         synthesize, place_and_route, cost_sheet
   NVIDIA NIM                  │  @Widget cost-sheet, waveform, architecture
   agent loop)                 v
                        YoWASP WASM in-process
                        yosys 0.67 · nextpnr · sky130 .lib
```

**One server, two clients.** The MCP server is self-sufficient — a judge points their own Claude at it
and it designs hardware, with our widgets rendering inline. Our dashboard drives the *same* server.
Consequence: **never let the dashboard become load-bearing for the demo.** If a capability only works
from our client, it does not count.

## Constraints (these are decided — do not relitigate)

- **All TypeScript.** No FastAPI, Redis, Celery, or Docker-for-sandboxing. One language, one deploy.
- **All WASM, everything hosted.** Hackathon rule: *judges test your endpoint directly; local-only
  scores zero.* Therefore **Verilator is cut** — it has no WASM build.
- **Verification is formal BMC via `sat`, NOT `sim`.** `@yowasp/yosys` reports itself as **Yosys 0.64**
  and **does not ship the `sim` pass** (`ERROR: No such command: sim`). Verified against the real WASM.
  Use `sat -verify -prove-asserts -seq N`. See `log.md` for the full reversal.
- **NitroStack has no agent primitives and no MCP client.** It is an MCP *server* framework. The
  proposal's "seven agents" are system-prompt roles inside one client loop we write. Do not build
  seven services.

## API contracts (verified against shipped code — trust these over the docs)

### YoWASP

```ts
type Tree = { [name: string]: Tree | string | Uint8Array };
const runYosys: (args?: string[], files?: Tree, options?: RunOptions) => Promise<Tree>;
class Exit extends Error { code: number; files: Tree; }   // non-zero exit throws; files SURVIVE
```

Virtual filesystem in/out — pass `{'top.v': src}`, get files back. No disk I/O.
`Exit` carrying `files` is what makes self-correction possible: **a failed run still returns its log.**

All Yosys access goes through the single wrapper in `src/lib/yosys.ts`, which catches `Exit` and
returns `{ok, code, log, files}`. Do not call `runYosys` directly from a tool.

### NitroStack

- Tools **return a raw object.** The framework wraps it in content blocks. Never return `{content:[...]}`.
- Resources **do** return their own `{contents:[...]}` envelope. Asymmetric with tools — easy to trip on.
- Import as `import { ToolDecorator as Tool }` — bare `Tool` is the class, not the decorator.
- Long calls: `taskSupport: 'optional'` + `ctx.task?.updateProgress(msg)`. There are **no MCP progress
  notifications**, only `notifications/tasks/status`. A 30s call works (Streamable HTTP holds the POST
  open), it's just silent.
- Endpoint is `/mcp`, Streamable HTTP. `HttpServerTransport` is exported but vestigial — never wire it.

### NVIDIA NIM

OpenAI-compatible; stock `openai` SDK with only `baseURL` changed.

```ts
new OpenAI({ baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NVIDIA_API_KEY });
// model:    'qwen/qwen3-coder-480b-a35b-instruct'          — tool calling, 262K ctx
// fallback: 'nvidia/llama-3.3-nemotron-super-49b-v1.5'     — documented tool-call path
```

~40 RPM rate limit. Cache aggressively and back off. ChipNeMo is research-only and **not callable** —
keep it out of the code and off the slides.

## Landmines

Every one of these is verified and will cost hours if forgotten.

**Yosys — verification (`sat`)**
- **`sim` DOES NOT EXIST** in the YoWASP build. Neither does `qbfsat`. `sat`, `miter`, `chformal`,
  `async2sync`, `clk2fflogic`, `write_smt2` all do. Verified by probing `help`.
- **`flatten` before `sat` is mandatory** — else `ERROR: No SAT model available for cell <inst>`. SAT
  cannot descend into submodules. This is the #1 time-waster.
- **`async2sync` before `sat`** for clocked assertions.
- Verdict: exit **0** + `SAT proof finished - no model found: SUCCESS!` = pass. Exit **1** +
  `Called with -verify and proof did fail!` + counterexample trace = fail.
- **Assert cells are type `$check` until `async2sync` lowers them to `$assert`.** `t:$assert` silently
  matches **0 cells** before that pass — and a selection matching nothing means `chformal -remove`
  deletes *every* assert, after which `sat` proves an empty design and reports **SUCCESS**. A wrong
  selection therefore reads as "all tests pass". Order matters: `async2sync` **then** `t:$assert`.
- **Always guard with `select -assert-count N t:$assert`** before `sat`. It errors on a bad selection
  instead of vacuously passing. This is the only thing standing between us and a demo that green-lights
  broken silicon.
- **`src` is best read from `write_json`** (`cells.<name>.attributes.src`, e.g. `tb.v:7.5-7.30`) — run it
  after `async2sync`. Labelled asserts (`a_bad: assert(...)`) keep their names through `opt`; unnamed
  ones become `$assert$<file>:<line>$<id>`, which also carries file:line. There is no JSON summary.
- **Per-assertion verdicts** need one `sat` run per assert, isolated via
  `chformal -remove t:$assert c:<keep> %d`. Cheap fast path: prove all together first; only isolate
  when that fails.
- **`read_verilog -sv -formal`** — without `-formal`, assertions are silently DISCARDED and the
  design arrives with zero asserts, which then proves vacuously. `-sv` alone is not enough.
- **Concurrent SVA is a SYNTAX ERROR.** `assert property (@(posedge clk) a |-> b)` fails with
  `syntax error, unexpected '@'` — SVA needs Verific, which the open-source build does not ship.
  **Only immediate assertions work**: `always @(posedge clk) if (!rst) a_name: assert (expr);`
  Implication is a plain `if`, never `|->` / `|=>`.
- **Assert on PORTS ONLY.** A hierarchical reference into the DUT (`dut.state`) aliases to a stale
  copy after `flatten` — Yosys keeps both `\dut.state` and `\dut.state_1`, and the testbench reads
  the wrong one. Silent wrong answers, not an error.
- **BMC starts from an ARBITRARY state.** Uninitialized regs are unconstrained, so reset must be
  *driven*, not assumed: `reg boot = 1'b0; wire rst = ~boot; always @(posedge clk) boot <= 1'b1;`
  An initialiser gives the reg an `init` attribute that SAT constrains. Guard regs (`past_rst`)
  must init to **0**, or they fire at cycle 1 before reset lands and fail a *correct* design.
- **Registered outputs lag state by one cycle.** Compare against the *previous* cycle's value, or a
  correct design fails.
- Testbenches are **modules with clk/rst inputs carrying `assert`**, not `initial`-block stimulus.
  There is no simulator: assertions are *proved over N cycles*, not exercised. No `$display` capture.

**Yosys — synthesis**
- **Never combine `-tech` with `-json`** — it emits invalid JSON (missing + trailing commas). Bucket
  cells ourselves by name prefix: `LUT*`, `FD*`, `RAMB*`, `DSP48*`.
- **`-tech` never produces area. Area comes only from `-liberty`.**
- **`dfflibmap` must precede `abc`**, or flip-flops land in `unknown_cell_area`.
- **Always pass `-top`** or `stat -json` never emits the `"design"` key.
- `"design"` is a **top-level sibling of `"modules"`**, not nested. With `-hierarchy`, numbers come
  back as **strings**.

**NitroStack — registration (all three cost a silent, clean-looking startup)**
- **`@Module({controllers})`, NOT `providers`.** Only classes in `controllers` are scanned for
  `@Tool`/`@Resource`/`@Prompt`. In `providers` they register in DI and expose **nothing** — the
  server boots happily and logs `initialized with 0 tools`. `providers` is for DI services only.
- **Every controller needs a CLASS-level decorator (`@Controller()`), even resource/prompt classes
  with no prefix.** TypeScript only emits `design:paramtypes` for a decorated class, so without it
  DI injects nothing and `this.<dep>` is `undefined` — and it fails at *call* time, not startup.
- **`@Widget('x')` requires `src/widgets/out/x.html` to exist at boot** or the server throws
  `Exported HTML for route 'x' not found`. `npm run build` (`nitrostack-cli build`) builds widgets
  **and** server; plain `npx tsc` does not.
- `.env` **overrides** code defaults (dotenv loads first), so `process.env.X ||= 'v'` in `index.ts`
  cannot fix a wrong value that is already set in `.env`. The starter ships
  `NITROSTACK_APP_MODE=openai` — change it in `.env`, not in code.

**NitroStack — deployment**
- **`nitrostack-cli start` HARD-OVERRIDES `PORT` to 3000 and ignores `process.env.PORT`.** The source
  is `const port = options.port || '3000'` (the `--port` *flag*, never the env var), then it spawns
  `node dist/index.js` with `PORT: port`. On a PaaS that assigns `PORT=8080` the server listens on
  3000, the health check hits 8080, and **the deploy fails with a green build log.** Verified.
  → **Production must run `node dist/index.js` directly.** `start:prod` does exactly that.
- **`package.json` must be at the repo ROOT.** NitroCloud's build script only checks depth 0 and 1
  (`[ -f package.json ]` / `[ -f */package.json ]`), and the unzipped archive is a `owner-repo-sha`
  wrapper dir — so a project one level down is invisible and the deploy aborts. `npm ci` also needs
  the real `package-lock.json` beside it, so a stub root package.json is not a fix.

**NitroStack / build**
- **`"moduleResolution": "bundler"`** in tsconfig. The shipped starter uses `"node"`, which *cannot*
  resolve `@yowasp/yosys` (exports-map only, no `main`). Certain breakage.
- **`HOST=0.0.0.0`** — defaults to `localhost`; in a container the server is a black hole.
- **`MCP_TRANSPORT_TYPE=http`** explicitly. `NODE_ENV=production` alone yields `dual`, which
  **disables sessions**.
- **`NITROSTACK_APP_MODE=universal`** — defaults to `openai`, which targets ChatGPT, not Claude.
- **Lazy-load the WASM**: `await import('@yowasp/yosys')` *inside* the handler, cached in a
  module-level singleton. Top-level import blows up startup (~54MB). Budget ≥1GB RAM.
- The server is **not bundled** (`build` = plain `npx tsc`; esbuild only touches widgets), so the
  `gen/*.wasm` assets are safe in `node_modules`. Do not add a server bundler.

**External**
- `search_ip` must use GitHub **repo** search (`/search/repositories`) — works unauthenticated.
  **Code search (`/search/code`) returns 401** and needs a PAT.
- Vendor `sky130.lib` (13MB) into the repo. Do not fetch it at runtime.

## Facts that must not regress into the demo

- **eFabless shut down March 2025.** Any chipIgnite/MPW pricing is dead. IHP (€7,300/mm²) is the live
  source. A judge in this space will catch a stale number instantly.
- **Artix-7 XC7A35T has 20,800 LUT6, not 5,200.** The common tables report *slices*; off by 4×. Cite
  DS180.
- **Stock Yosys cannot give Artix-7 Fmax** (synth only, no P&R). Real Fmax comes from nextpnr on
  ECP5/iCE40. Do not claim timing closure on Artix-7.

## Cost model

```
area_um2 = stat -liberty -> "area"        # real sky130 cell areas
die_mm2  = area_um2 / 1e6 / utilization   # util ~0.5-0.7
cost_eur = die_mm2 * 7300                 # IHP SG13G2 MPW, 40 samples
tiles    = ceil(area_um2 / 16000)         # TinyTapeout 160x100um tile
```

Cross-check to show on stage: 1 TT tile = 0.016mm² × €7,300 = €117 vs TT's ~€70/tile — same order; TT
is cheaper because it amortizes one die across hundreds of projects. **The reconciliation is a stronger
demo than either number alone.**

## Verification

The real test is the one judges run: point Claude at the live URL and drive the UART prompt.

```bash
claude mcp add --transport http silicon https://<url>/mcp
```

The critical assertion: **`simulate` on a deliberately broken UART must return `ok:false` with a
non-empty `assertions[]` carrying `src`.** That proves the pass/fail signal is real and not
self-graded — which is the entire claim of the project.
