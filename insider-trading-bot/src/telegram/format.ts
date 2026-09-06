import type { Thesis } from '../llm/thesis.js'
import type { CallRow } from '../db/repo.js'

/**
 * Telegram's HTML parse mode is strict: an unescaped `&` or `<` anywhere in the
 * message body makes the whole sendMessage fail with a 400. Company names contain
 * both often enough ("Procter & Gamble", "<1% dilution") that every interpolated
 * value must go through here.
 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Telegram rejects messages over 4096 characters outright. */
const MAX_LEN = 4096

const DISCLAIMER = 'Automated research output. Not financial advice. Do your own diligence.'

export function formatSuggestion(t: Thesis, sourceUrl: string | null): string {
  const arrow = t.direction === 'long' ? '📈' : '📉'
  const label = t.direction === 'long' ? 'LONG' : 'SHORT'

  const parts: string[] = [
    `${arrow} <b>${esc(t.ticker)}</b> — ${label}` +
      (t.company ? ` · <i>${esc(t.company)}</i>` : ''),
    '',
    esc(t.thesis),
  ]

  if (t.secondOrderChain) {
    parts.push('', `<b>Why this company:</b> ${esc(t.secondOrderChain)}`)
  }

  if (t.catalyst) {
    const by = t.catalystBy ? ` (by ${esc(t.catalystBy)})` : ''
    parts.push('', `<b>Catalyst:</b> ${esc(t.catalyst)}${by}`)
  }

  if (t.keyRisk) {
    parts.push('', `<b>Main risk:</b> ${esc(t.keyRisk)}`)
  }

  parts.push('', `<b>Conviction:</b> ${t.conviction}/10`)

  if (sourceUrl) {
    parts.push(`<a href="${esc(sourceUrl)}">Source</a>`)
  }

  parts.push('', `<i>${esc(DISCLAIMER)}</i>`)

  return truncate(parts.join('\n'))
}

/**
 * Deploy announcement, posted once at boot.
 *
 * Doubles as an operational heartbeat: if the container starts crash-looping you
 * see repeated announcements in the channel, and a silent channel after a deploy
 * means the worker never came up. Both are useful without reading logs.
 */
export function formatDeployNotice(info: {
  commit: string | null
  /** The schema was not in the database before this boot. */
  freshDatabase: boolean
  seenEvents: number
  openCalls: number
  dryRun: boolean
}): string {
  const lines = ['🚀 <b>insider bot deployed</b>']

  if (info.commit) lines.push(`build <code>${esc(info.commit.slice(0, 7))}</code>`)

  // An unreachable database is a crash, so a notice arriving at all already means
  // storage works. What is worth saying is whether it is the *same* database as
  // last time: an empty one on a redeploy means this deploy is pointed somewhere
  // new, and the call history is sitting in a database nothing is reading.
  lines.push(
    info.freshDatabase
      ? '🆕 <b>fresh database</b> — schema created at boot, no history yet'
      : `storage ok · ${info.seenEvents} events seen · ${info.openCalls} open calls`,
  )

  if (info.dryRun) lines.push('<i>dry run — suggestions will be logged, not posted</i>')

  return truncate(lines.join('\n'))
}

export function formatRecap(
  resolved: readonly CallRow[],
  stillOpen: number,
  periodLabel: string,
): string {
  if (resolved.length === 0) {
    return truncate(
      [
        `<b>Scorecard — ${esc(periodLabel)}</b>`,
        '',
        `No calls resolved this period. ${stillOpen} still open.`,
        '',
        `<i>${esc(DISCLAIMER)}</i>`,
      ].join('\n'),
    )
  }

  const scored = resolved.filter((c) => c.return_pct != null)
  const wins = scored.filter((c) => c.status === 'won').length
  const losses = scored.filter((c) => c.status === 'lost').length
  const flat = scored.filter((c) => c.status === 'expired').length
  const mean = scored.length
    ? scored.reduce((s, c) => s + (c.return_pct ?? 0), 0) / scored.length
    : 0

  // resolvedSince() already orders by return_pct DESC.
  const best = scored[0]
  const worst = scored[scored.length - 1]

  const lines = [
    `<b>Scorecard — ${esc(periodLabel)}</b>`,
    '',
    `Resolved: ${scored.length} · won ${wins} · lost ${losses} · flat ${flat}`,
    `Hit rate: ${scored.length ? Math.round((wins / scored.length) * 100) : 0}%`,
    `Mean return: ${fmtPct(mean)}`,
    `Still open: ${stillOpen}`,
  ]

  if (best && worst && best.id !== worst.id) {
    lines.push(
      '',
      `Best: <b>${esc(best.ticker)}</b> ${fmtPct(best.return_pct ?? 0)}`,
      `Worst: <b>${esc(worst.ticker)}</b> ${fmtPct(worst.return_pct ?? 0)}`,
    )
  }

  lines.push('', `<i>${esc(DISCLAIMER)}</i>`)
  return truncate(lines.join('\n'))
}

function fmtPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

/**
 * Trim to Telegram's limit. Three things would make the result unparseable and
 * fail the whole send with a 400, so all three are handled: cutting inside a tag,
 * cutting inside an entity, and leaving a tag open.
 */
export function truncate(msg: string, max = MAX_LEN): string {
  if (msg.length <= max) return msg
  const ellipsis = '\n…'
  let cut = msg.slice(0, max - ellipsis.length)

  // Don't end mid-tag.
  const lastLt = cut.lastIndexOf('<')
  const lastGt = cut.lastIndexOf('>')
  if (lastLt > lastGt) cut = cut.slice(0, lastLt)

  // Don't end mid-entity.
  const lastAmp = cut.lastIndexOf('&')
  const lastSemi = cut.lastIndexOf(';')
  if (lastAmp > lastSemi) cut = cut.slice(0, lastAmp)

  return cut + ellipsis + closeOpenTags(cut)
}

/**
 * Return the closing tags needed to balance whatever `html` left open, innermost
 * first. Only the tags this module emits are considered.
 */
function closeOpenTags(html: string): string {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)(b|i|a|code|pre|u|s)\b[^>]*>/gi)) {
    const closing = m[1] === '/'
    const tag = m[2]?.toLowerCase()
    if (!tag) continue
    if (closing) {
      const idx = stack.lastIndexOf(tag)
      if (idx !== -1) stack.splice(idx, 1)
    } else {
      stack.push(tag)
    }
  }
  return stack
    .reverse()
    .map((t) => `</${t}>`)
    .join('')
}
