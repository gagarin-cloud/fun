# Deploying from scratch

This walks from an empty machine to a running worker on
[Gagarin Cloud](https://gagarin.cloud). Budget about 30 minutes, most of it
waiting on signup emails.

The worker is **post-only and outbound-only**: it fetches news, calls an LLM, and
posts to Telegram. It serves no HTTP, receives no webhooks, and needs no public
address. So there is no URL at the end of this — the deliverable is messages
arriving in your channel.

## What you need

| | Cost | Time |
| --- | --- | --- |
| An OpenAI account with credit | pay-per-token, **the only thing here that costs money** | 5 min |
| A Telegram bot + channel | free | 5 min |
| A Finnhub key | free tier | 2 min |
| A Marketaux key | free tier | 2 min |
| A contact string for SEC EDGAR | free, no signup | 10 sec |
| Docker running locally | free | — |
| The `gg` CLI | free | 2 min |

---

## 1. Credentials

Fill each of these into `.env`. Start by copying the template:

```bash
cp .env.example .env
```

Keep `.env` where it is. It is gitignored, and nothing in this repo will ever
commit it.

### `OPENAI_API_KEY`

1. Sign up at <https://platform.openai.com/signup>.
2. **Add credit** at <https://platform.openai.com/settings/organization/billing/overview>.
   Do this before anything else — a key on an account with no balance authenticates
   fine and then fails on every call with `insufficient_quota`, which reads like a
   broken key.
3. Create the key at <https://platform.openai.com/api-keys> → **Create new secret
   key**. It starts `sk-`. It is shown once; if you lose it, make another.

Two stages call the API, and they cost very differently. Triage runs on every
headline in batches of ~25 and is deliberately on a cheap model; the thesis stage
runs on the ~5–10% that survive and is where the money goes. `MAX_POSTS_PER_DAY`
and `MIN_CONVICTION` are the levers that bound spend.

The two model IDs live in `TRIAGE_MODEL` and `THESIS_MODEL`. Confirm your account
can actually see them before deploying — a model ID your org has no access to
fails at the first cycle, not at boot:

```bash
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | grep -o '"id":"[^"]*"' | sort
```

If either default is missing from that list, set the two variables to models you
do have. Both are env-configurable precisely so this is a config change and not a
code change.

### `TELEGRAM_BOT_TOKEN`

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`. Give it a display name, then a username ending in `bot`.
3. It replies with a token shaped `123456789:AAE…`. That is the whole credential —
   treat it like a password; anyone holding it can post as your bot.

### `TELEGRAM_CHANNEL_ID`

Create the channel first (Telegram → **New Channel**), then **add your bot as an
administrator with the "Post Messages" permission**. This is the single most
common setup failure: without admin rights every send fails with 403, and the
worker refuses to boot rather than pretending it is fine.

Then pick the form that matches your channel:

- **Public channel** — use the handle, including the `@`: `TELEGRAM_CHANNEL_ID="@myinsiderfeed"`.
- **Private channel** — you need the numeric id, which looks like `-1001234567890`.
  Post any message in the channel, then ask your bot what it saw:

  ```bash
  curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" \
    | grep -o '"chat":{"id":-[0-9]*'
  ```

  Alternatively, open the channel in <https://web.telegram.org> and read the
  `-100…` id out of the address bar.

Verify the pairing before you deploy anything. This is the same call the worker
makes at boot:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getChat?chat_id=<CHANNEL_ID>"
```

`"ok":true` means you are done. `"ok":false` with `chat not found` means the bot
is not in the channel, or the id is wrong.

### `FINNHUB_API_KEY`

Register at <https://finnhub.io/register>, then copy the key from
<https://finnhub.io/dashboard>. The free tier is 60 requests/minute, comfortably
more than this worker uses.

Finnhub supplies **quotes and fundamentals** — the market-cap and price-history
numbers behind thesis gates 1, 3 and 7. Its news feed is a separate thing and is
off by default (`FINNHUB_NEWS_ENABLED="false"`); the README explains why in detail.

### `MARKETAUX_API_KEY`

Register at <https://www.marketaux.com/register>, then copy the token from your
account dashboard. Free tier is 100 requests/day; at the default 3-hour schedule
this worker uses about 8.

This is the least valuable of the four sources — the free plan silently caps every
response at 3 articles. It is kept because it is free and adds coverage the others
lack. If signup is a hassle, know that you can drop it later with little loss.

### `SEC_USER_AGENT`

No signup and no key. The SEC requires a descriptive User-Agent with real contact
details on every EDGAR request, and enforces it: without one you get 403s and
eventually an IP block. See
<https://www.sec.gov/os/accessing-edgar-data>.

```
SEC_USER_AGENT="insider-bot you@yourdomain.com"
```

Use an address you actually read. This is the one credential where the polite
thing and the working thing are the same thing.

### Everything else

The six above are required. Every other key in `.env.example` has a default in
`src/config.ts` and can be left alone. Two worth knowing:

- `DRY_RUN="true"` runs the full pipeline — real news, real LLM calls, real
  spend — but logs the messages instead of sending them. Good for a first
  deploy. It also skips the Telegram check, so it will not catch a bad token.
- `MIN_MARKET_CAP_USD` skips the expensive thesis stage on micro-caps before
  paying for it.

---

## 2. Check it locally before spending anything on infrastructure

```bash
npm install
npm test              # 46 unit tests, no network, no keys needed
npm run ingest:dry    # all 4 sources → deduped events. No LLM calls, no spend.
npm run triage:dry    # + stage 1. Prints every pass AND rejection with reasons.
```

`ingest:dry` is the one that proves your Finnhub, Marketaux and SEC values are
right, and it costs nothing. Run it before you deploy. `triage:dry` is the first
command that spends money, and it is the one worth reading carefully — a filter
rejecting the right things for the wrong reasons will fail differently tomorrow.

You do **not** need to run `npm run migrate` for the deploy. The schema is applied
automatically the first time the database is opened (`src/db/index.ts` calls
`migrate()`), so a fresh volume migrates itself on first boot.

---

## 3. Install and authorise `gg`

```bash
gg whoami
```

If that names an account, skip ahead. If the command is not found:

```bash
go install github.com/gagarin-cloud/gg@latest
```

No Go on the machine? Take a released binary for your platform from
<https://github.com/gagarin-cloud/gg/releases> and verify the published checksum.
Don't pipe a script from a URL into a shell.

If it reports no credentials:

```bash
gg signup you@yourdomain.com
```

Click the button in the email — that one click creates the account and authorises
this machine. Then:

```bash
gg auth --claim <code-that-signup-printed>
```

This also logs Docker in to Gagarin's registry. There is no second account and no
token for you to copy anywhere.

---

## 4. Deploy

```bash
./deploy.sh
```

That is the whole thing. The script is idempotent — run it again to ship a new
build. It creates the project if needed, builds the image, pushes it, and starts
the worker with your environment. Read `deploy.sh` before running it; it is short
and it explains each decision inline.

Three things it does that matter, and that you would have to remember by hand:

- **It forces `DB_PATH=/data/insider.sqlite`**, overriding whatever your `.env`
  says. Your local `.env` points at `./data/` for local runs; on Gagarin that path
  is inside the container filesystem, so the database would be silently recreated
  empty on every deploy and the whole scoring dataset would evaporate. `/data` is
  the volume.
- **It strips the quotes from your `.env` values.** This repo's `.env.example`
  quotes everything (`KEY="value"`), which is correct for a shell but would be
  passed through literally as part of the value by a plain `KEY=VALUE` reader.
- **It passes the complete environment on every deploy.** Gagarin replaces a
  service's environment wholesale on each deploy rather than merging, so a
  variable you forget to restate is a variable you removed. Always deploy via the
  script, never a bare `gg deploy`.

### On build time

The build takes about two minutes, and the first one takes longer only because
it pulls `node:22-bookworm-slim`.

If you expected worse from a project with a native dependency: `better-sqlite3`
ships prebuilt binaries, and its install script tries `prebuild-install` before
falling back to `node-gyp`. The prebuild exists for linux/x64 on glibc, which is
what Gagarin runs, so nothing is ever compiled here.

The Dockerfile therefore installs **no** build toolchain, and that is load-bearing
rather than an omission. The fallback is spelled `prebuild-install || node-gyp
rebuild` — with a compiler present, a missing prebuild would quietly become a
full source build, which is slow natively and much slower under the QEMU
emulation Docker uses to cross-build linux/amd64 from an ARM Mac. With no
toolchain in the image that fallback cannot start, so the failure is immediate
and legible instead of showing up as a build that mysteriously takes fifteen
minutes. The deps stage asserts the binary loads before the build proceeds.

### Why there is no `gg domain add`

Because nothing should be able to open this. The worker makes only outbound
calls, so a public address would expose a port nothing is listening on and buy
you nothing. The service stays private. If you ever add an HTTP health endpoint,
that is the moment to reconsider — not now.

The port in the deploy command is nominal for the same reason: Gagarin wants a
port, this container listens on none, and since the service is private and has no
dependents, nothing ever connects to it.

---

## 5. Verify it is actually running

`gg ship` returning successfully means *the demand was recorded*, not *the thing
is running*. Those are different claims. This is the command that answers the
second one:

```bash
gg status insider-bot
```

`●` means the cluster agrees with what was asked for. `○` means it does not, and
the reason is printed beside it. Then read the logs:

```bash
gg logs insider-bot/bot
```

A healthy first boot logs, in order:

1. `storage check` — with `dbPath: /data/insider.sqlite` and `existedAtBoot: false`.
   False is correct on the very first boot; the file did not exist yet.
2. `telegram channel reachable`
3. `insider bot starting` — echoing your models, schedules and `dryRun`.

Then it waits for the cron. At the default `INGEST_CRON="7 */3 * * *"` the first
cycle runs at 7 minutes past the next 3-hour mark, so **an idle log is the
expected state**, not a hang. Set `INGEST_CRON="*/5 * * * *"` temporarily if you
want to watch a cycle immediately.

### Confirming persistence actually works

This is worth doing once, deliberately. Redeploy and read the storage check
again:

```bash
./deploy.sh
gg logs insider-bot/bot | grep 'storage check'
```

`existedAtBoot: true` on that second boot is your proof the volume is real and
the database survived. If it says `false` again, the database is being written to
the container filesystem and every restart is losing your call history — check
that `DB_PATH` is `/data/insider.sqlite` and that the volume was attached.

Be aware the code's own storage check cannot help you here. It looks for
`RAILWAY_VOLUME_*` variables to decide whether the database sits inside a mount;
on Gagarin those are absent, so it logs its findings and passes without judging
them. `existedAtBoot` across a redeploy is the real signal.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Container exits immediately, log says `cannot reach the Telegram channel` | The bot is not an admin of the channel, or lacks Post Messages, or the id is wrong. The worker calls `getChat` at boot and exits 1 rather than running blind. |
| `Invalid environment configuration` and a list of keys | A required credential is empty in `.env`. Config is parsed once at startup so this fails now, not three hours in, mid-cycle. |
| Every OpenAI call fails with `insufficient_quota` | The key is valid; the account has no credit. Add billing. |
| EDGAR returns 403 | `SEC_USER_AGENT` is missing or not a real contact string. Repeat offences get the IP blocked. |
| `existedAtBoot: false` on every boot | The database is not on the volume. See "Confirming persistence" above. |
| Nothing posts, but the logs look clean | Working as intended, most likely. Gates are strict: conviction must be ≥7, one post per ticker per 72h, 3/day maximum. Days with nothing publishable are normal. Check `triage:dry` locally if you suspect the filter. |
| `[project_not_found]` from a `gg` command | The project name is wrong, or it belongs to another account. `gg projects` lists what you can reach. |
| A `gg` command hangs talking to another service | Not applicable here — this project has one service and no dependencies. If you add one, the cause is almost always a missing `gg deps add`. |

Read `gg logs insider-bot/bot` before changing anything. Nearly every failure
above names itself there.

## Operating it

```bash
gg status insider-bot                  # is it up, and what does it reach
gg logs insider-bot/bot                # what it is doing
gg history insider-bot/bot             # every deploy, newest first
gg rollback insider-bot/bot            # put the previous one back
./deploy.sh                            # ship a new build
```

Prefer `gg rollback` to a corrective deploy when something you just shipped is
broken and you do not yet know why. It restores a state that provably ran,
including the environment that revision used, and it leaves the history intact
for the postmortem.

The weekly scorecard posts on `SCORE_CRON="0 14 * * 1"` — Mondays at 14:00 UTC.
That job is the point of the whole exercise: it resolves calls past their catalyst
date and reports the hit rate, so the claim that any of this works can be checked
rather than assumed.

## A caveat worth repeating

This is an idea-generation tool with no validated edge, and it is not financial
advice. Deploy it because reasoning about second-order effects is an interesting
problem, and check the hit rate before trusting a word it says.
