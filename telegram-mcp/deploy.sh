#!/usr/bin/env bash
#
# Deploy the Telegram MCP server to Gagarin Cloud.
#
# Assumes .env is complete. See DEPLOY.md for how to get each value.
#
# Idempotent: run it again to ship a new build. Nothing is stored server-side —
# each connected account lives inside the OAuth token its client holds — so a
# redeploy does not sign anybody out.
#
#   ./deploy.sh                        deploy as project "telegram-mcp"
#   PROJECT=leads ./deploy.sh          deploy under a different project name
#   DRY_RUN_DEPLOY=1 ./deploy.sh       print what it would do, change nothing
#   PUBLIC=0 ./deploy.sh               ship it, but give it no public address
#
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="${PROJECT:-telegram-mcp}"
SERVICE="${SERVICE:-mcp}"
PORT="${PORT:-8080}"

# s = 0.5 vCPU / 1GB shared. One MTProto connection per signed-in account and a
# handful of requests a minute; Telegram is the bottleneck, not this.
SIZE="${SIZE:-s}"

ENV_FILE="${ENV_FILE:-.env}"

REQUIRED_KEYS=(TELEGRAM_API_ID TELEGRAM_API_HASH ENCRYPTION_KEY)

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

command -v gg >/dev/null 2>&1 || die "gg is not installed. See DEPLOY.md section 3."
command -v docker >/dev/null 2>&1 || die "docker is not installed; gg needs it to build the image."
docker info >/dev/null 2>&1 || die "the docker daemon is not running. Start Docker and retry."
gg whoami >/dev/null 2>&1 || die \
  "gg has no credentials on this machine. Run 'gg signup <your-email>', click the
       link in the email, then 'gg auth --claim <code>'. See DEPLOY.md section 3."

say "Authorised as $(gg whoami | awk '/^account/ {print $2}')"

say "Refreshing registry login"
run gg registry login >/dev/null 2>&1 \
  || warn "gg registry login failed; the push may fail. Try running it by hand."

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Run 'cp .env.example .env' and fill it in (DEPLOY.md section 1)."
[[ -f Dockerfile ]] || die "no Dockerfile here; run this script from the project directory."

# ------------------------------------------------------- validate the env file

say "Validating $ENV_FILE"

env_value() {
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$ENV_FILE" \
    | tail -n1 \
    | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

missing=()
for key in "${REQUIRED_KEYS[@]}"; do
  [[ -n "$(env_value "$key")" ]] || missing+=("$key")
done
if (( ${#missing[@]} )); then
  die "these required keys are empty in $ENV_FILE: ${missing[*]}
       DEPLOY.md section 1 explains where to get each one."
fi

key="$(env_value ENCRYPTION_KEY)"
if (( ${#key} < 32 )); then
  die "ENCRYPTION_KEY is ${#key} characters. It encrypts every token this server
       issues, and each token carries somebody's Telegram session — use at least
       32, e.g. 'openssl rand -hex 32'."
fi

# ------------------------------------------- build the environment gg will send

# Rewritten rather than passed straight through: .env may quote its values, and
# PUBLIC_URL must be the deployed address rather than whatever a local run used.
# Written 0600 and deleted on exit — it holds the encryption key.
RENDERED_ENV="$(mktemp -t telegram-mcp-env.XXXXXX)"
chmod 600 "$RENDERED_ENV"
SHIP_LOG="$(mktemp -t telegram-mcp-ship.XXXXXX)"
trap 'rm -f "$RENDERED_ENV" "$SHIP_LOG"' EXIT

while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue

  k="${BASH_REMATCH[1]}"
  v="${BASH_REMATCH[2]}"

  # Set explicitly below; never taken from the file.
  [[ "$k" == "PUBLIC_URL" || "$k" == "PORT" || "$k" == "TZ" || "$k" == "NODE_ENV" ]] && continue

  v="$(printf '%s' "$v" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  [[ -z "$v" ]] && continue

  printf '%s=%s\n' "$k" "$v" >> "$RENDERED_ENV"
done < "$ENV_FILE"

say "Prepared $(wc -l < "$RENDERED_ENV" | tr -d ' ') environment variables"

# ------------------------------------------------------------ create the project

if gg projects 2>/dev/null | awk '{print $1}' | grep -qx "$PROJECT"; then
  say "Project '$PROJECT' already exists"
else
  say "Creating project '$PROJECT'"
  run gg init "$PROJECT"
fi

# The service row from `gg status`, with the ●/○ health marker stripped so the
# service name lands in field 1.
service_row() {
  gg status "$PROJECT" 2>/dev/null | sed -E 's/^[[:space:]]*[●○◐][[:space:]]*//' | awk -v s="$SERVICE" '$1 == s'
}

# A service that was created with a volume must be given the same one on every
# deploy or the deploy is refused. This server keeps no state and asks for no
# volume, but a deployment made by an older version of it has one, so whatever
# is already there is restated.
volume_args=()
row="$(service_row || true)"
if [[ "$row" =~ ([0-9]+)GB[[:space:]]+(/[^[:space:]]+) ]]; then
  volume_args=(--volume "${BASH_REMATCH[2]}" --volume-size "${BASH_REMATCH[1]}")
  say "Keeping the existing ${BASH_REMATCH[1]}GB volume at ${BASH_REMATCH[2]} (unused; it cannot be removed)"
fi

# The address this thing answers on, which is also its OAuth issuer.
address_of() {
  gg domain ls "$PROJECT" 2>/dev/null \
    | awk -v s="$SERVICE" '$0 ~ s {for (i=1;i<=NF;i++) if ($i ~ /\./) {print $i; exit}}'
}

ADDRESS="$(address_of || true)"
[[ -n "$ADDRESS" ]] && say "Service answers on https://$ADDRESS"

# --------------------------------------------------------------------- ship

ship() {
  local public_url="$1"
  run gg ship "$PROJECT/$SERVICE:$PORT" \
    --size "$SIZE" \
    "${volume_args[@]}" \
    --env-file "$RENDERED_ENV" \
    --env "PUBLIC_URL=$public_url" \
    --env "PORT=$PORT" \
    --env "TZ=UTC" \
    --env "NODE_ENV=production"
}

say "Building and shipping (~2 min; longer on the first run)"
if [[ -n "$ADDRESS" ]]; then
  ship "https://$ADDRESS"
else
  # Nothing has an address yet. Ship first (a service must exist before it can be
  # given one), then hand it its own address, since that address is the OAuth
  # issuer and has to be baked into the environment.
  ship "http://localhost:$PORT" 2>&1 | tee "$SHIP_LOG"
fi

# ------------------------------------------------------------------- address

if [[ "${PUBLIC:-1}" == "0" ]]; then
  say "PUBLIC=0 — leaving '$PROJECT/$SERVICE' private (no address)"
  warn "OAuth needs a public address: clients cannot sign in until 'gg domain add' runs."
elif [[ -z "$ADDRESS" ]]; then
  say "Giving '$PROJECT/$SERVICE' a public address"
  run gg domain add "$PROJECT/$SERVICE"

  if [[ -z "${DRY_RUN_DEPLOY:-}" ]]; then
    ADDRESS="$(address_of || true)"
    IMAGE="$(grep -oE '^[[:space:]]*'"$SERVICE"':[0-9]+' "$SHIP_LOG" | tail -n1 | tr -d ' ')"
    [[ -n "$ADDRESS" && -n "$IMAGE" ]] || die \
      "could not read back the new address or image tag. Re-run ./deploy.sh — now that
       the address exists, the second run bakes it in."

    # No rebuild: the same image, redeployed with the issuer it now knows.
    say "Telling it its own address (https://$ADDRESS) and redeploying that image"
    run gg deploy "$PROJECT/$SERVICE:$PORT" "$IMAGE" \
      --size "$SIZE" \
      "${volume_args[@]}" \
      --env-file "$RENDERED_ENV" \
      --env "PUBLIC_URL=https://$ADDRESS" \
      --env "PORT=$PORT" \
      --env "TZ=UTC" \
      --env "NODE_ENV=production"
  fi
fi

if [[ -n "${DRY_RUN_DEPLOY:-}" ]]; then
  say "Dry run complete. Nothing was created, built or deployed."
  exit 0
fi

# -------------------------------------------------------------------- verify

say "Deploy submitted. Reading actual cluster state:"
echo
gg status "$PROJECT" || warn "could not read status; try 'gg status $PROJECT' again in a moment."
echo

[[ -n "$ADDRESS" ]] || ADDRESS="<your service's address — run: gg domain ls $PROJECT>"

cat <<EOF
$(say "Next steps")

  Add it as a custom connector — there is nothing to paste but the URL:

      https://$ADDRESS/mcp

  Claude or ChatGPT will discover the sign-in, send you to this server's own
  page for phone -> code -> two-factor, and store the result itself. Every
  connected account is a Telegram session that its owner can end at any time
  from the Telegram app under Settings -> Devices.

  Then ask for something real:

      "Find channels where people post IT job offers, look for messages hiring a
       DevOps engineer in the last week, and forward them to my Saved Messages."

  gg logs $PROJECT/$SERVICE        watch it work
  gg status $PROJECT               what is actually running
EOF
