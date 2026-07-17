# Node 22 is a HARD requirement, not a preference.
#
# The EDA toolchain (@yowasp/yosys) is WebAssembly compiled with WasmGC. Proven by testing the real
# binary in each runtime:
#   node:20  ->  CompileError: invalid value type 'noexternref'      (every tool call dies)
#   node:20 --experimental-wasm-gc
#            ->  CompileError: Invalid opcode 0x1f                   (V8 11.3 lacks the final
#                                                                     WasmGC opcodes — the flag
#                                                                     does NOT rescue Node 20)
#   node:22  ->  OK
#   node:24  ->  OK
# There is no code-level workaround. The runtime must be 22+.
#
# package.json declares engines.node >= 22, but NitroCloud ignored it and provisioned Node 20.20.2.
# This Dockerfile removes the platform's choice from the equation.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a source-only change doesn't re-download the ~54MB WASM.
COPY package.json package-lock.json ./
RUN npm ci

# The widget app has its own package.json; nitrostack-cli build installs and bundles it.
COPY . .

# Builds BOTH the server (tsc) and the widget (next export).
# The widget is not optional: @Widget('design-report') throws at boot if
# src/widgets/out/design-report.html is missing.
RUN npm run build

# assets/sky130.lib (13MB) is vendored in the repo and copied above — never fetched at runtime.

ENV NODE_ENV=production \
    MCP_TRANSPORT_TYPE=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    NITROSTACK_APP_MODE=universal

EXPOSE 3000

# Run node directly. `nitrostack-cli start` reads only the --port FLAG and hard-overrides PORT to
# 3000, discarding a platform-assigned port.
CMD ["node", "dist/index.js"]
