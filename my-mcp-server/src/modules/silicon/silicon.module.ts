import { Module } from '@nitrostack/core';
import { SessionStore } from '../../lib/session.store.js';
import { SiliconTools } from './silicon.tools.js';
import { SiliconResources, SiliconDesignResource } from './silicon.resources.js';
import { SiliconPrompts } from './silicon.prompts.js';

/**
 * The whole EDA control plane. SessionStore is a singleton shared by tools and resources, so a
 * report read over a resource sees exactly what the tools wrote.
 *
 * `controllers` vs `providers` is load-bearing: only classes listed under `controllers` are scanned
 * for @Tool/@Resource/@Prompt. Putting them in `providers` registers them in DI but exposes NOTHING
 * over MCP — the server starts cleanly and reports "0 tools".
 */
@Module({
  name: 'silicon',
  description: 'Autonomous hardware design: RTL, formal verification, synthesis, P&R and costing',
  controllers: [SiliconTools, SiliconResources, SiliconDesignResource, SiliconPrompts],
  providers: [SessionStore],
  exports: [SessionStore],
})
export class SiliconModule {}
