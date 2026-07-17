#!/usr/bin/env node
/**
 * Silicon Architect MCP server.
 *
 * Deployment landmines encoded here rather than left to a README nobody reads:
 *  - HOST must be 0.0.0.0. The default is localhost, which in a container is a black hole.
 *  - MCP_TRANSPORT_TYPE must be http explicitly. NODE_ENV=production alone yields 'dual',
 *    which DISABLES sessions.
 *  - NITROSTACK_APP_MODE must be 'universal'. The default targets ChatGPT, not Claude.
 */
import 'dotenv/config';
import { McpApplicationFactory } from '@nitrostack/core';
import { AppModule } from './app.module.js';
import { preloadYosys } from './lib/yosys.js';

/**
 * NitroStack core's floor. The YoWASP binaries are pinned to their last PRE-WasmGC builds
 * (@yowasp/yosys 0.64.1130, @yowasp/nextpnr-ecp5 0.10.752), which run on Node 18+.
 *
 * History worth keeping: the newer WasmGC builds (yosys >= 0.65) refuse to compile on Node 20 with
 * `invalid value type 'noexternref'`, and the `--experimental-wasm-gc` flag does NOT rescue Node 20
 * (V8 11.3 lacks the final WasmGC opcodes). NitroCloud provisions Node 20 and ignores engines,
 * .nvmrc, and the Dockerfile — so the durable fix was to pin the toolchain below the WasmGC line,
 * not to chase the runtime. Do not bump these WASM deps to a 0.65+/0.11+ build without re-pinning
 * Node, or the deploy breaks again.
 */
const MIN_NODE_MAJOR = 18;

/** Warn (do not block) below the floor. */
function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    console.error(
      `\n⚠️  Node ${process.versions.node} is below the supported floor (>= ${MIN_NODE_MAJOR}). ` +
        `The toolchain may misbehave.\n`,
    );
  }
}

function applyDeploymentDefaults() {
  const isHttp = (process.env.MCP_TRANSPORT_TYPE ?? '').toLowerCase() === 'http';
  const wantsHttp = isHttp || !!process.env.PORT || process.env.NODE_ENV === 'production';

  if (wantsHttp) {
    process.env.MCP_TRANSPORT_TYPE = 'http';
    process.env.HOST ||= '0.0.0.0';
    process.env.PORT ||= '3000';
  }
  process.env.NITROSTACK_APP_MODE ||= 'universal';
}

async function bootstrap() {
  applyDeploymentDefaults();
  checkNodeVersion();

  const transport = process.env.MCP_TRANSPORT_TYPE ?? 'stdio';
  console.error('⚡ Silicon Architect — autonomous hardware design over MCP');
  console.error(`   node:      ${process.versions.node}`);
  console.error(
    `   transport: ${transport}${transport === 'http' ? ` on ${process.env.HOST}:${process.env.PORT}/mcp` : ''}`,
  );
  console.error(`   app mode:  ${process.env.NITROSTACK_APP_MODE}`);
  console.error(
    `   auth:      ${process.env.OAUTH_REQUIRED === 'true' ? 'ENFORCED' : 'open (set OAUTH_REQUIRED=true to enforce)'}`,
  );

  const server = await McpApplicationFactory.create(AppModule);
  await server.start();

  // Warm the 54MB WASM in the background so a judge's first tool call isn't the slow one.
  // Deliberately not awaited: the server must accept connections immediately.
  preloadYosys()
    .then(() => console.error('   yosys:     WASM ready'))
    .catch((e) =>
      console.error(`   yosys:     preload failed (${e.message}); will retry on first call`),
    );
}

bootstrap().catch((error) => {
  console.error('❌ Failed to start Silicon Architect:', error);
  process.exit(1);
});
