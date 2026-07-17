/**
 * Prompts are where the proposal's "seven agents" actually live: they are system-prompt roles
 * driving ONE client loop, not seven services. NitroStack has no agent primitives and no MCP
 * client, so this is the only honest place to put them — and it means a judge's own Claude picks
 * up the same roles our dashboard uses. The server stays self-sufficient.
 */
import { ControllerDecorator as Controller, PromptDecorator as Prompt } from '@nitrostack/core';

/** The core package does not re-export PromptMessage from its index; mirror the shape here. */
type PromptMessage = { role: 'user' | 'assistant' | 'system'; content: string };

const CONTROL_PLANE_RULES = `
You are driving a real EDA toolchain over MCP. The tools are the control plane: choose your next
call based on what the last call actually returned, not from a fixed script.

Non-negotiable rules:
- Never state a number this toolchain did not produce. If a stage did not run, say so.
- ok:false is data, not an error. Read the log/counterexample and fix the RTL.
- Verification is bounded model checking, not simulation. A pass proves the assertions over N
  cycles against all inputs; it is not proof of correctness beyond that bound. Say so.
- A proof with zero assertions is vacuous. Zero assertions means NOT VERIFIED.
- Cost requires real area, which only synthesize(target:"sky130") produces. Never estimate area.
- Artix-7 has NO Fmax here (synthesis only, no P&R). Never claim timing closure on Artix-7.
  Use place_and_route on ecp5 for a real achieved-MHz figure.
- Artix-7 XC7A35T has 20,800 LUT6, not 5,200 (that figure counts slices).
`.trim();

@Controller()
export class SiliconPrompts {
  @Prompt({
    name: 'design_chip',
    title: 'Design a chip end to end',
    description:
      'Full autonomous flow: search prior IP, write RTL, prove it with bounded model checking, ' +
      'synthesize, cost it, and produce the engineering report.',
    arguments: [
      { name: 'spec', description: 'What to build, e.g. "a UART transmitter at 115200 baud"', required: true },
      { name: 'target', description: 'sky130 | ecp5 | ice40 | artix7 (default sky130)', required: false },
      { name: 'clock_mhz', description: 'Target clock in MHz, e.g. 100', required: false },
    ],
  })
  async designChip(args: {
    spec: string;
    target?: string;
    clock_mhz?: string;
  }): Promise<PromptMessage[]> {
    const target = args.target || 'sky130';
    return [
      {
        role: 'user',
        content: `${CONTROL_PLANE_RULES}

Design this hardware, end to end: **${args.spec}**
Target: ${target}${args.clock_mhz ? ` @ ${args.clock_mhz} MHz` : ''}

Work through these roles in one loop, calling tools as you go:

1. **Architect** — restate the spec as concrete, checkable requirements (interfaces, widths, timing).
2. **IP scout** — call \`search_ip\` to see whether proven prior art exists. Reference it; do not
   blindly copy it.
3. **RTL engineer** — call \`write_rtl\` with synthesizable Verilog. If elaboration fails, read
   \`elaboration_log\`, fix it, and call \`write_rtl\` again with the SAME design_id.
4. **Verification engineer** — call \`simulate\` with a testbench MODULE (clk/rst inputs, instantiates
   the DUT, contains assert() statements — NOT an initial block; there is no simulator). Write
   assertions that would actually catch a bug: reset behaviour, protocol framing, state invariants.
   If a proof fails, read the counterexample, fix the RTL, and re-verify. Do not proceed unverified.
5. **Physical designer** — call \`synthesize\`. For a cost figure you need target "sky130" (only
   \`stat -liberty\` yields area). For a real Fmax, call \`place_and_route\` on ecp5.
6. **Cost analyst** — call \`cost_sheet\` and present the IHP figure alongside the TinyTapeout
   cross-check.
7. **Technical writer** — call \`design_report\` with kind "all" and present it.

Finish with the report. If anything is unverified or unmeasured, say so plainly rather than
filling the gap.`,
      },
    ];
  }

  @Prompt({
    name: 'verify_design',
    title: 'Write assertions and prove a design',
    description:
      'Verification-focused: write a proper assertion testbench for an existing design and prove ' +
      'it with bounded model checking, iterating on failures.',
    arguments: [
      { name: 'design_id', description: 'The design to verify', required: true },
      { name: 'depth', description: 'Cycles to prove over (default 12)', required: false },
    ],
  })
  async verifyDesign(args: { design_id: string; depth?: string }): Promise<PromptMessage[]> {
    return [
      {
        role: 'user',
        content: `${CONTROL_PLANE_RULES}

Verify design \`${args.design_id}\` properly.

The testbench must be a **module with clk and rst inputs** that instantiates the DUT and contains
\`assert(...)\` statements. There is no simulator: assertions are PROVED over ${args.depth || 12}
cycles by \`sat -prove-asserts\`. An \`initial\` block with stimulus will not work, and \`$display\`
is not captured.

Write assertions that would catch a real bug, not tautologies:
- reset drives the design to a known state
- outputs stay within their declared range
- protocol invariants hold (e.g. a UART idles high; start bit is low; frame length is exact)
- the design cannot enter an illegal state

Call \`simulate\` with design_id "${args.design_id}" and depth ${args.depth || 12}. If a proof fails,
read the counterexample and the failing assertion's src, diagnose the ACTUAL bug, then fix the RTL
via \`write_rtl\` (same design_id) and re-prove. Report which assertions were proved and over what
bound — and remember that zero assertions means not verified, not passed.`,
      },
    ];
  }

  @Prompt({
    name: 'cost_review',
    title: 'Audit the cost of a design',
    description:
      'Cost-analyst role: produce and critically audit the fabrication cost, including the ' +
      'TinyTapeout cross-check and what the model excludes.',
    arguments: [{ name: 'design_id', description: 'The design to cost', required: true }],
  })
  async costReview(args: { design_id: string }): Promise<PromptMessage[]> {
    return [
      {
        role: 'user',
        content: `${CONTROL_PLANE_RULES}

Produce a defensible cost analysis for design \`${args.design_id}\`.

1. Ensure a sky130 synthesis exists — call \`synthesize\` with target "sky130" if needed. Area comes
   only from \`stat -liberty\`; it cannot be estimated.
2. Call \`cost_sheet\`.
3. Read the resource \`silicon://cost-model\` and audit the result against it.
4. Present: the euro figure, the die area, the TinyTapeout cross-check and WHY the two differ (TT
   amortizes one die across hundreds of projects), and what the model excludes (power, NRE).
5. Flag any stale figure. eFabless shut down in March 2025 — chipIgnite pricing is dead. IHP
   (EUR 7,300/mm^2) is the live source.

Be skeptical of your own number. State what would change it.`,
      },
    ];
  }
}
