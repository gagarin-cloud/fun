# syntax=docker/dockerfile:1

# The read-only web view of the bot's database. Nothing here compiles: `pg`
# speaks the Postgres wire protocol in JS, and Next's build is a bundler run, so
# the builder and runtime bases are free to differ and no toolchain reaches the
# final image.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nothing in this tree has an install step worth running, and
# skipping them keeps a compromised transitive dependency from executing during
# a build that has network access.
RUN npm ci --ignore-scripts

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The build must not reach the database, and does not: every route that reads it
# is `export const dynamic = 'force-dynamic'`, so `next build` renders none of
# them. If that were ever dropped, the build would fail here — on a machine with
# no DB_URL — rather than silently baking one request's rows into a static page.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000 \
    # Next's standalone server already defaults to 0.0.0.0, but a server bound to
    # loopback is invisible from outside the container and fails identically to
    # one that never started — so it is stated rather than inherited.
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# `output: 'standalone'` (next.config.ts) emits a server with only the traced
# dependencies, so these two directories are the whole application — no
# node_modules, no Next CLI. Static assets are not traced and are copied beside
# it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# All state is in Postgres and this process only reads it, so there is nothing to
# write, no volume, and no reason to run as root.
USER node

EXPOSE 3000

# Exec form, so node is PID 1 and gets SIGTERM directly.
CMD ["node", "server.js"]
