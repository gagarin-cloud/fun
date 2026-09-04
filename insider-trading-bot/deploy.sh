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
#
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="${PROJECT:-insider-bot}"
SERVICE="${SERVICE:-bot}"

# The container listens on nothing — it only makes outbound calls. Gagarin wants
# a port, so this is nominal: the service stays private, has no dependents, and
# nothing ever connects to it. See "Why there is no gg domain add" in DEPLOY.md.
PORT="${PORT:-8080}"

# Where the SQLite database lives on the volume. This MUST NOT come from .env —
# see the note by the --env DB_PATH override below.
VOLUME_PATH="/data"
DB_PATH="${VOLUME_PATH}/insider.sqlite"

# Volume size in GB. A volume is set once, at the deploy that creates the
# service; a later deploy cannot move or resize it, so this is a one-way door.
# 2GB is generous for a SQLite file that stores news metadata and scored calls.
VOLUME_SIZE="${VOLUME_SIZE:-2}"

# s = 0.5 vCPU / 1GB shared. This worker sleeps between 3-hourly cycles; it does
# not need dedicated CPU.
SIZE="${SIZE:-s}"

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
#   3. DB_PATH is removed. The local .env points it at ./data for local runs;
#      inside the container that resolves to /app/data — the container
#      filesystem, not the volume — so the database would be recreated empty on
#      every deploy and the entire scoring dataset would be silently lost. It is
#      re-added below as an explicit --env pointing at the volume.
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

  # Set explicitly below; never take these from the file.
  [[ "$key" == "DB_PATH" || "$key" == "TZ" || "$key" == "NODE_ENV" ]] && continue

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

# A volume can only be declared on the deploy that creates the service; passing
# it later is at best a no-op and at worst a refusal. So probe for the service
# and only ask for the volume when we are actually creating it.
#
# The probe reads the service table from `gg status`, stripping the ●/○ health
# marker so the service name lands in field 1. Note that `gg history` is NOT
# usable here: it exits 0 and prints "bot has not been deployed yet" for a
# service that does not exist, so using it would silently skip --volume on the
# real first deploy and leave the database on the container filesystem.
service_row() {
  gg status "$PROJECT" 2>/dev/null \
    | sed -E 's/^[[:space:]]*[●○][[:space:]]*//' \
    | awk -v s="$SERVICE" '$1 == s'
}

first_deploy=1
existing_row="$(service_row || true)"

if [[ -n "$existing_row" ]]; then
  first_deploy=0
  say "Service '$PROJECT/$SERVICE' exists — shipping a new build over it"

  # Last field of the row is the VOLUME column; "—" means none is attached.
  existing_volume="$(printf '%s' "$existing_row" | awk '{print $NF}')"
  if [[ "$existing_volume" == "—" || "$existing_volume" == "-" ]]; then
    warn "This service has NO volume attached."
    warn "The database is on the container filesystem and every deploy wipes it."
    warn "A volume can only be set on the deploy that creates a service, so the"
    warn "only fix is to recreate it:  gg destroy $PROJECT/$SERVICE  then rerun this."
    warn "Continuing — but nothing this worker records will survive a redeploy."
  fi
else
  say "Service '$PROJECT/$SERVICE' is new — creating it with a ${VOLUME_SIZE}GB volume at $VOLUME_PATH"
fi

# ---------------------------------------------------------------------- ship

# --env wins over every --env-file, which is what makes the DB_PATH override
# below authoritative regardless of what .env said.
#
# Gagarin replaces a service's environment wholesale on each deploy rather than
# merging, so the full set is passed every time. A variable omitted here is a
# variable removed from the running service.
ship_args=(
  ship "$PROJECT/$SERVICE:$PORT"
  --size "$SIZE"
  --env-file "$RENDERED_ENV"
  --env "DB_PATH=$DB_PATH"
  --env "TZ=UTC"
  --env "NODE_ENV=production"
)

if (( first_deploy )); then
  ship_args+=(--volume "$VOLUME_PATH" --volume-size "$VOLUME_SIZE")
fi

# Roughly 2 minutes once the base image is cached; the first run also pulls
# node:22-bookworm-slim. Nothing is compiled — see the Dockerfile header.
say "Building and shipping (~2 min; longer on the first run while the base image downloads)"
run gg "${ship_args[@]}"

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

# Assert the volume landed. Getting this wrong is silent and expensive: the
# worker runs perfectly, writes to the container filesystem, and loses the whole
# scoring dataset at the next deploy.
volume_now="$(service_row | awk '{print $NF}' || true)"
if [[ -n "$volume_now" && ( "$volume_now" == "—" || "$volume_now" == "-" ) ]]; then
  warn "no volume is attached to $PROJECT/$SERVICE — the database will NOT survive a redeploy."
  warn "See the note above about recreating the service."
elif [[ -n "$volume_now" ]]; then
  say "Volume attached: $volume_now"
fi

cat <<EOF
$(say "Next steps")

  gg logs $PROJECT/$SERVICE        watch it boot

A healthy first boot logs 'storage check' (with dbPath $DB_PATH),
then 'telegram channel reachable', then 'insider bot starting'.

Then it goes quiet until the cron fires. At the default INGEST_CRON the first
cycle runs at 7 minutes past the next 3-hour mark, so an idle log is expected
rather than a hang.

The service is private and has no public URL. That is deliberate: this worker
only makes outbound calls and serves no HTTP.

To prove the volume works, run ./deploy.sh once more and check that the storage
check reports existedAtBoot: true. See DEPLOY.md section 5.
EOF
