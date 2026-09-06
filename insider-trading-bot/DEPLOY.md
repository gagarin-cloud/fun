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
| An OpenAI account with credit | pay-per-token | 5 min |
| A Telegram bot + channel | free | 5 min |
| A Finnhub key | free tier | 2 min |
| A Marketaux key | free tier | 2 min |
| A contact string for SEC EDGAR | free, no signup | 10 sec |
| Docker running locally | free | — |
| The `gg` CLI | free | 2 min |

Running it costs OpenAI tokens plus the two Gagarin components the deploy creates
(the worker and its Postgres) — see "What this costs" in section 4. Every API key
above is on a free tier.

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

You do **not** need to run `npm run migrate` for the deploy. The worker applies the
schema itself at boot (`src/db/index.ts` calls `migrate()`, and every statement is
`CREATE ... IF NOT EXISTS`), so a freshly provisioned database migrates itself.

`npm test` and `ingest:dry` need no database. Anything that opens one — `npm run
migrate`, `npm run score`, `npm run dev` — needs `DB_URL` to point at a Postgres
that is actually running; `docker compose up -d db` gives you one on host port
5433.

The website is a separate npm project in `web/` and runs against the same
database:

```bash
cd web && npm install
DB_URL=postgres://insider:insider@localhost:5433/insider npm run dev
```

It will render an empty book until the bot has run a cycle, which is the correct
answer rather than an error — see `web/README.md`. `docker compose up --build`
brings up all three (database, worker, website) together, with the site on
<http://localhost:3000>.

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
build. It creates the project if needed, provisions the database, then builds and
ships two services: the `bot` worker with your environment, and the `web`
website, which it also puts on a public address. Read `deploy.sh` before running
it; it is short and it explains each decision inline.

Three things it does that matter, and that you would have to remember by hand:

- **It provisions a `postgres` resource called `db`, and declares that each
  service reaches it.** That single `gg deps add` both opens the network route
  and hands the service its credentials as `DB_URL` — which is exactly the
  variable `src/config.ts` reads, so nothing has to be copied anywhere. The
  resource is created *before* the services, so neither boots into a window where
  its database does not exist.

  The declaration is a separate call rather than `--deps` on the ship, and that
  is deliberate: measured 2026-09-06, `gg ship --deps db` fails with
  `[store_error] still in use` when the ship is *creating* the service. It works
  on a service that already exists, so the bug only bites a first deploy. Both
  services tolerate the short window before the edge lands — the worker retries
  with backoff, and the website says so on the page.
- **It strips `DB_URL` out of what it sends.** Your local `.env` points at a
  Postgres on your own machine, which the cluster cannot reach. It would be
  ignored anyway — a resource's injected variable outranks anything a deploy
  passes — and a stale credential in a deploy call is worth not having at all.
- **It strips the quotes from your `.env` values.** This repo's `.env.example`
  quotes everything (`KEY="value"`), which is correct for a shell but would be
  passed through literally as part of the value by a plain `KEY=VALUE` reader.
- **It passes the complete environment on every deploy.** Gagarin replaces a
  service's environment wholesale on each deploy rather than merging, so a
  variable you forget to restate is a variable you removed. Always deploy via the
  script, never a bare `gg deploy`.

### What this costs

The deploy creates **three** billable things: the worker, the website and the
Postgres, all at size `s`. Check the current rate with `gg status insider-bot`,
which prints the day's accrued cost at the bottom of the table.

`DB_SIZE=m ./deploy.sh` moves the database up if you ever need it; you almost
certainly will not, since it serves one client that wakes every three hours and
one that renders a page.

`WEB_SIZE=m ./deploy.sh` is the fix if the website is ever OOM-killed — a
server-rendered Next.js app is the workload most likely to want it. You will not
have to guess: `gg status` reports the kill and names the size to move to. Start
at `s`; three pages of server-rendered HTML do not need more, and
`SKIP_WEB=1 ./deploy.sh` removes the cost entirely.

### On build time

The build takes about two minutes, and the first one takes longer only because
it pulls `node:22-bookworm-slim`.

Nothing is compiled. Every dependency is pure JavaScript — `pg` speaks the
Postgres wire protocol in JS rather than linking `libpq` — so the image needs no
build toolchain, no Python, and no `node-gyp`. The Dockerfile installs with
`--ignore-scripts` in both stages for that reason.

This used to be the fiddliest part of the deploy. The SQLite version linked a
native binary that was specific to both glibc and the Node ABI, which forced the
builder and runtime stages onto the same base image and made a missing prebuild
fail as a mysteriously slow build rather than an error. None of that applies any
more.

### The website

`./deploy.sh` ships a second service, `web`, out of the `web/` directory: a
Next.js app that renders the open book straight out of the same Postgres. It
reaches `db` through the same `gg deps` edge the worker uses, and reads it
server-side — no API sits between them, and no connection string reaches a
browser.

**This is the one thing in the project that goes on the internet**, and the
script says so as it happens. `gg domain add` gives it a generated
`*.gagarin.cloud` address, which is instant and needs no DNS from you — gagarin
holds the wildcard record and the certificate. There is no login, by design: the
same calls are already public in the Telegram channel, so a password on the
website would protect nothing. Anyone with the link reads the book.

If you would rather it stayed private:

```bash
WEB_PUBLIC=0 ./deploy.sh    # ship it, but give it no address
SKIP_WEB=1 ./deploy.sh      # do not ship it at all
```

Two things the site deliberately does **not** get:

- **Your API keys.** The worker is passed the whole rendered `.env`; the website
  is passed `TZ` and `NODE_ENV` and nothing else. It only ever runs `SELECT`s, so
  handing the one container that answers requests from the internet your OpenAI
  and Telegram credentials would be a cost with no benefit.
- **Write access to the schema.** The bot owns the tables and applies them at
  boot. The site never migrates; a missing table renders as an empty state rather
  than as something to repair.

`entry_price` and `resolved_price` are in the `calls` table and are never
rendered — the queries in `web/lib/queries.ts` name their columns explicitly, so
adding a column to the schema does not quietly put it on the internet.

### Why the worker has no address

The worker makes only outbound calls. It listens on 8080 for one thing — a
liveness endpoint (`src/health.ts`), because gagarin decides a service is ready
by opening a connection to the port the deploy declared, and a container
listening nowhere never becomes ready. Nothing else connects to it, and it never
gets a domain.

---

## 5. Verify it is actually running

`gg ship` returning successfully means *the demand was recorded*, not *the thing
is running*. Those are different claims. This is the command that answers the
second one:

```bash
gg status insider-bot
```

`●` means the cluster agrees with what was asked for. `○` means it does not, and
the reason is printed beside it. The website's address hangs under its row; `gg
domain ls insider-bot` prints it on its own. Then read the logs:

```bash
gg logs insider-bot/bot
```

A healthy first boot logs, in order:

1. `storage check: schema created on this boot` — naming the database, its
   Postgres version, and `existedAtBoot: false`. False is correct on the very
   first boot; the tables did not exist yet.
2. `telegram channel reachable`
3. `insider bot starting` — echoing your models, schedules and `dryRun`.

If the database is still starting, you will first see a few
`database not reachable yet` warnings. That is expected on a brand-new project:
the worker retries for about a minute before giving up, because it and its
Postgres are created together and either can win the race to boot.

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

`existedAtBoot: true` on that second boot, with a non-zero event count, is your
proof the database is real and the history survived. If it says `false` again the
deploy is pointed at a different database from the one it filled — check
`gg deps ls insider-bot/bot` names `db`, and that nothing is overriding `DB_URL`.

Unlike the SQLite version, a broken database here is loud rather than silent: an
unreachable or misconfigured Postgres is a boot that retries and then exits, not
a worker that runs happily while writing to a filesystem that is about to be
thrown away. The deploy announcement in the channel says `fresh database` on any
boot that had to create the schema, so an unexpected one is visible without
reading logs at all.

To look at the data yourself:

```bash
gg resource secrets insider-bot/db     # prints DB_URL among the rest
psql "$(gg resource secrets insider-bot/db --format json | jq -r .env.DB_URL)"
```

Treat that output as a live credential — do not paste it anywhere.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Container exits immediately, log says `cannot reach the Telegram channel` | The bot is not an admin of the channel, or lacks Post Messages, or the id is wrong. The worker calls `getChat` at boot and exits 1 rather than running blind. |
| `Invalid environment configuration` and a list of keys | A required credential is empty in `.env`. Config is parsed once at startup so this fails now, not three hours in, mid-cycle. |
| Every OpenAI call fails with `insufficient_quota` | The key is valid; the account has no credit. Add billing. |
| EDGAR returns 403 | `SEC_USER_AGENT` is missing or not a real contact string. Repeat offences get the IP blocked. |
| `existedAtBoot: false` on every boot | The deploy is pointed at a different database each time. See "Confirming persistence" above. |
| Boot logs `database not reachable yet`, then exits | The `db` resource is not running (`gg status insider-bot`), or the worker does not declare it. `gg deps ls insider-bot/bot` should name `db`; if not, `gg deps add insider-bot/bot db`. |
| `Invalid environment configuration: DB_URL` | The service does not reach the `db` resource, so nothing injected `DB_URL`. Same fix as above. |
| Nothing posts, but the logs look clean | Working as intended, most likely. Gates are strict: conviction must be ≥7, one post per ticker per 72h, 3/day maximum. Days with nothing publishable are normal. Check `triage:dry` locally if you suspect the filter. |
| `[project_not_found]` from a `gg` command | The project name is wrong, or it belongs to another account. `gg projects` lists what you can reach. |
| The worker hangs on connect rather than failing | A missing `gg deps add`. An undeclared call is *dropped*, not refused, so it presents as a timeout rather than an error naming the cause. |

Read `gg logs insider-bot/bot` before changing anything. Nearly every failure
above names itself there.

## Operating it

```bash
gg status insider-bot                  # is it up, and what does it reach
gg logs insider-bot/bot                # what it is doing
gg history insider-bot/bot             # every deploy, newest first
gg rollback insider-bot/bot            # put the previous one back
./deploy.sh                            # ship a new build

gg resource backups insider-bot/db     # nightly dumps, kept 14 days
gg resource backup  insider-bot/db     # take one now, e.g. before a schema change
```

Postgres is dumped nightly and kept for fourteen days, which is the one real
durability gain over the SQLite file: there was no backup of that at all. A
restore always creates a *new* resource rather than overwriting a live one, so
recovering means `gg resource restore`, repointing the worker with `gg deps`, and
only then destroying the old database.

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
