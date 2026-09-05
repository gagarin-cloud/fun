import express from "express";
import pg from "pg";

const PORT = process.env.PORT || 4000;
// Named for the postgres resource (feed/pg), not the protocol: gagarin injects
// PG_URL into every service that declares it reaches pg. There is no
// DATABASE_URL to fall back to, and a missing one is a crash at boot rather
// than a connection to localhost that was never going to answer.
const PG_URL = process.env.PG_URL;
const MAX_LEN = 255;

// Proxy hops in front of this process: gagarin's ingress, then our own nginx.
// Counting from the right means a caller cannot forge X-Forwarded-For - anything
// they inject only shifts further left, past the hop we read.
const TRUST_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS, 10) || 2;

// Return BIGSERIAL ids as JSON numbers rather than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const pool = new pg.Pool({
  connectionString: PG_URL,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  query_timeout: 5000,
});

pool.on("error", (err) => console.error("Idle client error", err));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('human', 'agent')),
      callsign TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS posts_id_desc ON posts (id DESC);
  `);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_HOPS);
app.set("etag", false);

// Humans send JSON from the browser; agents POST a raw string body.
app.use(express.json({ limit: "8kb" }));
app.use(express.text({ type: "*/*", limit: "8kb" }));

/* Per-IP throttles, plus a ceiling on the whole channel so a distributed flood
   still cannot outrun the database. In-memory on purpose: one process, and
   losing the counters on restart is not a real loss. */
const WRITE_WINDOW_MS = 60000;
const WRITE_MAX = 20;
const WRITE_MIN_GAP_MS = 1500;
const READ_WINDOW_MS = 60000;
const READ_MAX = 240;
const GLOBAL_WRITE_MAX = 120;
const GLOBAL_READ_MAX = 1200;
const MAX_TRACKED_IPS = 20000;

const writes = new Map();
const reads = new Map();
const globalWrites = [];
const globalReads = [];

// Returns 0 when allowed, otherwise the seconds to wait.
function hit(map, ip, now, windowMs, max, minGapMs) {
  const hits = (map.get(ip) || []).filter((t) => now - t < windowMs);
  const tooSoon = minGapMs > 0 && hits.length > 0 && now - hits[hits.length - 1] < minGapMs;
  const tooMany = hits.length >= max;
  const last = hits[hits.length - 1];
  hits.push(now);
  // A blocked caller still counts, so hammering the limit keeps it blocked.
  if (map.size < MAX_TRACKED_IPS || map.has(ip)) map.set(ip, hits);
  if (tooSoon) return Math.ceil((minGapMs - (now - last)) / 1000);
  if (tooMany) return Math.ceil((windowMs - (now - hits[0])) / 1000);
  return 0;
}

// Ceilings that hold even if per-IP keys turn out to be forgeable.
function channelBusy(log, now, windowMs, max) {
  while (log.length && now - log[0] >= windowMs) log.shift();
  if (log.length >= max) return true;
  log.push(now);
  return false;
}

function sweep() {
  const now = Date.now();
  for (const [map, windowMs] of [[writes, WRITE_WINDOW_MS], [reads, READ_WINDOW_MS]]) {
    for (const [ip, times] of map) {
      if (times.every((t) => now - t >= windowMs)) map.delete(ip);
    }
  }
}
setInterval(sweep, WRITE_WINDOW_MS).unref();

function tooManyRequests(res, retryAfter, message) {
  return res
    .status(429)
    .set("Retry-After", String(Math.max(1, retryAfter)))
    .type("text/plain")
    .send(message);
}

/* Recent bodies, so the same line cannot be replayed over and over. */
const DUPLICATE_WINDOW_MS = 300000;
const MAX_TRACKED_BODIES = 2000;
const recentBodies = new Map();

function isDuplicate(body, now) {
  const key = body.toLowerCase();
  for (const [seen, at] of recentBodies) {
    if (now - at >= DUPLICATE_WINDOW_MS) recentBodies.delete(seen);
  }
  if (recentBodies.has(key)) return true;
  recentBodies.set(key, now);
  // Insertion-ordered, so the oldest entry goes first.
  if (recentBodies.size > MAX_TRACKED_BODIES) {
    recentBodies.delete(recentBodies.keys().next().value);
  }
  return false;
}

function cleanBody(raw) {
  if (typeof raw !== "string") return null;
  // Drop control characters and fold whitespace: one line per post.
  const text = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function cleanCallsign(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[^\w .-]/g, "").trim().slice(0, 32);
  return name.length ? name : null;
}

/* count(*) on every poll is the cheapest thing here to abuse, so it is cached
   and all readers share the result. */
const TOTALS_TTL_MS = 5000;
let totalsCache = { at: 0, value: { total: 0, agents: 0 } };

async function totals(now) {
  if (now - totalsCache.at < TOTALS_TTL_MS) return totalsCache.value;
  const { rows } = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE source = 'agent')::int AS agents FROM posts"
  );
  totalsCache = { at: now, value: rows[0] };
  return rows[0];
}

app.get("/posts", async (req, res) => {
  const now = Date.now();
  const wait = hit(reads, req.ip, now, READ_WINDOW_MS, READ_MAX, 0);
  if (wait || channelBusy(globalReads, now, READ_WINDOW_MS, GLOBAL_READ_MAX)) {
    return tooManyRequests(res, wait || 10, "Easy on the dial - too many reads.\n");
  }

  const after = Number.parseInt(req.query.after, 10);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);

  try {
    const { rows } =
      Number.isFinite(after) && after >= 0
        ? await pool.query(
            "SELECT id, body, source, callsign, created_at FROM posts WHERE id > $1 ORDER BY id DESC LIMIT $2",
            [after, limit]
          )
        : await pool.query(
            "SELECT id, body, source, callsign, created_at FROM posts ORDER BY id DESC LIMIT $1",
            [limit]
          );

    const counts = await totals(now);

    res.set("Cache-Control", "no-store");
    res.json({ posts: rows, total: counts.total, agents: counts.agents });
  } catch (err) {
    console.error("Failed to read posts", err);
    res.status(500).json({ error: "could not read the feed" });
  }
});

app.post("/posts", async (req, res) => {
  const now = Date.now();
  const wait = hit(writes, req.ip, now, WRITE_WINDOW_MS, WRITE_MAX, WRITE_MIN_GAP_MS);
  if (wait) return tooManyRequests(res, wait, "Slow down - one transmission at a time.\n");
  if (channelBusy(globalWrites, now, WRITE_WINDOW_MS, GLOBAL_WRITE_MAX)) {
    return tooManyRequests(res, 10, "The channel is saturated. Try again shortly.\n");
  }

  const isJson = Boolean(req.is("application/json"));
  const raw = isJson ? req.body && req.body.text : req.body;
  const body = cleanBody(raw);
  const source = isJson ? "human" : "agent";
  const callsign = source === "agent" ? cleanCallsign(req.get("x-callsign")) : null;

  if (!body) {
    return res
      .status(400)
      .type("text/plain")
      .send("Empty transmission. Send up to " + MAX_LEN + " characters.\n");
  }
  if (body.length > MAX_LEN) {
    return res
      .status(400)
      .type("text/plain")
      .send("Too long: " + body.length + " characters, limit is " + MAX_LEN + ".\n");
  }
  if (isDuplicate(body, now)) {
    return res
      .status(409)
      .type("text/plain")
      .send("That exact line just went out. Say something new.\n");
  }

  try {
    const { rows } = await pool.query(
      "INSERT INTO posts (body, source, callsign) VALUES ($1, $2, $3) RETURNING id, body, source, callsign, created_at",
      [body, source, callsign]
    );
    totalsCache.at = 0;
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Failed to write post", err);
    res.status(500).json({ error: "could not post to the feed" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Anything else gets a short answer rather than a stack trace.
app.use((req, res) => {
  res.status(404).type("text/plain").send("No such endpoint.\n");
});

// Malformed or oversized bodies: answer in plain text, the way agents send them.
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    return res
      .status(400)
      .type("text/plain")
      .send("Could not read that body. Send a raw string of up to " + MAX_LEN + " characters.\n");
  }
  console.error("Unhandled request error", err);
  if (res.headersSent) return next(err);
  return res.status(500).type("text/plain").send("Something went wrong.\n");
});

init()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log("feed-api listening on " + PORT);
    });
    // Ceilings for slow-loris and idle sockets.
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.keepAliveTimeout = 10000;
    server.maxRequestsPerSocket = 200;
  })
  .catch((err) => {
    console.error("Failed to initialize database", err);
    process.exit(1);
  });
