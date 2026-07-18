# ⚡ Silicon Architect

**An autonomous AI hardware architect, exposed as an MCP server.** Natural-language spec in —
formally verified RTL and a costed engineering report out.

Every number this server reports comes from a real EDA tool run: **Yosys 0.64** and **nextpnr**,
compiled to WASM and running in-process. No estimates, no mock data, no shelling out.

> **MCP as a control plane, not a data connector.** The model chooses which EDA tool to call next
> based on what the last tool actually returned. A failed proof is *data* — it comes back with the
> counterexample and the failing source line, and the model repairs the RTL and re-proves.

## Try it

```bash
claude mcp add --transport http silicon https://<your-deploy>/mcp
```

Then ask for the thing this was built to do:

> Design a UART transmitter for sky130 at 100MHz. Prove it, synthesize it, and cost it.

The server is **self-sufficient** — it needs no client of ours. Point your own Claude at `/mcp` and
it designs hardware, rendering the report inline via the bundled widget.

## What it actually does

| Tool | What it really runs |
|---|---|
| `search_ip` | GitHub repo search for prior-art IP cores |
| `write_rtl` | `read_verilog` + `hierarchy -check`; returns parsed module interfaces |
| `simulate` | **`sat -verify -prove-asserts -seq N`** — bounded model checking |
| `synthesize` | `synth` + `dfflibmap` + `abc` + `stat -liberty` → **real µm²** |
| `place_and_route` | **nextpnr** — real placement, routing, achieved Fmax |
| `cost_sheet` | real area → die area → IHP SG13G2 MPW pricing |
| `design_report` | the five reports: RTL, Verification, Synthesis, Summary, Cost |
| `list_designs` | every design in the session |

Plus **5 resources** (`silicon://targets`, `silicon://cost-model`, `silicon://toolchain`,
`silicon://designs`, `silicon://design/{id}/report`), **3 prompts** (`design_chip`, `verify_design`,
`cost_review`), a **`design-report` widget**, and **2 health checks**.

## Verification is a proof, not a vibe

`simulate` does not simulate. It **proves** each assertion against *all possible inputs* for N
cycles, and on failure returns a concrete counterexample. The signal is real and not self-graded —
here is the same testbench against a one-character RTL difference:

| RTL | Result |
|---|---|
| start bit `1'b0` (correct) | `ok:true` — 2/2 assertions **proved** |
| start bit `1'b1` (broken) | `ok:false` — `a_start_low` **failed** at `tb.v:11.48-11.80`, with counterexample. `a_idle_high` still proves. |

That is precise fault localisation, not a blanket red light.

### Writing a testbench that works here

The testbench is a **module with clk/rst inputs** carrying **immediate assertions**:

```verilog
module tb (input clk, input tx_start, input [7:0] tx_data);
  reg boot = 1'b0;                       // BMC starts from an ARBITRARY state:
  wire rst = ~boot;                      // reset must be DRIVEN, not assumed.
  always @(posedge clk) boot <= 1'b1;

  wire tx, tx_busy;
  uart_tx dut (.clk(clk), .rst(rst), .tx_start(tx_start),
               .tx_data(tx_data), .tx(tx), .tx_busy(tx_busy));

  reg past_rst = 1'b0;                   // guards init LOW, or they fire at cycle 1
  always @(posedge clk) past_rst <= rst; // before reset lands and fail a CORRECT design.

  always @(posedge clk)
    if (past_rst) a_idle_high: assert (tx == 1'b1);
endmodule
```

Three rules, each learned the hard way (see `CLAUDE.md`):

- **No concurrent SVA.** `assert property (@(posedge clk) a |-> b)` is a **syntax error** — SVA needs
  Verific, which the open-source Yosys does not ship. Use immediate `assert` in an `always` block;
  express implication with a plain `if`.
- **Assert on ports only.** A hierarchical reference into the DUT (`dut.state`) aliases to a stale
  copy after `flatten` and silently reads the wrong signal.
- **Registered outputs lag state by one cycle.** Compare against the previous cycle's value.

There is no simulator, so there is no `$display` and no stimulus `initial` block.

## Honest limits

This server states these itself, in `silicon://toolchain` and in the reports:

- **No Artix-7 Fmax.** `synth_xilinx` is synthesis-only — no P&R, no timing. Utilization and part fit
  are real; **timing closure is not claimed.** Real Fmax needs nextpnr → ECP5/iCE40.
- **No power.** Yosys has no power estimation. Omitted rather than invented.
- **Verification is bounded.** A proof holds for N cycles, not for all time.
- **Zero assertions = FAIL, not pass.** BMC of nothing succeeds vacuously.
- **Cost needs real area.** `cost_sheet` throws rather than estimate; only `synthesize(sky130)`
  produces area.

## Cost model

```
area_um2 = stat -liberty -> "area"      # real sky130 cell areas (428 cells, vendored .lib)
die_mm2  = area_um2 / 1e6 / utilization # util ~0.5-0.7
cost_eur = die_mm2 * 7300               # IHP SG13G2 MPW, 40 samples
```

Cross-checked against TinyTapeout: 1 TT tile = 0.016 mm² × €7,300 = **€116.80** vs TT's **~€70/tile**
— same order; TT is cheaper because it amortizes one die across hundreds of projects. *Two
independent sources agreeing is a stronger claim than either alone.*

> **eFabless shut down in March 2025.** Any chipIgnite/MPW pricing is dead. IHP is the live source.

## Run it

```bash
npm install
npm run build          # builds BOTH the server (tsc) and the widget (next export)
npm start              # http://0.0.0.0:3000/mcp
```

```bash
npm run verify         # 22 in-process checks against real Yosys
npm run verify:mcp     # 28 checks over the live HTTP endpoint (server must be running)
```

### Deployment

**No configuration is required.** No API keys, no external services, no `.env`. Push and deploy —
`src/index.ts` applies every setting below on its own, and `.env` is gitignored so it never reaches
the host.

| Variable | Value | Why | Set by |
|---|---|---|---|
| `MCP_TRANSPORT_TYPE` | `http` | `NODE_ENV=production` alone yields `dual`, which **disables sessions** | `start:prod` |
| `HOST` | `0.0.0.0` | defaults to `localhost` — in a container that is a black hole | `index.ts` |
| `PORT` | platform's, else `3000` | | platform |
| `NITROSTACK_APP_MODE` | `universal` | default `openai` targets ChatGPT, not Claude | `index.ts` |
| `OAUTH_REQUIRED` | unset | auth off so a judge can connect; set `true` + a verifier to enforce | — |
| `MCP_SESSION_TIMEOUT_MS` | `7200000` | keep Claude sessions alive for two idle hours | `index.ts` |
| `MCP_MAX_SESSIONS` | `100` | bound memory on the public endpoint | `index.ts` |

> ⚠️ **Never run `nitrostack-cli start` in production.** It reads the `--port` *flag* only
> (`const port = options.port || '3000'`) and then **overrides `PORT` to 3000**, discarding the one
> the platform assigned — so the server listens on 3000, the health check hits 8080, and the deploy
> fails while the build log stays green. `npm start` / `start:prod` run `node dist/index.js`
> directly and honour `PORT`. (`start:cli` keeps the CLI for local use.)

If you do commit a `.env`, it **overrides** all of the above — check it first.

**Budget ≥1GB RAM.** The Yosys WASM is ~54MB and is lazy-loaded on first use (preloaded in the
background at boot so a judge's first call isn't the slow one). `assets/sky130.lib` (13MB) is
**vendored** — never fetched at runtime.

## Layout

```
src/
  lib/
    yosys.ts          # the ONLY place @yowasp/yosys is imported. Catches Exit -> {ok,code,log,files}
    eda.ts            # every Yosys script. Pass ordering is load-bearing — read CLAUDE.md first
    reports.ts        # the five reports. Renders recorded output only; never estimates
    session.store.ts  # in-memory design records
    types.ts          # the design record + verified device/cost constants
  modules/silicon/    # tools, resources, prompts
  widgets/app/design-report/
assets/sky130.lib     # vendored liberty, 13MB, 428 cells with real area
```

`CLAUDE.md` holds the verified API contracts and landmines; `log.md` holds the decisions and
why. **Read both before changing a Yosys script** — most of the pass ordering looks arbitrary and is
not.
