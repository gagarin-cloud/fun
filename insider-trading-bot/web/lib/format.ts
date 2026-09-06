/**
 * Every date on this site is rendered in UTC, deliberately.
 *
 * The bot runs under `TZ=UTC` and writes catalyst dates as bare `YYYY-MM-DD`.
 * Formatting them in the server's local zone would move a date across midnight
 * for anyone west of UTC and quietly disagree with the Telegram post the same
 * call already appeared in.
 */

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** An ISO8601 timestamp as `12 Aug 2026`. */
export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : DAY.format(d)
}

/**
 * A bare `YYYY-MM-DD` as `4 Nov 2026`. The `T00:00:00Z` is what stops `new
 * Date('2026-11-04')`'s UTC-midnight value being formatted in a local zone.
 */
export function fmtDay(day: string | null): string {
  if (!day) return '—'
  const d = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? day : DAY.format(d)
}

/** A return as `+4.2%` / `-11.0%`. The sign is the point, so it is always shown. */
export function fmtPct(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return '—'
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

const UTC_DAY_MS = 86_400_000

/** Whole days between two instants, floored, counted from UTC midnight. */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())
  return Math.round((b - a) / UTC_DAY_MS)
}

/** `today`, `yesterday`, `12 days ago`. */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = daysBetween(d, now)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/**
 * How a catalyst date sits relative to today. `past` is a real state and worth
 * showing: the bot only scores calls once a week, so a call can legitimately sit
 * open for a few days after its window closed.
 */
export function catalystWindow(
  day: string | null,
  now = new Date(),
): { state: 'none' | 'ahead' | 'today' | 'past'; days: number } {
  if (!day) return { state: 'none', days: 0 }
  const d = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return { state: 'none', days: 0 }
  const days = daysBetween(now, d)
  if (days > 0) return { state: 'ahead', days }
  if (days === 0) return { state: 'today', days: 0 }
  return { state: 'past', days: -days }
}

/** `reuters.com` from a full URL; the bare string back if it will not parse. */
export function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Split a second-order chain into its steps.
 *
 * The thesis prompt asks for `event → mechanism → whose numbers change`, and the
 * model usually obliges with literal arrows — so when they are there, the chain
 * is typeset as a chain. When it answers in prose instead, this returns a single
 * step and the caller renders it as a sentence. Only real arrows are split on: a
 * bare `>` appears inside prose ("more than > 15%") often enough to be unsafe.
 */
export function chainSteps(chain: string | null): string[] {
  if (!chain) return []
  return chain
    .split(/\s*(?:→|->|—>|➜)\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// en-US rather than en-GB: en-GB abbreviates September as 'Sept', which is four
// characters where every other month is three and breaks the column.
const TERM = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
})

/** `04 SEP 26` — how a dealing screen writes a date. */
export function fmtTerm(iso: string | null): string {
  if (!iso) return '——'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '——'
  // en-US orders it month-first ('Sep 04, 26'); the desk writes it day-first.
  const parts = TERM.formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')} ${get('month')} ${get('year')}`.toUpperCase()
}

/** The same, for a bare `YYYY-MM-DD`. */
export function fmtTermDay(day: string | null): string {
  return day ? fmtTerm(`${day}T00:00:00Z`) : '——'
}

/**
 * Days to the catalyst in the desk's shorthand: `D-59` ahead, `D+3` past, `D-0`
 * on the day. `past` is a real and expected state — the bot scores calls once a
 * week, so a position sits open for a few days after its window shuts.
 */
export function dte(day: string | null, now = new Date()): { label: string; tone: string } | null {
  const { state, days } = catalystWindow(day, now)
  if (state === 'none') return null
  if (state === 'past') return { label: `D+${days}`, tone: 'past' }
  if (state === 'today') return { label: 'D-0', tone: 'near' }
  return { label: `D-${days}`, tone: days <= 14 ? 'near' : 'far' }
}
