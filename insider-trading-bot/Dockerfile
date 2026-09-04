# syntax=docker/dockerfile:1

# `better-sqlite3` ships a prebuilt .node binary per platform and Node ABI, and
# its install script is `prebuild-install || node-gyp rebuild`. The prebuild
# exists for linux/x64 on glibc, so nothing here is ever compiled — verified: the
# install takes ~25s and needs no python3, make or g++.
#
# The binary is still glibc- and ABI-specific, so builder and runtime MUST share
# the same base image. Mixing bookworm and alpine (musl) produces a binary that
# fails to load at runtime with a cryptic ELF error.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts because this stage only runs `tsc`. It never loads
# better-sqlite3, so there is no reason to fetch a native binary for it at all —
# `@types/better-sqlite3` is what typechecking actually needs.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime deps ----------
# A separate stage so the production node_modules is resolved without dev
# dependencies. This is the one place the real native binary is needed.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Deliberately NO build toolchain in this image. That is not an oversight — it is
# what keeps the prebuild honest. With python3/make/g++ present, a missing or
# mismatched prebuild would quietly fall through the `||` into a full node-gyp
# source build: several minutes natively and far worse under the QEMU emulation
# used when cross-building linux/amd64 from an ARM machine. Without a toolchain
# that fallback cannot start, so a prebuild problem fails the build immediately
# and visibly instead of hiding as a slow build.
RUN npm ci --omit=dev \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1 v').get()" \
 && echo "better-sqlite3 loaded from prebuilt binary"

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC \
    DB_PATH=/data/insider.sqlite

# `node` (uid 1000) ships with the image. This chown only covers the case where no
# volume is mounted — a mount replaces the directory and its ownership, which the
# entrypoint fixes at runtime instead.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# NOTE: no `USER node` here. The entrypoint intentionally starts as root purely to
# chown the mounted volume, then drops to `node` via setpriv before exec'ing the
# app. Setting USER node here would reintroduce the SQLITE_CANTOPEN crash-loop,
# because a root-owned volume mount would be unwritable and unfixable.

# Deliberately NO `VOLUME ["/data"]` declaration. Railway's builder rejects the
# Docker VOLUME instruction outright ("docker VOLUME ... is not supported, use
# Railway Volumes") because it manages persistence itself, and docker-compose does
# not need it either — the bind mount in docker-compose.yml is what persists the
# database. Adding it back breaks the Railway build.

# No exposed port: this worker only makes outbound calls. It never serves HTTP and
# never receives Telegram updates.

# Exec form throughout, and the entrypoint `exec`s its argument, so node ends up as
# PID 1 and receives SIGTERM directly — anything that forks instead would swallow
# the signal and defeat the graceful shutdown in src/index.ts.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
