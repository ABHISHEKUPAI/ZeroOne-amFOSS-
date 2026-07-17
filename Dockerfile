# The toolchain is pinned to PRE-WasmGC WASM builds (@yowasp/yosys 0.64.1130,
# @yowasp/nextpnr-ecp5 0.10.752), so it runs on Node 18+ — including NitroCloud's Node 20, verified
# by building this repo on node:20-slim and passing all 8 tools. node:22 is used here only because
# it is the current LTS; 20 also works. This Dockerfile is belt-and-suspenders for platforms that
# honour it — the real portability comes from the version pin, not from forcing a runtime.
# See src/index.ts for why the newer WasmGC builds could not be used on Node 20.
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
