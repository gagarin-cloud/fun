import cron from 'node-cron'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { getDb, closeDb, getDbInfo } from './db/index.js'
import { Repo } from './db/repo.js'
import { runCycle } from './pipeline/ingest.js'
import { runScoring } from './pipeline/score.js'
import { verifyChannel, postMessage } from './telegram/publisher.js'
import { formatDeployNotice } from './telegram/format.js'

const config = loadConfig()

// Fail fast on a bad DB path or unwritable volume rather than at the first cycle.
const db = getDb()

/**
 * Storage check.
 *
 * Persistence failing is silent by nature: if a mount isn't in effect, the app
 * creates its database on the container filesystem, every query works, and the
 * whole `calls` history — the scoring dataset — is destroyed on the next deploy.
 *
 * `existedAtBoot: false` on a restart is the tell. RAILWAY_VOLUME_* are injected
 * by Railway only when a volume is actually attached, so their absence localises
 * the fault to the platform side rather than our path handling.
 */
// Captured here so the deploy announcement below can report it.
let storageOk = true
let seenEventsAtBoot = 0
let openCallsAtBoot = 0

{
  const repo = new Repo(db)
  const info = getDbInfo()
  const volumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? null
  const seenEvents = repo.countSeenEvents()
  seenEventsAtBoot = seenEvents
  openCallsAtBoot = repo.countOpenCalls()

  const details = {
    dbPath: info?.path,
    resolvedPath: info?.resolvedPath,
    existedAtBoot: info?.existedAtBoot ?? null,
    freeMB: info?.freeBytes == null ? null : Math.round(info.freeBytes / 1e6),
    volumeMountPath,
    volumeName: process.env.RAILWAY_VOLUME_NAME ?? null,
    seenEvents,
    calls: repo.countCalls(),
  }

  // A database that is inside the declared mount path and already had rows is
  // proof of working persistence. Anything else is worth shouting about, because
  // the alternative is discovering it after losing a month of scored calls.
  const onVolume = volumeMountPath != null && info?.resolvedPath.startsWith(volumeMountPath)
  if (volumeMountPath != null && !onVolume) {
    storageOk = false
    logger.error(
      details,
      'storage check: database is NOT inside the Railway volume mount — data will be lost on redeploy',
    )
  } else if (volumeMountPath == null && process.env.RAILWAY_ENVIRONMENT_NAME != null) {
    storageOk = false
    logger.error(
      details,
      'storage check: running on Railway with no volume attached — data will be lost on redeploy',
    )
  } else {
    logger.info(details, 'storage check')
  }
}

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
    storageOk,
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
 * checkpoint and close the database. `docker compose restart` mid-write would
 * otherwise risk leaving a hot WAL behind.
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

  closeDb()
  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection')
})
