#!/usr/bin/env bash
#
# Deploy the insider bot to Gagarin Cloud.
#
# Assumes .env is complete. See DEPLOY.md for how to get each credential.
#
# Idempotent: run it again to ship a new build. It creates the project on the
# first run and reuses it afterwards.
#
#   ./deploy.sh                      deploy as project "insider-bot"
#   PROJECT=my-bot ./deploy.sh       deploy under a different project name
#   DRY_RUN_DEPLOY=1 ./deploy.sh     print what it would do, change nothing
#   SKIP_WEB=1 ./deploy.sh           the worker only; do not ship the website
#   WEB_PUBLIC=0 ./deploy.sh         ship the website but leave it private
#
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="${PROJECT:-insider-bot}"
SERVICE="${SERVICE:-bot}"

# The website: the Next.js app in ./web, which renders the open calls straight
# out of the same postgres. It is a second service rather than part of the worker
# because the two have nothing in common at runtime — one sleeps for three hours
# at a stretch and holds every API key, the other answers HTTP and holds none.
WEB_SERVICE="${WEB_SERVICE:-web}"
WEB_PORT="${WEB_PORT:-3000}"
WEB_SIZE="${WEB_SIZE:-s}"

# The port the worker's health endpoint listens on (src/health.ts). It serves
# nothing else and stays private — gagarin opens a connection here to decide the
# pod is ready, and nothing else ever does. The website is the service with a
# public address; see "The website" in DEPLOY.md.
PORT="${PORT:-8080}"

# The postgres resource holding every seen event and scored call. Its name is
# load-bearing: gagarin derives the injected variable names from it, so a
# resource called `db` is what makes DB_URL — the one variable src/config.ts
# reads — appear in the service's environment. Renaming it here means renaming
# DB_URL in config.ts too.
DB_RESOURCE="${DB_RESOURCE:-db}"

# Storage ceiling in GB for the database. This can be raised later by restating
# the resource with a bigger number; it can never be lowered. 10GB is generous
# for news metadata and scored calls.
DB_STORAGE="${DB_STORAGE:-10}"

# s = 0.5 vCPU / 1GB shared, for both. The worker sleeps between 3-hourly cycles
# and the database serves one client; neither needs dedicated CPU.
SIZE="${SIZE:-s}"
DB_SIZE="${DB_SIZE:-s}"

ENV_FILE="${ENV_FILE:-.env}"

# The six credentials with no default in src/config.ts. Everything else in
# .env.example is optional and falls back to a documented default.
REQUIRED_KEYS=(
  OPENAI_API_KEY
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHANNEL_ID
  FINNHUB_API_KEY
  MARKETAUX_API_KEY
  SEC_USER_AGENT
)

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ -n "${DRY_RUN_DEPLOY:-}" ]]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------- preflight

say "Checking prerequisites"

command -v gg >/dev/null 2>&1 || die \
  "gg is not installed. See DEPLOY.md section 3, or: go install github.com/gagarin-cloud/gg@latest"

# gg builds the image locally before pushing, so the daemon has to be up.
command -v docker >/dev/null 2>&1 || die "docker is not installed; gg needs it to build the image."
docker info >/dev/null 2>&1 || die "the docker daemon is not running. Start Docker and retry."

gg whoami >/dev/null 2>&1 || die \
  "gg has no credentials on this machine. Run 'gg signup <your-email>', click the
       link in the email, then 'gg auth --claim <code>'. See DEPLOY.md section 3."

say "Authorised as $(gg whoami | awk '/^account/ {print $2}')"

# `gg auth` normally logs Docker in to Gagarin's registry as part of claiming
# credentials — but it silently skips that step if Docker was not installed yet
# at the time. The symptom is the build succeeding and then `docker push failed`.
# It is idempotent and cheap, so just do it every run rather than detecting it.
say "Refreshing registry login"
run gg registry login >/dev/null 2>&1 \
  || warn "gg registry login failed; the push may fail. Try running it by hand."

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Run 'cp .env.example .env' and fill it in (DEPLOY.md section 1)."

[[ -f Dockerfile ]] || die "no Dockerfile here; run this script from the project directory."

# ------------------------------------------------------- validate the env file

say "Validating $ENV_FILE"

# Read a key's value with surrounding quotes stripped. Last occurrence wins,
# matching how a shell would source the file.
env_value() {
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$ENV_FILE" \
    | tail -n1 \
    | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

missing=()
for key in "${REQUIRED_KEYS[@]}"; do
  value="$(env_value "$key")"
  [[ -n "$value" ]] || missing+=("$key")
done

if (( ${#missing[@]} )); then
  die "these required keys are empty in $ENV_FILE: ${missing[*]}
       DEPLOY.md section 1 explains where to get each one."
fi

# Catch values left at their .env.example placeholders. These parse fine and
# then fail at runtime in ways that look like bugs rather than blank fields.
if [[ "$(env_value SEC_USER_AGENT)" == *"you@example.com"* ]]; then
  die "SEC_USER_AGENT still contains the example address. EDGAR requires real
       contact info and will 403 (then block the IP) without it."
fi

channel="$(env_value TELEGRAM_CHANNEL_ID)"
if [[ ! "$channel" =~ ^(@[A-Za-z][A-Za-z0-9_]{4,}|-100[0-9]+)$ ]]; then
  warn "TELEGRAM_CHANNEL_ID is '$channel', which is neither an @handle nor a -100… id."
  warn "The worker calls getChat at boot and exits if it cannot reach the channel."
fi

if [[ "$(env_value DRY_RUN)" == "true" ]]; then
  warn "DRY_RUN=true — the worker will run the full pipeline (and spend real"
  warn "OpenAI tokens) but log messages instead of posting them."
fi

# ------------------------------------------- build the environment gg will send

# Why this file is rewritten rather than passing --env-file .env directly:
#
#   1. This repo's .env quotes every value (KEY="value"), which is correct for a
#      shell. A plain KEY=VALUE reader would treat the quote characters as part
#      of the value and every credential would be wrong by two bytes.
#   2. Comments and blank lines are dropped.
#   3. DB_URL is removed. The local .env points it at a Postgres on your own
#      machine, which is not reachable from the cluster and, if it somehow were,
#      is not the database the deployed worker should be writing to. gagarin
#      injects the real DB_URL from the postgres resource, and an injected
#      variable outranks anything a deploy passes — so sending ours would be
#      ignored anyway. Better not to have a stale credential in the call at all.
#
# Written 0600 and deleted on exit: it holds every credential in the clear.
RENDERED_ENV="$(mktemp -t insider-bot-env.XXXXXX)"
chmod 600 "$RENDERED_ENV"
trap 'rm -f "$RENDERED_ENV"' EXIT

while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue

  key="${BASH_REMATCH[1]}"
  val="${BASH_REMATCH[2]}"

  # Injected by gagarin, or set explicitly below; never take these from the file.
  [[ "$key" == "DB_URL" || "$key" == "TZ" || "$key" == "NODE_ENV" ]] && continue

  # Strip one layer of matching quotes, then trailing whitespace.
  val="$(printf '%s' "$val" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"

  printf '%s=%s\n' "$key" "$val" >> "$RENDERED_ENV"
done < "$ENV_FILE"

say "Prepared $(wc -l < "$RENDERED_ENV" | tr -d ' ') environment variables"

# ------------------------------------------------------------ create the project

if gg projects 2>/dev/null | awk '{print $1}' | grep -qx "$PROJECT"; then
  say "Project '$PROJECT' already exists"
else
  say "Creating project '$PROJECT'"
  run gg init "$PROJECT"
fi

# ------------------------------------------------------------ the database

# `gg resource add` is idempotent: restating an existing postgres with the same
# storage changes nothing, and with a larger number grows it. So this is safe to
# run on every deploy, and there is no "does it exist yet" probe to get wrong.
#
# It is created BEFORE the service that needs it, so the worker never starts into
# a window where its database does not exist.
say "Provisioning postgres '$PROJECT/$DB_RESOURCE' (${DB_STORAGE}GB, size $DB_SIZE)"
run gg resource add "$PROJECT/$DB_RESOURCE" postgres --size "$DB_SIZE" --storage "$DB_STORAGE"

# Probe for the service so the first deploy can be told apart from a redeploy.
# The row is read from `gg status`, stripping the ●/○ health marker so the
# service name lands in field 1. Note that `gg history` is NOT usable here: it
# exits 0 and prints "bot has not been deployed yet" for a service that does not
# exist.
service_row() {
  gg status "$PROJECT" 2>/dev/null \
    | sed -E 's/^[[:space:]]*[●○][[:space:]]*//' \
    | awk -v s="$1" '$1 == s'
}

if [[ -n "$(service_row "$SERVICE" || true)" ]]; then
  say "Service '$PROJECT/$SERVICE' exists — shipping a new build over it"
else
  say "Service '$PROJECT/$SERVICE' is new — creating it"
fi

# ---------------------------------------------------------------------- ship

# Gagarin replaces a service's environment wholesale on each deploy rather than
# merging, so the full set is passed every time. A variable omitted here is a
# variable removed from the running service.
#
# DB_URL is the exception and is deliberately absent: it comes from the postgres
# resource via --deps, and a resource's injected variable outranks anything a
# deploy sets. Passing one here would be ignored, so it is not passed.
#
# The dependency edge is declared AFTER the ship, not with --deps on it.
#
# Measured 2026-09-06: `gg ship <project>/<service> --deps db` fails with
# `[store_error] still in use` when the ship is *creating* the service. It
# succeeds on a service that already exists, which is why this only bites a first
# deploy — the worst possible time to discover it. Shipping bare and then calling
# `gg deps add` works in both cases and is idempotent.
#
# The cost is a short window where a brand new service is running without the
# database credentials. Both services here tolerate that: the worker retries with
# backoff (src/db/index.ts) and the website renders "database unreachable" until
# the edge lands, at which point gagarin re-renders the pod with DB_URL present.
ship_args=(
  ship "$PROJECT/$SERVICE:$PORT"
  --size "$SIZE"
  --env-file "$RENDERED_ENV"
  --env "TZ=UTC"
  --env "NODE_ENV=production"
)

# Roughly 2 minutes once the base image is cached; the first run also pulls
# node:22-bookworm-slim. Nothing is compiled — see the Dockerfile header.
say "Building and shipping (~2 min; longer on the first run while the base image downloads)"
run gg "${ship_args[@]}"

# Only ever adds, so this is a no-op on a redeploy and repairs the edge if
# someone removed it. An undeclared call to a database is dropped rather than
# refused, which surfaces as a connection that hangs rather than one that fails —
# so it is worth restating every run.
say "Declaring that '$SERVICE' reaches '$DB_RESOURCE'"
run gg deps add "$PROJECT/$SERVICE" "$DB_RESOURCE"

# ------------------------------------------------------------------ the website

# A second service out of ./web, reaching the same postgres.
#
# It gets no --env-file. The site reads three tables and calls nothing; giving it
# the OpenAI and Telegram credentials would put every key this project holds
# inside the one container that answers requests from the internet. DB_URL is not
# passed either, for the same reason it is not passed to the worker: --deps is
# what supplies it.
if [[ -z "${SKIP_WEB:-}" ]]; then
  [[ -f web/Dockerfile ]] || die "no web/Dockerfile; run this script from the project directory."

  if [[ -n "$(service_row "$WEB_SERVICE" || true)" ]]; then
    say "Service '$PROJECT/$WEB_SERVICE' exists — shipping a new build over it"
  else
    say "Service '$PROJECT/$WEB_SERVICE' is new — creating it"
  fi

  say "Building and shipping the website from ./web"
  run gg ship "$PROJECT/$WEB_SERVICE:$WEB_PORT" \
    --context ./web \
    --size "$WEB_SIZE" \
    --env "TZ=UTC" \
    --env "NODE_ENV=production"

  say "Declaring that '$WEB_SERVICE' reaches '$DB_RESOURCE'"
  run gg deps add "$PROJECT/$WEB_SERVICE" "$DB_RESOURCE"

  # This is the step that puts the calls on the internet, so it says so rather
  # than happening quietly. The generated gagarin address is idempotent and
  # instant — gagarin holds the wildcard record and certificate, so there is no
  # DNS to wait for and nothing to coordinate.
  if [[ "${WEB_PUBLIC:-1}" == "0" ]]; then
    say "WEB_PUBLIC=0 — leaving '$PROJECT/$WEB_SERVICE' private (no address)"
  else
    say "Giving '$PROJECT/$WEB_SERVICE' a public address — the open calls become readable by anyone with the link"
    run gg domain add "$PROJECT/$WEB_SERVICE"
  fi
fi

if [[ -n "${DRY_RUN_DEPLOY:-}" ]]; then
  say "Dry run complete. Nothing was created, built or deployed."
  exit 0
fi

# -------------------------------------------------------------------- verify

# gg ship returning zero means the demand was recorded, not that the worker is
# running. gg status reads the cluster and is the only thing that knows.
say "Deploy submitted. Reading actual cluster state:"
echo
gg status "$PROJECT" || warn "could not read status; try 'gg status $PROJECT' again in a moment."
echo

# Assert the dependency edge landed. Without it the worker holds no DB_URL and
# could not reach the database even if it did — and because an undeclared call is
# dropped rather than refused, the symptom is a boot that hangs on connect for a
# minute and then exits, not an error naming the cause.
for svc in "$SERVICE" $([[ -z "${SKIP_WEB:-}" ]] && echo "$WEB_SERVICE"); do
  if gg deps ls "$PROJECT/$svc" 2>/dev/null | grep -qw "$DB_RESOURCE"; then
    say "Service '$svc' reaches '$DB_RESOURCE' and holds its credentials"
  else
    warn "$PROJECT/$svc does not appear to reach '$DB_RESOURCE'."
    warn "Fix it with:  gg deps add $PROJECT/$svc $DB_RESOURCE"
  fi
done

cat <<EOF
$(say "Next steps")

  gg logs $PROJECT/$SERVICE        watch the worker boot
  gg domain ls $PROJECT            the website's address

A healthy first boot logs 'storage check' (naming the database and its Postgres
version), then 'telegram channel reachable', then 'insider bot starting'.

Then it goes quiet until the cron fires. At the default INGEST_CRON the first
cycle runs at 7 minutes past the next 3-hour mark, so an idle log is expected
rather than a hang.

The worker is private and has no public URL. That is deliberate: it only makes
outbound calls and serves no HTTP. The website is the service with an address —
run 'gg domain ls $PROJECT' for it, or 'gg status $PROJECT', which hangs each
address under its service.

The database is private too and never gets one — to query it from your own
machine:

  gg resource secrets $PROJECT/$DB_RESOURCE

To prove persistence, run ./deploy.sh once more: the storage check should log
existedAtBoot: true and a non-zero event count. See DEPLOY.md section 5.
EOF
