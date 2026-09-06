# web — the open book

A Next.js app that renders the bot's calls. It reads the same Postgres the bot
writes to, server-side, and writes nothing.

Live it looks like a dealing screen: a status bar, a tape of the open book, and
one panel per position — the second-order chain, the news it came from, the
thesis, the catalyst with a countdown, and what would make it wrong. `/record`
is the settled P&L.

## How it reads the database

There is no API between this and the bot. Every page is a Server Component that
queries Postgres directly (`lib/db.ts`, `lib/queries.ts`), so the connection
string never leaves the server and there is no second service to keep in sync
with the schema.

Three rules the code holds to, each for a reason worth knowing:

- **It only ever `SELECT`s.** The bot owns the schema and applies it on every
  boot (`../src/db/migrate.ts`). A second process running `CREATE` statements
  against the same database would be a second opinion about the shape of it, and
  the first one to be wrong wins.
- **A missing table is a state, not a crash.** On a fresh project nothing stops
  this service booting before the bot has ever run, so `lib/read.ts` checks
  `to_regclass` first and renders "no book yet". The other failure it names is a
  database it cannot reach, which on gagarin is usually a missing `gg deps` edge
  — an undeclared call is *dropped* rather than refused, so it surfaces as a
  timeout rather than an error.
- **Columns are named, never `SELECT *`.** `calls` carries `entry_price` and
  `resolved_price`, which the bot records for its own scoring and never
  publishes. Naming columns means adding one to the schema does not silently put
  it on a public page.

Every page that reads is `export const dynamic = 'force-dynamic'`. That is not a
caching preference: without it `next build` would try to prerender these routes
inside a Docker build, on a machine with no database.

There is no login and no authorisation of any kind. The same calls are already
public in the Telegram channel, so a password here would protect nothing.

## What it exposes, and what it does not

Everything here is public on purpose, so the question worth answering is what is
*not*.

- **No credentials, in any form.** The service is deployed with `DB_URL`, `TZ`
  and `NODE_ENV` and nothing else — no OpenAI, Telegram, Finnhub or Marketaux
  key ever reaches the one container that answers requests from the internet.
  `lib/db.ts` and `lib/queries.ts` import `server-only`, so importing them from a
  Client Component is a build error rather than a connection string in a browser
  bundle.
- **No prices.** `calls.entry_price` and `calls.resolved_price` are recorded by
  the bot for scoring and are never selected. The queries name their columns.
- **No error internals.** A database that cannot be reached renders a written
  explanation; the driver's message is logged for `gg logs` and never sent to the
  browser.
- **No input surface.** The site reads no query parameters, cookies or headers,
  and has no forms. Every SQL value is a bound parameter.
- **Hostile links are not linked.** Article URLs come out of RSS, Marketaux and
  EDGAR and are stored verbatim, and React does not block `javascript:` in an
  `href`. `safeUrl()` in `lib/format.ts` allows `http:` and `https:` only;
  anything else renders as text. This is the defence — the CSP is not, because
  Next's inline hydration script forces `'unsafe-inline'`, which also permits
  `javascript:` URLs. `next.config.ts` says so where the header is set.

Response headers set in `next.config.ts`: a CSP, `nosniff`, `X-Frame-Options:
DENY` and `frame-ancestors 'none'`, `Referrer-Policy:
strict-origin-when-cross-origin` (so a publisher's logs never learn which call
sent the reader), a `Permissions-Policy` denying everything, and HSTS.

One thing the site *will* show that you might not expect: a call the bot recorded
but never announced. The Telegram post is a notification of a decision, not the
decision itself, so a call is written whether or not the message lands — after a
Telegram outage, or under `DRY_RUN=true`, positions appear here with no
`posted_message_id`. That is the intended behaviour, not a leak, but it means
`DRY_RUN` is not a way to run a cycle that changes nothing.

## Running it

Needs a Postgres with the bot's schema. From the project root,
`docker compose up -d db` gives you one on host port 5433, and the bot creates
its tables the first time it runs.

```bash
npm install
DB_URL=postgres://insider:insider@localhost:5433/insider npm run dev
```

Or bring up the database, the worker and the site together — the site lands on
<http://localhost:3000>:

```bash
cd .. && docker compose up --build
```

An empty book on a fresh database is correct, not a fault. The bot posts a few
times a week at most.

## Deploying

`../deploy.sh` ships this as a second gagarin service, `web`, reaching the same
`db` resource and holding no other credentials. See "The website" in
`../DEPLOY.md` — including how to keep it private if you would rather.

## Layout

```
app/
  layout.tsx          terminal chrome; per-request, because the header reads the book
  page.tsx            the open book
  record/             settled positions and the P&L blotter
  calls/[id]/         one position in full, with the news and the triage note
  health/route.ts     liveness; deliberately does not touch the database
components/           Terminal (status bar + tape), CallEntry, Chain, PnlBar, …
lib/
  db.ts               the pool, and the pg type parsers the bot also sets
  queries.ts          every read this site performs
  read.ts             the two ways reading fails, as values rather than exceptions
  format.ts           dates, returns, and the D-nn catalyst countdown
```

## Notes

- **Fonts load from Google Fonts at runtime**, not at build time, so a build
  machine without network access still produces a working image. Both faces have
  real fallback stacks.
- **`pg` is in `serverExternalPackages`.** It carries an optional
  `require('pg-native')` that only resolves when the native binding is installed;
  bundling it makes that conditional require a hard one and the build fails on a
  module nothing here wants.
- **The tape is the only unprompted motion on the site**, and it holds still
  under `prefers-reduced-motion`.
