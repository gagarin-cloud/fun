import cron from 'node-cron'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { getDb, initDb, closeDb } from './db/index.js'
import { Repo } from './db/repo.js'
import { runCycle } from './pipeline/ingest.js'
import { runScoring } from './pipeline/score.js'
import { verifyChannel, postMessage } from './telegram/publisher.js'
import { formatDeployNotice } from './telegram/format.js'

const config = loadConfig()

/**
 * Storage check.
 *
 * Fail fast on an unreachable database or bad credentials rather than three hours
 * later, mid-cycle. `initDb` retries for about a minute first, because on a fresh
 * project the worker and its postgres are created together and either can win the
 * race to boot.
 */
const dbInfo = await initDb()

// Captured here so the deploy announcement below can report them.
const repo = new Repo(getDb())
const seenEventsAtBoot = await repo.countSeenEvents()
const openCallsAtBoot = await repo.countOpenCalls()

/**
 * `existedAtBoot: false` means the schema was not there before this boot — a
 * genuine first deploy, or a deploy pointed at the wrong database. Unlike the
 * SQLite version this is not silent data loss (an unreachable database is a
 * crash, not an empty file quietly created on the container filesystem), so it
 * is reported rather than shouted about.
 */
logger.info(
  {
    server: dbInfo.server,
    database: dbInfo.database,
    serverVersion: dbInfo.serverVersion,
    existedAtBoot: dbInfo.existedAtBoot,
    seenEvents: seenEventsAtBoot,
    calls: await repo.countCalls(),
  },
  dbInfo.existedAtBoot ? 'storage check' : 'storage check: schema created on this boot',
)

logger.info(
  {
    triageModel: config.TRIAGE_MODEL,
    thesisModel: config.THESIS_MODEL,
    ingestCron: config.INGEST_CRON,
    scoreCron: config.SCORE_CRON,
    minConviction: config.MIN_CONVICTION,
    maxPostsPerDay: config.MAX_POSTS_PER_DAY,
    dryRun: config.DRY_RUN,
    tz: process.env.TZ ?? '(host default)',
  },
  'insider bot starting',
)

if (!config.DRY_RUN && !(await verifyChannel())) {
  logger.error('cannot reach the Telegram channel — check the token and that the bot is an admin')
  process.exit(1)
}

/**
 * Cycles must not overlap. node-cron will happily fire again while a slow cycle is
 * still running, which would double-post and race on the daily cap.
 */
let running: Promise<unknown> | null = null

async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (running) {
    logger.warn({ job: name }, 'previous job still running — skipping this tick')
    return
  }
  running = (async () => {
    try {
      await fn()
    } catch (err) {
      // A thrown job must never take the worker down; the next tick retries.
      logger.error({ err, job: name }, 'job failed')
    }
  })()
  try {
    await running
  } finally {
    running = null
  }
}

const ingestTask = cron.schedule(
  config.INGEST_CRON,
  () => void guarded('ingest', runCycle),
  { timezone: 'UTC' },
)

const scoreTask = cron.schedule(
  config.SCORE_CRON,
  () => void guarded('scoring', runScoring),
  { timezone: 'UTC' },
)

logger.info('schedules registered')

/**
 * Announce the deploy in the channel. Sent regardless of DRY_RUN — an operational
 * heartbeat is exactly what you want visible when suggestions are suppressed, and
 * repeated announcements are how a crash-loop makes itself obvious without logs.
 *
 * Failure is non-fatal: the worker is useful even if this one message doesn't land.
 */
void postMessage(
  formatDeployNotice({
    // Railway injects the commit SHA; absent locally and under docker-compose.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    freshDatabase: !dbInfo.existedAtBoot,
    seenEvents: seenEventsAtBoot,
    openCalls: openCallsAtBoot,
    dryRun: config.DRY_RUN,
  }),
  { force: true },
).then(
  (id) => logger.info({ messageId: id }, 'deploy announcement posted'),
  (err) => logger.warn({ err }, 'deploy announcement failed — continuing'),
)

/**
 * Graceful shutdown: stop taking new work, let the in-flight cycle finish, then
 * drain the connection pool. Without the drain, `pool.end()` never runs and the
 * server is left to time out connections that nothing is coming back for.
 */
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  // node-cron's stop() is synchronous — it just deregisters the timer.
  ingestTask.stop()
  scoreTask.stop()

  if (running) {
    logger.info('waiting for the in-flight job to finish')
    // Docker sends SIGKILL 10s after SIGTERM by default; bound the wait so we
    // still get a clean DB close rather than being killed mid-checkpoint.
    await Promise.race([running, new Promise((r) => setTimeout(r, 8000))])
  }

  await closeDb()
  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection')
})
