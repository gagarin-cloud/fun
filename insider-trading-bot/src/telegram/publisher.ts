import { Bot, GrammyError, HttpError } from 'grammy'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'

/**
 * Post-only Telegram client.
 *
 * This bot never reads updates: no `bot.start()`, no webhook, no handlers. It
 * exists solely to call sendMessage. grammY is used purely as the API client —
 * nothing here talks to api.telegram.org directly.
 */

let bot: Bot | undefined

function getBot(): Bot {
  if (!bot) {
    // `botInfo` is normally fetched lazily via getMe on first use. We don't need
    // it (we never handle updates), but grammY only skips that call if we never
    // touch bot.botInfo — which we don't.
    bot = new Bot(loadConfig().TELEGRAM_BOT_TOKEN)
  }
  return bot
}

const MAX_ATTEMPTS = 4

/**
 * Send one message, retrying on rate limits and transient failures.
 *
 * Returns the message id on success, or null if it could not be delivered. The
 * caller must only persist a call *after* a non-null return, so a Telegram outage
 * loses nothing: the event stays untriaged-as-posted and the suggestion is simply
 * not recorded.
 */
export async function postMessage(
  html: string,
  opts: {
    /**
     * Send even when DRY_RUN is set. Only for operational messages such as the
     * deploy announcement — never for trade suggestions, which are exactly what
     * DRY_RUN exists to suppress.
     */
    force?: boolean
  } = {},
): Promise<number | null> {
  const { TELEGRAM_CHANNEL_ID, DRY_RUN } = loadConfig()

  if (DRY_RUN && !opts.force) {
    logger.info({ html }, 'DRY_RUN — message not sent')
    return 0
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const msg = await getBot().api.sendMessage(TELEGRAM_CHANNEL_ID, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      return msg.message_id
    } catch (err) {
      const wait = retryDelayMs(err, attempt)
      if (wait === null || attempt === MAX_ATTEMPTS - 1) {
        logger.error({ err, attempt }, 'telegram send failed, giving up')
        return null
      }
      logger.warn({ err: describe(err), attempt, wait }, 'telegram send failed, retrying')
      await sleep(wait)
    }
  }
  return null
}

/**
 * How long to wait before retrying, or null if the error is permanent.
 *
 * A 400 means the message itself is malformed (bad HTML, too long) and a 403
 * means the bot isn't in the channel — retrying either is pointless and just
 * delays the cycle.
 */
function retryDelayMs(err: unknown, attempt: number): number | null {
  if (err instanceof GrammyError) {
    // Telegram tells us exactly how long to wait on a 429.
    const retryAfter = err.parameters?.retry_after
    if (typeof retryAfter === 'number') return retryAfter * 1000 + 250
    if (err.error_code === 429) return 2 ** attempt * 2000
    if (err.error_code >= 500) return 2 ** attempt * 1000
    return null // 400 / 403 / 404 — permanent
  }
  // Network-level failure: worth a retry.
  if (err instanceof HttpError) return 2 ** attempt * 1000
  return null
}

function describe(err: unknown): string {
  if (err instanceof GrammyError) return `${err.error_code}: ${err.description}`
  if (err instanceof Error) return err.message
  return String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Verify the channel is reachable and writable before the worker settles into its
 * schedule — a bad token or a bot that was never added to the channel is much
 * better discovered at boot than at 03:00 when the first idea lands.
 */
export async function verifyChannel(): Promise<boolean> {
  const { TELEGRAM_CHANNEL_ID } = loadConfig()
  try {
    const chat = await getBot().api.getChat(TELEGRAM_CHANNEL_ID)
    logger.info({ chat: chat.id, type: chat.type }, 'telegram channel reachable')
    return true
  } catch (err) {
    logger.error({ err: describe(err) }, 'telegram channel check failed')
    return false
  }
}
