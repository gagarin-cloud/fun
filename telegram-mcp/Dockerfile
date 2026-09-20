# syntax=docker/dockerfile:1

# Nothing here compiles: GramJS speaks MTProto in pure JavaScript and the only
# native thing in the image is node itself.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- builder ----------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC \
    PORT=8080

COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The server writes nothing it needs to keep: sessions live inside the tokens
# clients hold, so there is no volume, no state directory and no reason to run
# as root.
USER node

EXPOSE 8080

# Exec form, so node is PID 1 and gets SIGTERM directly — that is what closes
# the Telegram connections instead of dropping them.
CMD ["node", "dist/index.js"]
