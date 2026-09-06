import { fmtPct } from '@/lib/format'
import type { Scoreboard as Numbers } from '@/lib/queries'

/**
 * The four numbers, with the hit rate computed rather than stored.
 *
 * `expired` positions — the window shut and the price went nowhere — count in
 * the denominator. Dropping them would flatter the hit rate by treating "nothing
 * happened" as though the call had never been made.
 */
export function Scoreboard({ numbers }: { numbers: Numbers }) {
  const hitRate = numbers.resolved > 0 ? Math.round((numbers.won / numbers.resolved) * 100) : null
  const mean = numbers.meanReturn

  return (
    <dl className="stats">
      <div>
        <dt className="field">Open positions</dt>
        <dd>{numbers.open}</dd>
      </div>
      <div>
        <dt className="field">Settled</dt>
        <dd>{numbers.resolved}</dd>
      </div>
      <div>
        <dt className="field">Hit rate</dt>
        <dd>{hitRate === null ? '—' : `${hitRate}%`}</dd>
      </div>
      <div>
        <dt className="field">Mean return</dt>
        <dd className={mean === null ? undefined : mean > 0 ? 'up' : mean < 0 ? 'down' : undefined}>
          {fmtPct(mean)}
        </dd>
      </div>
    </dl>
  )
}
