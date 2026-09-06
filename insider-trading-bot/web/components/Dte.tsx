import { dte, fmtTermDay } from '@/lib/format'

/**
 * The catalyst date and the days to it.
 *
 * `D+n` — the window shut and the position is still open — is a real state and
 * is shown in the loss colour rather than hidden: the bot scores calls once a
 * week, so there is always a tail waiting to be settled, and saying so is more
 * honest than a bare date with no comment on it.
 */
export function Dte({ day, settled = false }: { day: string | null; settled?: boolean }) {
  if (!day) return null
  const countdown = dte(day)

  return (
    <span className="mono">
      {fmtTermDay(day)}{' '}
      {countdown && !settled ? (
        <span className={`dte dte--${countdown.tone}`}>
          {countdown.label}
          {countdown.tone === 'past' ? (
            <span className="visually-hidden"> — window closed, not yet scored</span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
