# Research — Silicon Architect

Evidence base for the architecture in `CLAUDE.md`. Every claim is tagged:

- **VERIFIED** — checked against primary source: shipped `.d.ts`/`dist`, upstream C++ source, a live
  registry/API response, or a downloaded artifact. The method is stated.
- **UNCERTAIN** — single source, low-quality source, or user testimony. Do not put on a slide without
  re-checking.
- **NOT FOUND** — actively searched for and could not find. Absence is itself a finding.

Research date: 2026-07-17. Docs lied more than once, so primary sources were used throughout.

---

## 1. NitroStack

Method: downloaded and extracted `@nitrostack/core@1.0.13` and `@nitrostack/cli@1.0.14` from npm; read
the shipped `.d.ts`, compiled `dist/**/*.js`, and `templates/`. Cross-checked against docs.

### It is an MCP server framework, not an agent orchestrator — VERIFIED

This invalidates the proposal's central architecture box.

Real exports from `dist/core/index.d.ts`: `createServer`, `NitroStackServer`, `HttpServerTransport`,
`Tool`/`ToolDecorator`, `Resource`, `Prompt`, `Component`, `Widget`, `Module`, `DIContainer`,
`Injectable`/`Inject`, `UseGuards`, `Middleware`, `Interceptor`, `Pipe`/`Body`/`Validated`,
`ExceptionFilter`, `Cache`, `JWTModule`, `ApiKeyModule`, `OAuthModule`, `TaskManager`/`TaskContext`,
`InitialTool`.

**There are no agent, planner, or orchestration primitives.**

**No MCP client — VERIFIED.** Grepped the entire `@nitrostack/core` tarball for `agent|client|sampling|elicit`.
Only hit is `dist/auth/client.js` (OAuth client registration), unrelated. **NitroStack cannot consume
MCP servers.** Anything that needs to *call* an MCP server must be code we write.

### Packages — VERIFIED (npm/PyPI registry responses)

| Package | Version | Notes |
| --- | --- | --- |
| `nitrostack` | 1.0.85 | meta package |
| `@nitrostack/core` | 1.0.13 | decorators, DI, runtime |
| `@nitrostack/cli` | 1.0.14 | scaffolding, dev server |
| `@nitrostack/widgets` | 1.0.8 | React widget SDK — separate version line, watch for drift |
| `nitrostack` (PyPI) | 0.3.2 | "Python-idiomatic port"; 6 releases vs 85 on npm |

`@nitrostack/sdk` **does not exist** (404). License Apache-2.0. Repo:
https://github.com/nitrocloudofficial/nitrostack (~1.2k stars, last push 2026-07-14 — same day as the
npm releases). Core deps include `@modelcontextprotocol/sdk ^1.0.4`, express, zod, reflect-metadata.

### CLI — VERIFIED (listed `dist/commands/` in the published tarball)

Binary is **`nitrostack-cli`** (and `cli`), *not* `nitrostack`.

```
init <name> [--template <name>]   # typescript-starter | typescript-oauth | typescript-pizzaz
dev · build · start · generate <type> [name] · install · upgrade · cursor · generate-types
```

**`deploy` and `login` DO NOT EXIST — VERIFIED.** The docs page `/deployment/cloud` instructs you to
run `nitrostack login` / `nitrostack deploy`. The shipped CLI registers neither. **The docs document a
product the tooling does not implement.**

`build` = (1) `npm install` in `src/widgets` if needed → (2) esbuild each `app/**/page.tsx` →
`src/widgets/out/*.html` → (3) **plain `npx tsc`** for the server. **The server is never bundled** —
this is why our WASM assets are safe.

### Bootstrap — VERIFIED (from `templates/typescript-starter/`)

`McpApplicationFactory.create(AppModule)` takes **one arg: the root module class.** All config lives in
the `@McpApp` decorator. You do **not** construct a transport yourself.

```ts
// src/index.ts
import 'dotenv/config';
import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';

const server = await McpApplicationFactory.create(AppModule);
await server.start();
```

```ts
// src/app.module.ts   — note @McpApp self-references the class it decorates
@McpApp({
  module: AppModule,
  server: { name: 'silicon-architect', version: '1.0.0' },
  transport: { type: 'http', http: { port: 3000, host: '0.0.0.0' } },
})
@Module({ name: 'app', imports: [ConfigModule.forRoot(), YosysModule] })
export class AppModule {}
```

**Transport selection** (from `server.js` `start()`): `MCP_TRANSPORT_TYPE` wins (`stdio|http|dual`);
else `NODE_ENV=development`/unset → `stdio`, `production` → `dual`. **Sessions are enabled only in pure
`http` mode** (`enableSessions: transportType === 'http'`) — so `dual` silently costs you sessions.

Env vars: `PORT` (3000), **`HOST` (defaults `localhost`)**, `ENABLE_CORS`, `MCP_MAX_SESSIONS`,
`MCP_SESSION_TIMEOUT_MS` (30min *idle*, not request duration), `NITROSTACK_APP_MODE`, `NITRO_LOG_LEVEL`.

Endpoint `/mcp`, **Streamable HTTP** (2025-06-18 spec), session via `mcp-session-id` header. Legacy
`GET /sse` fallback exists for old clients. **`HttpServerTransport` is exported but `start()` never
instantiates it — vestigial. Do not wire it.**

### `@Tool` — VERIFIED

```ts
interface ToolOptions {
  name: string; title?: string; description: string;
  inputSchema: z.ZodSchema;          // Zod on the decorator, not raw JSON Schema
  outputSchema?: z.ZodSchema;
  annotations?: ToolAnnotations;     // destructiveHint, idempotentHint, readOnlyHint, openWorldHint
  metadata?: { category?, tags?, rateLimit?: { maxCalls, windowMs } };
  taskSupport?: 'required' | 'optional' | 'forbidden';   // default 'forbidden'
}
```

**Handlers return a RAW OBJECT.** The framework wraps it (`server.js` ~L557):
`{content:[{type:'text', text: typeof result === 'string' ? result : JSON.stringify(result,null,2)}]}`.
Throwing an `Error` yields `{content:[...], isError:true}`. Handler signature is `(input, ctx: ExecutionContext)`.

Import gotcha — the decorator is `ToolDecorator`; bare `Tool` is the *class*. Every template aliases:
`import { ToolDecorator as Tool }`.

Resources are asymmetric: they **do** return their own `{contents:[{uri, mimeType, text}]}` envelope.
Prompts return `{role, content: string}[]` — plain strings, not content blocks.

### Tasks — VERIFIED (this is the answer for 5–30s tool calls)

`taskSupport: 'optional'` → server returns `CreateTaskResult` immediately and runs the handler
fire-and-forget. `ctx.task` is then populated:

```ts
task?: { readonly taskId; readonly isCancelled;
         updateProgress(message: string): void;   // string only — NO percentage
         requestInput(message: string): void; throwIfCancelled(): void; }
```

Lifecycle `working → input_required | completed | failed | cancelled`. TTL 300000ms, poll 2000ms.

**No MCP progress notifications — VERIFIED.** Zero hits for `notifications/progress`/`progressToken`
in core. Only `notifications/tasks/status`. Tasks are **in-memory** (`TaskManager.tasks` is a Map) — do
not survive restart, need sticky sessions across replicas.

### Widgets — an MCP server can ship its own UI — VERIFIED

Materially good news: this puts our dashboard *inside* the judged artifact.

`src/widgets/` is a **separate Next.js 14 app** with its own `package.json`/`node_modules`.
`@Widget('route-name')` on a tool links it to `src/widgets/app/<route-name>/page.tsx`. At build,
esbuild bundles each page into a **single self-contained IIFE HTML file** (React inlined) at
`src/widgets/out/<name>.html`, served as an MCP **resource**. The tool's return value is passed as
`structuredContent` and reaches the widget via `window.openai.toolOutput`.

```tsx
'use client';
import { useTheme, useWidgetState, useWidgetSDK } from '@nitrostack/widgets';
export default function CostSheet() {
  const { getToolOutput } = useWidgetSDK();
  const data = getToolOutput<CostData>();
  if (!data) return <div>Loading...</div>;
}
```

**`NITROSTACK_APP_MODE`** switches conventions: `openai` (**default** — `_meta['openai/outputTemplate']`,
targets ChatGPT) | `mcp-app` (`_meta.ui.resourceUri`) | `universal` (both). **For Claude, set
`universal`.**

Known sharp edge: the widget esbuild step aliases react/react-dom to `src/widgets/node_modules` to dodge
a documented dual-React blank-render bug.

### tsconfig / ESM — VERIFIED, one required deviation

Starter ships `target/module: ES2022`, `moduleResolution: "node"`, `experimentalDecorators: true`,
`emitDecoratorMetadata: true`, `types: ["node"]`. Core is `"type": "module"`, ESM-only, `.js` import
extensions, legacy decorators + `reflect-metadata`. `engines: node >=18`.

**`@yowasp/yosys` will NOT typecheck as shipped — VERIFIED.** It has `exports` but **no `main`**;
`moduleResolution: "node"` (node10) ignores `exports` and looks for `main` → *"Cannot find module
'@yowasp/yosys'"*. **Fix: `"moduleResolution": "bundler"`** (keeps `module: ES2022`). Runtime is fine
either way — Node's ESM loader reads `exports` correctly.

### NitroCloud deployment — NOT FOUND

| Claim | Status |
| --- | --- |
| `nitrostack login` / `deploy` | **NOT FOUND** in CLI 1.0.14 |
| `nitrostack.json` config schema | **NOT FOUND** (zero hits across cli+core dist and templates) |
| Dockerfile in templates | **NOT FOUND** (docs prose only) |
| `cloud.nitrostack.ai` referenced in code | **NOT FOUND** |
| Deployed URL shape | **NOT FOUND** |
| Memory / timeout / cold start / FS writability | **NOT FOUND** — undocumented anywhere |

`cloud.nitrostack.ai` returns 200 and advertises deploy-on-push, scale-to-zero, custom domains, and a
"Free 100M Token" tier; docs push to `nitrocloud.ai`. **But nothing in the shipped packages implements
deployment.** Deploy is presumably git-push/dashboard-based. **Unverified — resolve before writing code.**

Verified fallback is Docker (from `/deployment/docker`), which must be amended — the docs version omits
`HOST` and the widget bundles:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
COPY src/widgets/out ./src/widgets/out
ENV NODE_ENV=production MCP_TRANSPORT_TYPE=http HOST=0.0.0.0 PORT=3000 NITROSTACK_APP_MODE=universal
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Filesystem is writable — VERIFIED.** It's a plain Node process, not a serverless FaaS; the shipped
`calculator.tools.ts` does `fs.mkdirSync(...)`/`fs.writeFileSync`. Moot anyway — YoWASP uses a virtual FS.

**No request timeout in the framework — VERIFIED.** Streamable HTTP holds the POST open; 5–30s calls
are fine.

### Maturity signals (context for trusting `.d.ts` over docs)

1.2k stars but all three packages published the same day; `@nitrostack/widgets` on a separate version
line; a vestigial unused `HttpServerTransport` export; a decorator export (`Tool`) that collides with a
class so every template aliases it; docs documenting nonexistent commands; the hackathon page
referencing `npx nitrostack-test`, **which does not exist on npm**. **Treat the `.d.ts` as truth and the
docs as aspiration.**

---

## 2. YoWASP — the EDA engine

Method: read `lib/api.d.ts` and `package.json` streamed directly out of the published tarballs.

### Packages — VERIFIED (npm registry)

| Package | Version |
| --- | --- |
| `@yowasp/yosys` | 0.67.1189 (`release` tag) |
| `@yowasp/nextpnr-ecp5` | 0.10.752 |
| `@yowasp/nextpnr-ice40` | 0.10.0.0 |
| `@yowasp/runtime` | 11.0.72 |

**`@yowasp/verilator` and `@yowasp/iverilog` DO NOT EXIST — VERIFIED** (registry 404).
**`@yowasp/nextpnr-xilinx` does not exist either.** This is why Verilator is cut and why Artix-7 has no
Fmax path.

### API — VERIFIED (`lib/api.d.ts`, identical shape across packages)

```ts
type Tree = { [name: string]: Tree | string | Uint8Array };
type RunOptions = { stdin?; stdout?; stderr?; decodeASCII?; synchronously?; fetchProgress? };
type Command = (args?: string[], files?: Tree, options?: RunOptions) => Promise<Tree> | Tree | undefined;
class Exit extends Error { code: number; files: Tree; }

export const runYosys: Command;
export const runNextpnrEcp5: Command;   // + runEcppack, runEcppll, runEcpbram, ...
export const version: string;
```

Three properties that make the whole hosted design work:

1. **Virtual filesystem** — `filesIn` maps names→contents (string or Uint8Array, recursive for dirs),
   placed at the root of a virtual FS; `filesOut` is the FS state after exit. **No disk I/O.**
2. **`Exit` carries `code` AND `files`** — a *failed* run still returns its log. This is the genuine
   pass/fail signal, and it is what makes self-correction possible.
3. **Not bundled by NitroStack** — `gen/*.wasm` are separate assets that esbuild *would* drop, but the
   server build is plain `tsc`, so they survive in `node_modules`.

`package.json`: `"type": "module"`, `exports: { types: './lib/api.d.ts', default: './gen/bundle.js' }`,
**no `main`** (hence the `moduleResolution` fix). Contents: `gen/bundle.js`, `gen/yosys.core{,2,3,4}.wasm`,
`gen/yosys-resources.0.tar`. Built via jco (WASI component) + esbuild.

---

## 3. Yosys behaviour

Method: read upstream C++ source (`passes/cmds/stat.cc`, `passes/sat/sim.cc`) rather than docs — two
doc summaries were wrong.

### `stat -json` shape — VERIFIED

```json
{ "creator": "Yosys 0.66 ...", "invocation": "stat -json ",
  "modules": { "\\top": { "num_wires":12, "num_cells":27,
                          "area":128.456, "sequential_area":40.03,   // ONLY with -liberty
                          "num_cells_by_type": {"$_AND_":4, "LUT4":9} } },
  "design": { } }
```

- **`"design"` is a TOP-LEVEL sibling of `"modules"`, not nested** (`stat.cc` ~L1018 closes `"modules"`
  before emitting it). A WebFetch summary claimed otherwise; the code disagrees.
- **`"design"` is only emitted when a top module is known.** **Always pass `-top`.**
- With `-hierarchy`, every scalar becomes `{count, area, local_count, local_area}` and **the numbers are
  STRINGS** — parse `int(x.count)`.

### Bugs to code around — VERIFIED in source

- **`-tech` + `-json` emits INVALID JSON.** `num_submodules_by_type` closes without a comma, then
  `estimated_num_lc` is appended with a *trailing* comma. `JSON.parse` throws. **Never combine them.**
- **`stat -json -tech xilinx` without `-hierarchy` silently emits nothing extra** — no LC estimate, no
  error.
- **An unsupported `-tech` value is silently ignored** in JSON mode (validity check is guarded by
  `&& !json_mode`).
- **`-tech` never produces area.** It only selects `estimate_xilinx_lc()` / `cmos_transistor_count()`.
  There is a stub comment `// additional_cell_area` with **no code after it**. **Area comes only from
  `-liberty`.**

Workaround: skip `-tech`; bucket `num_cells_by_type` by name prefix ourselves (`LUT*`, `FD*`, `RAMB*`,
`DSP48*` for Xilinx; `SB_LUT4`, `SB_DFF*`, `SB_RAM40_4K` for iCE40).

Bonus — `stat` also writes scratchpad values (`stat.num_cells`, `stat.area`, ...) readable via
`scratchpad -get stat.area`.

Extraction (Yosys writes JSON to the log stream, mixed with banner text — isolate with `tee -o`):

```bash
yosys -p 'read_verilog top.v; synth -top top; tee -o stat.json stat -json -top top' -q
```

### `sim` pass — the Verilator replacement — VERIFIED (`passes/sat/sim.cc`)

Lives at `passes/sat/sim.cc` (not `passes/sim/`).

```
sim -clock clk -resetn rst_n -n 200 -assert -vcd wave.vcd -summary summary.json top
```

Options: `-vcd` / `-fst` / `-aiw`, `-clock`/`-clockn`, `-reset`/`-resetn`, `-rstlen` (1), `-n` (20),
`-zinit`, `-timescale`, `-r <file>` (replay FST/VCD/AIW/WIT/.yw stimulus), `-w` (writeback), `-a`,
`-assert`, `-summary <file>`.

- **`-assert` → `serious_asserts = true`** (L2932) → on a failed assert, `log_error("Assertion %s.%s
  (%s) failed.\n", ...)` (L950-953) → **non-zero exit → YoWASP throws `Exit{code, files}`.** This is the
  genuine pass/fail signal.
- **`-summary` writes machine-readable JSON** (L2132+):
  `{version, generator, steps, top, assertions:[{step, type, path, src}], display_output:[{step, path, src}]}`.

**Assertions come back structured, with `src` (source file:line), and `display_output` captures
`$display`.** For an agent repair loop this is *better* than a Verilator log — the model gets the
failing line directly instead of scraping text.

### Synthesis targets — VERIFIED (recursive tree listing, v0.67)

`achronix, analogdevices, anlogic, coolrunner2, easic, efinix, fabulous, gatemate, gowin, greenpak4,
ice40, intel, intel_alm, lattice, microchip, nanoxplore, quicklogic, sf2, xilinx`

- **There is no `synth_sky130`** and no `techlibs/sky130`. The ASIC path is `read_liberty` + `abc -liberty`.
- `synth_xilinx -family xc7` is stock — **synthesis only, no P&R, no timing, no bitstream.**
- `synth_ecp5` **survives as a wrapper** inside `techlibs/lattice/synth_lattice.cc` (≡ `synth_lattice
  -family ecp5`) even though `techlibs/ecp5/` was removed after 0.44. An initial conclusion that it was
  gone was **wrong** — corrected by reading the source.
- iCE40 and ECP5 are the only targets with a complete stock open flow (yosys → nextpnr → icepack/ecppack).

### Fmax — VERIFIED

**Yosys reports no timing; `synth_xilinx` does no timing analysis.** Fmax comes from **nextpnr's
post-route STA**, available for iCE40, ECP5, Nexus, Gowin, MachXO2. **Artix-7 only via openXC7 /
nextpnr-xilinx** — a separate repo needing `prjxray-db`, **not upstream, and not in WASM.**

`--report <file>` JSON (from `common/kernel/report.cc` `writeJsonReport()`):

```json
{ "utilization": { "ICESTORM_LC": {"used":1234,"available":5280} },
  "fmax": { "clk": {"achieved":62.35, "constraint":50.0} },   // MHz
  "critical_paths": [...], "detailed_net_timings": [...] }
```

`--freq` sets the *target*; nextpnr reports **achieved** regardless — **read `achieved`, not
`constraint`.** This is the single best artifact for the cost sheet: real used/available per resource
plus real MHz, in valid JSON.

---

## 4. NVIDIA build.nvidia.com / NIM

Method: `docs.api.nvidia.com` (official API reference) + developer forums + research.nvidia.com.
`build.nvidia.com` itself timed out. Several SEO blogs contradicted each other on the free tier and were
**excluded as sources** rather than laundered into looking verified.

### Endpoint — VERIFIED

OpenAI-compatible. `POST https://integrate.api.nvidia.com/v1/chat/completions`, credential type
**Bearer**, request schema explicitly labeled *"OpenAI ChatCompletionRequest"*.

- base_url `https://integrate.api.nvidia.com/v1`; `Authorization: Bearer nvapi-...`
- Keys at https://build.nvidia.com/settings/api-keys (free NVIDIA Developer Program signup)
- **The stock `openai` SDK works directly** — only `base_url`/`api_key` change.
- Documented params: `model, messages, max_tokens (≥1, default 1024), temperature (0–1, default 0.5),
  top_p, stream, stop, frequency_penalty, presence_penalty, seed`. **`402 Payment Required` is a
  documented response** — the credit-exhaustion path.

### Model IDs — VERIFIED on `docs.api.nvidia.com/nim/reference/llm-apis`

| Model ID | Note |
| --- | --- |
| `qwen/qwen3-coder-480b-a35b-instruct` | **Primary.** 480B MoE/35B active, 262K ctx, function calling + `tool_choice` |
| `qwen/qwen2.5-coder-32b-instruct` | cheap, 32K ctx |
| `deepseek-ai/deepseek-v4-pro` / `-flash` | current DeepSeek entries |
| `moonshotai/kimi-k2.6` | 1T MoE/32B active, agentic long-horizon coding |
| `openai/gpt-oss-120b` / `-20b` | present |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | **Fallback** — documented tool-call example, 128K ctx |
| `google/codegemma-7b` | schema *default*, but weak — VerilogEval-tier baseline only |

**Did not verify:** `deepseek-coder-33b`/`6.7b` are **not** in the current catalog (superseded by v4).

### Tool calling — VERIFIED per-model, NOT uniform

Confirmed for `nvidia/llama-3.3-nemotron-super-49b-v1.5` (documented `calculate_tip` example, post-trained
w/ iterative DPO for tool calling), `moonshotai/kimi-k2.6`, `qwen/qwen3-coder-480b-a35b-instruct`.

⚠️ **The generic `create_chat_completion` schema page does not document `tools`/`tool_choice` at all.**
Tool support is per-model, not endpoint-wide. **Probe the chosen model with a trivial tool call before
committing the MCP loop to it.**

### Chip/EDA-specific — VERIFIED

- **ChipNeMo is NOT publicly callable. Research-only.** NVIDIA's own blog states it is *"not slated for
  commercial release"*; trained on NVIDIA-proprietary chip data. No catalog entry. **Do not build a demo
  narrative around it.**
- **No Verilog/RTL/EDA NIM exists in the catalog.** Closest is `nvidia/usdcode` (OpenUSD, not HDL).
  **This gap is our opening.**

### Verilog capability — UNCERTAIN

**No VerilogEval numbers exist for Qwen3-Coder or DeepSeek-V4.** Published data is a generation behind
([Revisiting VerilogEval, arXiv 2408.11053](https://arxiv.org/html/2408.11053v2), TODAES 2025): GPT-4o
**63%** spec-to-RTL, Llama-3.1-405B **58%**, RTL-Coder-6.7B **37%**.

"Qwen3-Coder is good at Verilog" is a **reasonable inference from general coding strength, not a measured
fact.** We run Yosys — **we have the oracle the papers use.** Benchmark 2–3 candidates on our own harness
rather than trusting a coding leaderboard as a Verilog proxy. The ~63% ceiling is exactly the gap a
compile-and-repair loop closes, which is the project's thesis.

### Limits — UNCERTAIN

- **~40 RPM baseline, ~200 RPM on request.** No official docs page states this. Evidence is ~10 distinct
  forum threads titled "Request for NVIDIA NIM API Rate Limit Increase (40 → 200 RPM)" with developers
  reporting 429s at 40. Consistent testimony + an established request process, **not a published SLA.**
  **40 RPM is a real constraint on a repair loop** — request the bump early.
- **Free tier: 1000 credits on signup; business email → +4000 (5000 total) + 90-day AI Enterprise.**
  Forum-sourced ([thread 306633](https://forums.developer.nvidia.com/t/api-credits-for-build-nvidia-com/306633)),
  not on a canonical docs page. **Verify in the dashboard.**

### Retrieval NIMs — VERIFIED

`/v1/embeddings` (OpenAI-compatible) and `/v1/ranking` (cross-encoder, **not** OpenAI-shaped).
Recommended pair: `nvidia/llama-3.2-nv-embedqa-1b-v2` (8192 tok) + `nvidia/llama-3.2-nv-rerankqa-1b-v2`.
**Prefer the 8192-tok llama-3.2 embedder over `nv-embedqa-e5-v5` (512 tok max) — 512 will shred spec
tables.**

---

## 5. Cost model

### ASIC area — VERIFIED by download

`synth_sky130` does not exist. The path is `read_liberty` + `dfflibmap` + `abc -liberty` + `stat -liberty`.

**The .lib is a single self-contained 13MB file — one curl, no open_pdks build, no Docker:**

```bash
curl -sL -o sky130_hd.lib \
  https://raw.githubusercontent.com/efabless/skywater-pdk-libs-sky130_fd_sc_hd/master/timing/sky130_fd_sc_hd__tt_025C_1v80.lib
```

- 13MB, `library ("sky130_fd_sc_hd__tt_025C_1v80")`, `technology("cmos")`, **428 cells carry `area :`**
- ⚠️ The `google/skywater-pdk-libs-*` path **404s**; the **`efabless/` mirror resolves** (the GitHub org
  outlives the company — see below)
- **Units confirmed µm²** by cross-checking known geometry (cell height 2.72µm): `inv_1` = 3.7536 =
  2.72×1.38 ✓; `dfxtp_1` = 20.0192 = 2.72×7.36 ✓

```bash
yosys -p 'read_verilog design.v; hierarchy -check -top top; synth -top top;
          dfflibmap -liberty sky130_hd.lib; abc -liberty sky130_hd.lib; opt_clean;
          tee -o area.json stat -json -top top -liberty sky130_hd.lib'
```

**`dfflibmap` before `abc` is required** — abc maps combinational logic only; without it FFs stay as
`$_DFF_*` and land in `unknown_cell_area`. **This is the most credible number in the project — real
foundry data, not an estimate.**

### eFabless is dead — VERIFIED. Do not cite chipIgnite.

**eFabless shut down March 2025** ("unable to complete our latest funding round" — CEO Mike Wishart),
taking chipIgnite with it and stranding TT08/TT09.
([Hackster](https://www.hackster.io/news/open-source-silicon-project-tiny-tapeout-hits-trouble-as-efabless-shuts-its-doors-9ac7fab1649d),
[eeNews](https://www.eenewseurope.com/en/tiny-tapeout-hit-as-efabless-closes/))
**Any efabless $ figure is stale — a judge who follows this space would catch it instantly.**
TinyTapeout survived and migrated off sky130 to **IHP sg13g2 (130nm)**; current shuttles `ttihp25a/b`,
`ttihp26a`.

### Citable reference numbers

| Quantity | Value | Status |
| --- | --- | --- |
| **IHP SG13G2 MPW** | **€7,300 / mm²**, 40 diced samples, min 0.8mm² | **VERIFIED** — [IHP price list](https://www.ihp-microelectronics.com/services/research-and-prototyping-service/mpw-prototyping-service/schedule-price-list) |
| IHP SG13S | €6,300 / mm² | VERIFIED, same source |
| TT tile size | ~160×100µm = **0.016 mm²** | VERIFIED — [TT FAQ](https://tinytapeout.com/faq/) ("~1000 digital logic gates") |
| TT price/tile | ~€70/tile (sky130 era) | **UNCERTAIN** — live price is calculator-driven |
| TT analog pins | €40/pin first 2, €100/pin after | **UNCERTAIN** (search-sourced) |

```
area_um2 = stat -liberty -> "area"
die_mm2  = area_um2 / 1e6 / utilization    # util ~0.5-0.7 typical
cost_eur = die_mm2 * 7300                  # IHP SG13G2 MPW, 40 samples
tiles    = ceil(area_um2 / 16000)          # TT tile
```

**Cross-check:** 1 TT tile = 0.016mm² × €7,300 = **€117** vs TT's ~€70/tile. Same order of magnitude —
TT is cheaper because it amortizes one die across hundreds of projects. **Showing the reconciliation is a
stronger demo than either number alone.**

Prefer this **MPW €/mm²** framing over textbook wafer-cost/yield math (Murphy/Bose-Einstein). At 130nm
hobby-scale, yield ≈ 1 and the wafer-price inputs are not publicly citable — we'd be inventing numbers.
The IHP price list is real, current, and quotable.

### FPGA part fit — VERIFIED

⚠️ **Search results and SEO tables label these as "LUTs" — they are SLICES.** Each 7-series slice = 4
LUT6 + 8 FFs. **Off by 4×.**

| Part | Logic cells | Slices | **LUT6** | FFs |
| --- | --- | --- | --- | --- |
| XC7A35T | 33,280 | 5,200 | **20,800** | 41,600 |
| XC7A50T | 52,160 | 8,150 | **32,600** | 65,200 |
| XC7A100T | 101,440 | 15,850 | **63,400** | 126,800 |
| XC7A200T | 215,360 | 33,650 | **134,600** | 269,200 |

Cite **DS180, 7 Series Overview** ([Mouser mirror](https://www.mouser.com/datasheet/2/903/ds180_7Series_Overview-1591537.pdf)),
not the SEO tables. Fit rule: `LUT_used <= LUT6 * 0.8` **and** FF/BRAM/DSP all fit → cheapest. A design
>80% LUT occupancy typically won't route or close timing.

**FPGA $ prices: UNCERTAIN — none verified.** No stable public API. Recommended: a **hardcoded snapshot
table with a visible "prices as of <date>, source Digi-Key" caption.** Judges accept a dated snapshot;
they do not accept an unsourced number.

**Power: UNCERTAIN — recommend against.** Yosys has no power estimation. The liberty file *does* carry
`leakage_power` (`leakage_power_unit : "1nW"`), so **static leakage** is computable by summing over
`num_cells_by_type` — honest and cheap. **Dynamic power needs switching activity** (VCD toggle counts)
and is a large lift. Report leakage only, labeled "static leakage only," or cut power entirely.

---

## 6. Miscellaneous verified facts

- **GitHub repo search works unauthenticated** (`/search/repositories?q=uart+verilog` → 2006 results:
  `alexforencich/verilog-uart` ★574, `jamieiles/uart` ★201, `ben-marshall/uart` ★190).
  **Code search (`/search/code`) returns 401** — needs a PAT. `search_ip` must use repo search.
- Local machine has **none** of yosys/verilator/nextpnr installed. Node v26.4.0, npm 12.0.1, Python 3.14.6.
- Arch packages (if ever needed locally): `yosys` 0.66 and `verilator` 5.050 and `iverilog` 13.0 in
  **extra**; **`nextpnr` is AUR-only**. The `oss-cad-suite` tarball
  (`https://github.com/YosysHQ/oss-cad-suite-build/releases`, daily builds) is faster and more reliable —
  bundles yosys, all nextpnr archs, icestorm, trellis, GHDL, iverilog, verilator, and a bundled Python.
  Caveat: it shadows system tools while sourced — use a dedicated shell, not `.bashrc`.

---

## 7. The hackathon itself — UNRESOLVED

**Blocking question. "Must be live on NitroCloud" drives the entire architecture.**

Found at https://nitrostack.ai/hackathon (200, with schema.org Event markup):

- **"NitroStack MCP Hackathon — 48-Hour Build Sprint"**
- Organizer: **NitroStack only. No sponsor/partner in the page HTML.**
- Dates: register Apr 10 → sprint **Apr 17–19, 2026** → winners Apr 20. **Already past** (today 2026-07-17).
- Prizes: $5,000 grand + $3,000 category (Integration, Architecture, Creativity)
- Requirements: public GitHub repo, **live deployment on NitroCloud** — *"judges will test your endpoint
  directly, local-only projects receive zero points"* — real integrations, not mocks.

**"Weekan Enterprise": NOT FOUND.** Grepped the raw hackathon page HTML for `weekan` — zero matches.
Searches for `"Weekan" nitrostack hackathon` and `"Wekan Enterprise" MCP hackathon 2026` returned nothing
relevant. Nearest match is **Wekan**, an unrelated open-source kanban board.

Three possibilities, indistinguishable from public data: (a) a newer co-hosted event not yet indexed;
(b) a misspelling; (c) a mistake. **The public page is for a past event — if there's a live invite for a
Weekan-hosted one, it is a different event than anything public. Ask the organizer directly for the rules
page, the deadline, and the deploy target.**

---

## Sources

**NitroStack** — [site](https://nitrostack.ai/) · [hackathon](https://nitrostack.ai/hackathon) ·
[GitHub](https://github.com/nitrocloudofficial/nitrostack) ·
[npm core](https://www.npmjs.com/package/@nitrostack/core) · [npm cli](https://www.npmjs.com/package/@nitrostack/cli) ·
[PyPI](https://pypi.org/project/nitrostack/) · [NitroCloud](https://cloud.nitrostack.ai)

**YoWASP** — [yowasp.org](https://yowasp.org/) · [YoWASP/yosys](https://github.com/YoWASP/yosys) ·
npm `@yowasp/yosys`, `@yowasp/nextpnr-ecp5`, `@yowasp/runtime`

**Yosys/nextpnr** — [stat.cc](https://github.com/YosysHQ/yosys/blob/main/passes/cmds/stat.cc) ·
[sim.cc](https://github.com/YosysHQ/yosys/blob/main/passes/sat/sim.cc) ·
[synth_lattice.cc](https://github.com/YosysHQ/yosys/blob/v0.67/techlibs/lattice/synth_lattice.cc) ·
[nextpnr report.cc](https://github.com/YosysHQ/nextpnr/blob/master/common/kernel/report.cc) ·
[nextpnr command.cc](https://github.com/YosysHQ/nextpnr/blob/master/common/kernel/command.cc) ·
[oss-cad-suite](https://github.com/YosysHQ/oss-cad-suite-build/releases) · [openXC7](https://github.com/openXC7/nextpnr-xilinx)

**NVIDIA** — [docs.api.nvidia.com](https://docs.api.nvidia.com/) ·
[chat completions](https://docs.api.nvidia.com/nim/reference/create_chat_completion_v1_chat_completions_post) ·
[LLM APIs model list](https://docs.api.nvidia.com/nim/reference/llm-apis) ·
[retrieval APIs](https://docs.api.nvidia.com/nim/reference/retrieval-apis) ·
[ChipNeMo](https://research.nvidia.com/publication/2023-10_chipnemo-domain-adapted-llms-chip-design) ·
[Silicon Volley blog](https://blogs.nvidia.com/blog/llm-semiconductors-chip-nemo/) ·
[credits thread](https://forums.developer.nvidia.com/t/api-credits-for-build-nvidia-com/306633) ·
[rate limit thread](https://forums.developer.nvidia.com/t/nvidia-nim-api-rate-limit-increase-request-40-200-rpm/372485)

**Cost** — [IHP MPW price list](https://www.ihp-microelectronics.com/services/research-and-prototyping-service/mpw-prototyping-service/schedule-price-list) ·
[TinyTapeout FAQ](https://tinytapeout.com/faq/) · [TT calculator](https://app.tinytapeout.com/calculator) ·
[sky130 liberty](https://github.com/efabless/skywater-pdk-libs-sky130_fd_sc_hd) ·
[Xilinx DS180](https://www.mouser.com/datasheet/2/903/ds180_7Series_Overview-1591537.pdf) ·
[eFabless shutdown](https://www.hackster.io/news/open-source-silicon-project-tiny-tapeout-hits-trouble-as-efabless-shuts-its-doors-9ac7fab1649d)

**Benchmarks** — [Revisiting VerilogEval (arXiv 2408.11053)](https://arxiv.org/html/2408.11053v2) ·
[TuRTLe (arXiv 2504.01986)](https://arxiv.org/pdf/2504.01986)
