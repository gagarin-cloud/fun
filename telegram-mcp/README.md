# telegram-mcp

An MCP server that hands an agent **your own Telegram account** — not a bot.

Bots only see the groups they were added to, cannot search Telegram, cannot read
history, and cannot join anything. A userbot (the MTProto API behind the real
apps) sees exactly what you see. That is what makes the interesting request
possible:

> *"Find group chats and channels where people post IT job offers, find the
> messages looking for a DevOps engineer, and forward them to my Saved
> Messages."*

Deploy it, add it to Claude.ai or ChatGPT as a custom connector, sign in to
Telegram when it asks, and ask.

## What the agent can do

| Tool | What it does |
| --- | --- |
| `account_status` | Who the server is signed in as; current rate-limit cooldown |
| `search_chats` | Search Telegram's public directory for groups, channels and people |
| `resolve_chat` / `chat_info` | Turn a @username or link into a chat; description and member count |
| `list_chats` | The account's own chats, filterable by kind and name |
| `join_chat` / `leave_chat` | Join by username, public link or private invite link |
| `list_members` | Who is in a group — the raw material for lead lists |
| `user_info` | One person's profile and bio |
| `read_messages` | Page through a chat's history, forwards or backwards |
| `search_messages` | Full-text search inside one chat, or across everything joined |
| `send_message` | Text, with markdown/HTML, replies, silent delivery, scheduling |
| `send_file` | Media from a URL, from base64, or from a path on the server |
| `forward_messages` | Move messages to another chat — `"me"` is Saved Messages |
| `edit_message` / `delete_messages` | Fix or remove what the account sent |
| `mark_read` / `react` | Clear unread badges; put an emoji on a message |
| `download_media` | Pull a file off a message, inline as base64 or onto disk |

Chats can be named by `@username`, a `t.me` link, or an id another tool
returned. `"me"` means Saved Messages.

## Rate limits

Telegram limits userbots hard, and the punishment for ignoring that is the
account being restricted or banned. Two mechanisms keep this server on the right
side of it:

- **Token buckets per category.** Sends, joins, searches and downloads each have
  their own burst capacity and sustained rate, set in `.env`. Joins are the
  tightest by default (3 at once, 6 per hour) because joins are what Telegram
  punishes first.
- **A global cooldown on `FLOOD_WAIT`.** When Telegram does push back, every
  category backs off together. A short wait is slept through and retried; a long
  one comes back to the agent as an error naming the number of seconds, so it
  stops instead of hammering.

## Running it locally

```bash
cp .env.example .env     # fill in TELEGRAM_API_ID, TELEGRAM_API_HASH, ENCRYPTION_KEY
docker compose up --build
```

Then point an MCP client at `http://localhost:8080/mcp`. Anything that speaks
OAuth — Claude Code's `claude mcp add --transport http`, the MCP Inspector —
will walk you through the Telegram sign-in itself.

Without Docker: `npm install && npm run dev`.

## Deploying it

`./deploy.sh` ships it to Gagarin Cloud, gives it an address, and prints the two
URLs you need. [DEPLOY.md](DEPLOY.md) has every value it wants and where to get
it.

## How signing in works

The server is an OAuth 2.1 authorization server whose user database is Telegram
itself. Adding the connector is the whole setup — there is no key to paste:

1. Claude (or ChatGPT) discovers the server, registers itself dynamically, and
   sends you to `/authorize`.
2. The server redirects you to its own sign-in page, which offers two routes:
   **scan a QR code** with the Telegram app (Settings → Devices → Link Desktop
   Device), or type a phone number and the code Telegram sends. Either way you
   end up creating a new Telegram session — the same thing as logging in on a
   new device — and a two-factor password is asked for afterwards if the account
   has one.
3. That session is sealed with `ENCRYPTION_KEY` and handed back as the OAuth
   access and refresh tokens. The client stores them and sends them with every
   call.

So **the token is the Telegram session**. Nothing about your account is stored
on the server: no session file, no token table, no volume. A request arrives,
its token decrypts to a session, and Telegram decides whether that session is
still good. End it in the Telegram app under **Settings → Devices** and the very
next call fails — which also means the usual "revoke access" gesture works from
either side: removing the connector calls OAuth revocation, which logs that
Telegram session out for real.

### Why the QR route exists

Telegram treats every `api_id` from my.telegram.org as a third-party app, and
[third-party apps cannot receive login codes by SMS](https://core.telegram.org/api/auth)
— that was withdrawn in February 2023. A code of type `SentCodeTypeApp` is
delivered "as a Telegram service notification to all other logged-in sessions",
which means:

- the code only exists if that account is already signed in somewhere, and
- it lands in **that account's** service chat, so for a second account you have
  to switch accounts in the app to find it.

QR login has neither problem: the account is chosen on the phone by whoever
scans. It is the same flow Telegram Desktop and Web use, and it is why the page
offers it first for anyone who has their phone to hand.

Two consequences worth knowing:

- **`ENCRYPTION_KEY` is the server's identity.** Change it and every connector
  has to sign in again, because the tokens they hold stop decrypting. Nothing
  else breaks.
- **`PUBLIC_URL` is the OAuth issuer** and must be the address clients actually
  reach. `deploy.sh` sets it from the deployed address; locally it defaults to
  `http://localhost:8080`.

Accounts are pooled while they are being used: one live MTProto connection per
signed-in account, dropped after `ACCOUNT_IDLE_MINUTES` of quiet, capped at
`MAX_ACCOUNTS`. Each account gets its own rate limiter, because Telegram's
limits are per account.

## What it does not do

- **Anyone who can reach it can sign their own account in.** That is what makes
  it a connector rather than a personal script, but it does mean the deployment
  is open: registration is dynamic, and sign-in is rate limited per IP rather
  than gated by an invite. Keep the address to yourself if that is not what you
  want.
- **A token is the account.** Whoever holds one can read every private chat and
  message anyone as that account, so it should only ever live in a client you
  trust. Ending the session in the Telegram app is the way to undo a mistake.
- **Numeric chat ids are only good while the process lives.** Telegram requires
  an access hash alongside the id, and GramJS caches those in memory. After a
  restart, prefer usernames and links, or call `list_chats` / `search_chats`
  first to repopulate the cache.
- **Some groups hide their member list.** `list_members` will fail there; that
  is Telegram's privacy setting, not a bug.
- **Automating a user account is against the spirit of Telegram's ToS and can
  get the account limited or banned**, especially mass-DMing strangers. The rate
  limits here make that less likely, not impossible. Use an account you can
  afford to lose.

## Tests

```bash
npm test               # 196 tests
npm run test:coverage  # ~97% of src
npm run typecheck
```

The MTProto layer is behind a `Telegram` interface, so everything above it is
tested against fakes — no network, no account, no flakiness.
`test/tools.test.ts` drives a real MCP client over an in-memory transport, and
`test/http.test.ts` walks the entire OAuth flow the way Claude does: dynamic
registration, `/authorize`, the sign-in page, the code exchange with PKCE, a
tool call with the resulting token, a refresh, and a revocation that logs the
Telegram session out. Both sign-in routes are covered, including the QR
scan-then-migrate-data-centre path, and one test enumerates every
`SentCodeType*` in the installed GramJS so a new one cannot quietly become
"unknown" in front of a user.
