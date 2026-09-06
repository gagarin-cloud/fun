# insider-bot

A headless worker that reads company news, reasons about **second-order
beneficiaries**, and posts a small number of high-conviction trade ideas to a
Telegram channel with a 1–3 month horizon.

The motivating pattern: "Microsoft announced a partnership with Some LLC" is
rarely a signal on MSFT — a single partnership cannot move a multi-trillion-dollar
market cap. It is a signal on Some LLC, whose revenue base may have just changed
materially. Most of the value here is in the prompt layer that recognises that
asymmetry and rejects the ~95% of headlines that are noise.

The bot is **post-only**: it never reads updates, has no webhook, and handles no
commands.

## How a cycle works

```
every 3h                              Mondays 14:00 UTC
  fetch 4 sources                       resolve open calls past their catalyst
  dedupe → new events                   post a scorecard recap
  record as seen  ── crash-safe here
  triage           (gpt-5.6-luna, ~25 headlines/call, cheap)
  enrich + thesis  (stronger model, per surviving event)
  gate             (conviction / cooldown / daily cap)
  post → Telegram
  persist the call (only after delivery is confirmed)
```

Events are marked seen **before** triage, so a crash mid-cycle can't cause the
same batch to be paid for twice. The `calls` row is written **after** Telegram
confirms delivery, so the channel and the database can't disagree.

## Sources

| Source | Cost | Why it's here |
| --- | --- | --- |
| PR wires (RSS) | free | Partnership/contract announcements land here first, with the deal specifics the thesis needs |
| SEC EDGAR 8-K | free | Item 1.01 is the authoritative "X entered a material agreement with Y" |
| Marketaux | free tier, 100 req/day | Ticker-tagged international coverage. Marginal — see below |
| Finnhub | free tier, 60 req/min | Quotes and fundamentals for gates 1/3. News feed **off by default** |

### Measured live, 2026-08-14

| | events/cycle | triage passes |
| --- | --- | --- |
| RSS wires | ~18–23 | the partnership / customer-win cases |
| EDGAR 8-K | ~45–67 | the acquirer and material-agreement cases |
| Marketaux | 3 | none observed |
| Finnhub news | ~100 | **zero** |

Three findings, all already acted on in the code:

- **Finnhub's `category=general` is Reuters *world* news** — macro, commodities,
  geopolitics — not company events. It contributed 68 of 174 triage rejections and
  zero passes: ~38% of the triage token spend for no signal. Now behind
  `FINNHUB_NEWS_ENABLED` (default `false`). Finnhub is still always used for quotes
  and fundamentals, which is its real job here. It also returns `200 []`
  intermittently, so don't read an empty count as a bug.
- **Marketaux's free plan caps responses at 3 articles per request** and silently
  ignores `limit` — `meta.found` reports millions while `data` stays at 3. Kept
  because it's free and adds coverage the others lack; dropping it would cost little.
- **EDGAR Item 7.01 (Reg FD) alone is not an event** — it's almost always earnings
  slides. It now only qualifies a filing when paired with another item of interest.

Net effect: 179 events/cycle → 60, while absolute triage passes went *up*, 5 → 7.
Pass rate is now ~7–12%; it was ~3% against the raw feed. **Watch the absolute pass
count, not the rate** — the denominator is pre-filtered now. Above ~15 passes/cycle
means the filter has gone loose.

X/Twitter is deliberately absent. Since Feb 2026 it is pay-per-use at $0.005 per
post read (the flat $200 tier was retired for new developers), which is real money
for the noisiest available source.

## The two LLM stages

**Stage 1 — triage** (`src/llm/prompts/triage.md`). Cheap, high-recall, batched.
Throws out earnings coverage, analyst actions, listicles, financing mechanics and
mega-cap-only events, then names the ticker most likely to actually *move* — which
is frequently not the ticker the headline is tagged with. Target pass rate ~5%.

**Stage 2 — thesis** (`src/llm/prompts/thesis.md`). This is where the edge lives.
Seven gates, all of which must pass:

1. **Asymmetry** — impact must be ≥~5% of the beneficiary's revenue. For
   pre-revenue companies (clinical-stage biotech and the like, where Finnhub
   reports $0 revenue) it switches to a market-cap denominator, ≥20% of cap — the
   revenue test is undefined there and would otherwise reject the whole category.
2. **Second-order mapping** — counterparty, supplier, licensor, or the competitor
   who just lost.
3. **Priced-in** — already +15% over 13 weeks means the trade is gone.
4. **Catalyst** — a specific, datable event inside 100 days. "Continued execution"
   is not a catalyst.
5. **Falsification** — must name the single most likely way it's wrong. It gets
   published in the post.
6. **Not merger arbitrage** — a company being acquired at an announced price pins
   just below that price, leaving a 2–5% spread that would score as a loss. The
   *acquirer* is still fair game. Triage rejects the obvious cases too, so the
   expensive stage isn't spent on them.
7. **Liquidity** — no sub-$50M caps, no OTC, no promotional shells.

Only conviction ≥7 is publishable. Both model IDs are env-configurable.

## What gets posted

Ticker, direction, thesis, the causal chain, catalyst + date, main risk,
conviction, source link, disclaimer. **No entry, target or stop levels.**

An entry price *is* recorded silently at post time, because scoring is impossible
without it — but nothing in the channel states a level.

## Setup

```bash
cp .env.example .env    # then fill it in
npm install
docker compose up -d db # a Postgres to develop against, on host port 5433
npm run migrate         # apply the schema
```

The seven required values are the six credentials at the top of `.env.example`
plus `DB_URL`; everything below them has a default in `src/config.ts`. Three
easy-to-miss ones:

- `DB_URL` has **no default**, on purpose. A worker that guessed its way to the
  wrong database would run perfectly and write its call history somewhere nobody
  reads, so a missing one is a crash at boot instead.
- `SEC_USER_AGENT` must be a real contact string (`"insider-bot you@example.com"`).
  EDGAR returns 403 without it and will eventually block the IP.
- The Telegram bot must be added to the channel **as an admin with Post Messages**,
  or every send fails with 403. The worker checks this at boot and refuses to start.

## Verify before spending tokens

Run these in order. Each is safe — nothing posts and nothing is written to the
database except by `migrate`.

```bash
npm run ingest:dry            # all 4 sources → normalised, deduped events. No LLM calls.
npm run triage:dry            # + stage 1, prints every pass AND rejection with reasons
npm run thesis:dry -- --limit 3   # + stage 2, prints the rendered Telegram message
npm test                      # unit tests: dedupe, gate, HTML escaping, score math
```

`triage:dry` is the highest-value one. Read the **rejections** as carefully as the
passes — a filter that rejects the right things for the wrong reasons will fail
differently tomorrow. It prints the pass rate; far from ~5% means tuning is needed.

Then do one real end-to-end run against a **private test channel**:

```bash
TELEGRAM_CHANNEL_ID=-100xxxxxxxxxx npm run dev
```

Confirm the message renders, a `calls` row appears, and a second idea on the same
ticker is blocked by the cooldown.

To check the recap without waiting a week: `npm run score -- --no-post` resolves
due calls silently; drop the flag to post.

## Deploy

**Starting from nothing?** [DEPLOY.md](DEPLOY.md) covers it end to end — where to
get each of the five API keys, how to wire up the Telegram bot, and deploying to
Gagarin Cloud with `./deploy.sh`.

Locally, or on any Docker host:

```bash
docker compose up -d --build
docker compose logs -f
```

Compose brings up a Postgres 17 alongside the worker and points `DB_URL` at it.
Port 5432 is published on the host as **5433**, to stay clear of a Postgres you
may already be running, so you can inspect calls and tune prompts with:

```bash
psql postgres://insider:insider@localhost:5433/insider
```

Two operational notes:

- The container runs unprivileged as `node` and writes nothing it needs to keep —
  all state is in Postgres. There is no volume to mount, nothing to `chown`, and
  no entrypoint shim.
- Compose stores the data in a **named volume**, which `docker compose down -v`
  deletes. Dump first if you care about the call history:
  `docker compose exec db pg_dump -U insider insider > insider.sql`.

`TZ=UTC` is pinned in compose so the cron schedules mean the same thing on any
host. SIGTERM stops the schedules, drains the in-flight cycle and then closes the
connection pool, so `docker compose restart` is safe mid-cycle.

At the default 3-hour interval the worker makes ~8 Marketaux calls/day against a
100/day free tier, so there is plenty of headroom under `INGEST_CRON`.

## Conventions

**Do not hand-roll API clients where an official, well-supported SDK exists.**
OpenAI → `openai` (Responses API + strict structured outputs, so there is no
output parsing anywhere). Telegram → `grammy`. Finnhub → `finnhub`. RSS/Atom →
`rss-parser`. Postgres → `pg`.

Exactly two modules talk raw HTTP, because no Node client exists for either:
`src/sources/marketaux.ts` and `src/sources/edgar.ts`. Both say so at the top. If
an SDK appears, migrate.

## A caveat worth stating

This is an idea-generation tool with no validated edge. The scoring job exists so
that claim can be tested empirically rather than assumed. Check the hit rate before
trusting any of it.
