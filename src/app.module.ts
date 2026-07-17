import { McpApp, Module, ConfigModule, OAuthModule } from '@nitrostack/core';
import { SiliconModule } from './modules/silicon/silicon.module.js';
import { SystemHealthCheck } from './health/system.health.js';
import { ToolchainHealthCheck } from './health/toolchain.health.js';

/**
 * Silicon Architect — an autonomous AI hardware architect exposed as an MCP server.
 *
 * The design principle: this server is SELF-SUFFICIENT. A judge points their own Claude at /mcp and
 * it designs hardware — no dashboard of ours required. If a capability only works from our client,
 * it does not count.
 */

/** Auth is opt-in. An auth wall on a public demo endpoint scores zero — enable it deliberately. */
const OAUTH_ENFORCED = process.env.OAUTH_REQUIRED === 'true';
@McpApp({
  module: AppModule,
  server: {
    name: 'silicon-architect',
    version: '1.0.0',
  },
  logging: { level: (process.env.NITRO_LOG_LEVEL as 'info') || 'info' },
})
@Module({
  name: 'app',
  description:
    'Autonomous AI hardware architect: natural-language spec in, formally verified RTL and a costed ' +
    'engineering report out. Real Yosys and nextpnr running as WASM in-process.',
  imports: [
    ConfigModule.forRoot(),

    // OAuth is registered ONLY when actually enforced.
    //
    // This is not a style choice. Merely importing OAuthModule serves
    // /.well-known/oauth-protected-resource, which advertises an authorization server to every
    // client — even with `required: false` and even though /mcp answers fine without a token.
    // Claude's "Add custom connector" reads that metadata FIRST and attempts OAuth 2.1 / Dynamic
    // Client Registration against whatever it names. With the starter's placeholder tenant that
    // discovery fails, and the connector cannot be added at all: the endpoint looks healthy, /mcp
    // returns 200, and the client still refuses to attach.
    // See anthropics/claude-ai-mcp#402 — there is no "this server is unauthenticated" option; a
    // server declares that by NOT publishing the metadata.
    // Silence is how you say "no auth". Do not import this module to "leave auth off".
    ...(OAUTH_ENFORCED
      ? [
          OAuthModule.forRoot({
            required: true,
            resourceUri: process.env.RESOURCE_URI || 'https://mcplocal',
            authorizationServers: [process.env.AUTH_SERVER_URL || 'https://example.invalid'],
            scopesSupported: ['read', 'write'],
            tokenIntrospectionEndpoint: process.env.INTROSPECTION_ENDPOINT,
            tokenIntrospectionClientId: process.env.INTROSPECTION_CLIENT_ID,
            tokenIntrospectionClientSecret: process.env.INTROSPECTION_CLIENT_SECRET,
            audience: process.env.TOKEN_AUDIENCE,
            issuer: process.env.TOKEN_ISSUER,
          }),
        ]
      : []),

    SiliconModule,
  ],
  providers: [SystemHealthCheck, ToolchainHealthCheck],
})
export class AppModule {}
