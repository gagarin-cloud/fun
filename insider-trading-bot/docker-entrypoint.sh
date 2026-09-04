#!/bin/sh
set -e

# A mounted volume replaces whatever the image set up at that path, so the
# `chown node:node /data` done at build time is discarded the moment Railway (or
# docker-compose) mounts storage over it. The mount arrives owned by root, and a
# process running as `node` then cannot create the database — SQLITE_CANTOPEN.
#
# So fix ownership at runtime, while we still have root, then drop privileges for
# the application itself. The app never runs as root.
#
# If the container was already started as a non-root user (e.g. compose with
# `user:` set), there is nothing to fix and nothing to drop — just exec.

DATA_DIR="$(dirname "${DB_PATH:-/data/insider.sqlite}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Best effort: a read-only or already-correct mount must not abort startup.
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  # setpriv (util-linux) rather than su/gosu: no extra package, and it execs
  # directly so the app stays PID 1 and receives SIGTERM for graceful shutdown.
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
