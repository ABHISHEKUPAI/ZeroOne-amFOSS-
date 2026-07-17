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

/** WasmGC (used by the YoWASP binaries) is enabled by default from Node 22 / V8 12.4 onward. */
const MIN_NODE_MAJOR = 22;

/**
 * Fail loudly at boot on an unsupported Node, instead of at the first tool call.
 *
 * The YoWASP Yosys binary is compiled with WasmGC. On Node 20 it does not merely run slowly — it
 * refuses to compile:
 *   CompileError: WebAssembly.compileStreaming(): invalid value type 'noexternref',
 *                 enable with --experimental-wasm-gc
 * There is no workaround from inside the process: `--experimental-wasm-gc` is rejected outright by
 * Node 22+ ("bad option") and is on NODE_OPTIONS' disallow list, so it cannot be set for the
 * current process either. The only fix is a newer Node, which is why package.json pins
 * engines.node >= 22. If a host ignores `engines`, this warning is the fastest path to diagnosis.
 */
function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    console.error(
      `\n⛔ Node ${process.versions.node} is too old — Yosys will fail to compile.\n` +
        `   The EDA toolchain is WebAssembly built with WasmGC, which needs Node >= ${MIN_NODE_MAJOR}.\n` +
        `   On this version every tool call dies with:\n` +
        `     CompileError: invalid value type 'noexternref', enable with --experimental-wasm-gc\n` +
        `   The flag cannot be applied from here (Node 22+ rejects it; NODE_OPTIONS forbids it).\n` +
        `   FIX: run this server on Node ${MIN_NODE_MAJOR}+ (package.json declares engines.node >= ${MIN_NODE_MAJOR}).\n` +
        `   The server will start, but no design tool will work.\n`,
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
