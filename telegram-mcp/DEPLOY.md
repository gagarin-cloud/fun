# Deploying telegram-mcp

Everything this needs, where each value comes from, and what it costs.

## 1. The `.env` file

```bash
cp .env.example .env
```

| Key | Required | Where it comes from | Cost |
| --- | --- | --- | --- |
| `TELEGRAM_API_ID` | yes | <https://my.telegram.org> → *API development tools* → create an app | free |
| `TELEGRAM_API_HASH` | yes | same page | free |
| `ENCRYPTION_KEY` | yes | `openssl rand -hex 32` | free |
| `PUBLIC_URL` | no | `deploy.sh` sets it to the deployed address; defaults to `http://localhost:$PORT` | — |
| `ACCOUNT_IDLE_MINUTES`, `MAX_ACCOUNTS` | no | how long accounts stay connected and how many at once | — |
| `RATE_LIMIT_*` | no | see the README; defaults are deliberately conservative | — |

`my.telegram.org` asks for the phone number of an existing Telegram account and
sends the login code to that account's other sessions. The `api_id` it gives you
is tied to that account, but any account can then sign in through the server —
they are not required to be the same person.

**These two values are not a bot token.** A bot token (`123456:ABC…` from
BotFather) will not work here and could not do any of what this server does.

## 2. Run it on your own machine first

```bash
docker compose up --build
```

- <http://localhost:8080/health> — should say `{"status":"ok"}`.
- <http://localhost:8080/.well-known/oauth-authorization-server> — the metadata
  an MCP client discovers.

Then connect something that speaks OAuth and let it drive the sign-in:

```bash
npx @modelcontextprotocol/inspector      # point it at http://localhost:8080/mcp
claude mcp add --transport http telegram http://localhost:8080/mcp
```

Visiting `/login` directly just says so: sign-in starts from the client, because
only the client can receive the authorization code at the end of it.

## 3. Get `gg` and an account

```bash
brew install gagarin-cloud/tap/gg     # or: go install github.com/gagarin-cloud/gg@latest
gg signup you@example.com             # click the link in the email
gg auth --claim <code>
gg whoami                             # should print your account
```

Docker must be running: `gg` builds the image locally before pushing it.

## 4. Deploy

```bash
./deploy.sh
```

It creates the project, builds and ships the image, gives the service a public
address, and — because that address is the OAuth issuer and has to be baked in —
redeploys the same image once with `PUBLIC_URL` set to it. Later runs already
know the address and ship once.

Nothing is stored server-side, so a redeploy signs nobody out: each connected
account lives inside the token its client holds.

```bash
DRY_RUN_DEPLOY=1 ./deploy.sh    # print every command, change nothing
PROJECT=leads ./deploy.sh       # a different project name
PUBLIC=0 ./deploy.sh            # no public address (useful for a private test)
```

Roughly two minutes, most of it the image build. `gg ship` returning zero means
the demand was recorded — `gg status telegram-mcp` is the thing that reads the
cluster and knows whether it is up.

## 5. Connect

Add the connector — there is nothing to paste but the URL:

**Claude.ai** → Settings → Connectors → *Add custom connector* →
`https://<address>/mcp`

**ChatGPT** → Settings → Connectors → *Add* → the same URL.

**Claude Code** → `claude mcp add --transport http telegram https://<address>/mcp`

The client registers itself, sends you to this server's sign-in page for
phone → code → two-factor, and keeps the resulting tokens.

**Scan the QR code if you can.** Telegram does not send login codes by SMS to
third-party apps, so a phone-number sign-in only works when that account already
has a Telegram session somewhere — and the code arrives inside *that account's*
service chat, which is easy to miss when you run more than one account. Scanning
(Telegram → Settings → Devices → Link Desktop Device) picks the account on the
phone and sidesteps all of it.

If you do use the phone route, the page names the delivery method it got back,
and the server logs it too (`gg logs telegram-mcp/mcp` → `login code sent`).

Then ask for something real:

> Find channels where people post IT job offers, search them for messages hiring
> a DevOps engineer in the last week, and forward the good ones to my Saved
> Messages.

## 6. Operating it

```bash
gg logs telegram-mcp/mcp        # what it is doing
gg status telegram-mcp          # what is actually running, and its address
gg rollback telegram-mcp/mcp    # back to the previous image
```

- **Rotating `ENCRYPTION_KEY`:** change it in `.env` and redeploy. Every
  connector's tokens stop decrypting, so everyone reconnects — which is also the
  emergency stop if you ever think a token leaked.
- **Signing an account out:** from the Telegram app, Settings → Devices, end the
  session. Removing the connector in Claude does the same thing from the other
  end: it calls OAuth revocation, which this server implements by logging that
  Telegram session out.
- **Moving to a new address:** `PUBLIC_URL` is the OAuth issuer. Change it and
  clients that discovered the old one must reconnect.
- **`FLOOD_WAIT` in the logs** means Telegram is throttling the account. The
  server backs off on its own. If it happens constantly, lower the
  `RATE_LIMIT_*` values and redeploy.

## 7. What you are accepting

A token is the entire account: anyone holding one can read every private chat
and message anyone as its owner. Tokens live in whatever MCP client signed in,
so connect only clients you trust, and remember the undo is in the Telegram app
under Settings → Devices.

The deployment is open by design — any client that can reach it can register and
sign its own Telegram account in. Sign-in is rate limited per IP and each
account is rate limited separately, but there is no invite list. Keep the
address to yourself if you want it to stay yours.

Telegram does not love automated user accounts. The rate limits here are set to
keep a normal lead-generation workload well under the thresholds, but volume
outreach to strangers is exactly what gets accounts limited. Use an account
whose loss you could live with.
