# syntax=docker/dockerfile:1

# Every dependency is pure JavaScript — `pg` speaks the Postgres wire protocol in
# JS and does not link libpq — so nothing here compiles, no build toolchain is
# needed, and the builder and runtime bases are free to differ. (They did not use
# to be: the SQLite version linked a native, glibc- and ABI-specific binary that
# pinned both stages to the same image.)
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: this stage only runs `tsc`, and no dependency has an install
# step worth running for it.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime deps ----------
# A separate stage purely so the production node_modules is resolved without dev
# dependencies, and without dragging the TypeScript toolchain into the image.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC

COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# All state lives in Postgres, so the container writes nothing it needs to keep.
# It can run unprivileged with no volume, no mount to chown and no entrypoint
# shim — the SQLite version needed a root entrypoint purely to fix ownership of a
# mounted data directory before dropping privileges.
USER node

# No exposed port: this worker only makes outbound calls. It never serves HTTP and
# never receives Telegram updates.

# Exec form, so node is PID 1 and receives SIGTERM directly — anything that forked
# instead would swallow the signal and defeat the graceful shutdown (and the pool
# drain) in src/index.ts.
CMD ["node", "dist/index.js"]
