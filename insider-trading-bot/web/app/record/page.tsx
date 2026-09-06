import Link from 'next/link'

import { PnlBar } from '@/components/PnlBar'
import { Scoreboard } from '@/components/Scoreboard'
import { StateNote } from '@/components/StateNote'
import { fmtPct, fmtTerm } from '@/lib/format'
import { getResolvedCalls, getScoreboard } from '@/lib/queries'
import { read } from '@/lib/read'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'P&L' }

/**
 * Every settled position, densest view on the site.
 *
 * `expired` is its own outcome rather than a kind of loss: the window shut and
 * the price did not move enough either way. It is the most common result, and
 * folding it into "wrong" would misdescribe what happened.
 */
export default async function RecordPage() {
  const result = await read(async () => {
    const [calls, numbers] = await Promise.all([getResolvedCalls(), getScoreboard()])
    return { calls, numbers }
  })

  if (!result.ok) return <StateNote result={result} />

  const { calls, numbers } = result.data

  // One scale for the whole table, so a row's bar means something next to the
  // row above it. Without this every bar would be full-width and the column
  // would carry no information beyond its sign.
  const max = calls.reduce((m, c) => Math.max(m, Math.abs(c.return_pct ?? 0)), 0)

  return (
    <>
      <Scoreboard numbers={numbers} />

      <div className="section-head">
        <h2>Settled positions</h2>
        <span className="field">Most recently scored first</span>
      </div>

      {calls.length === 0 ? (
        <div className="note">
          <h2>Nothing settled yet</h2>
          <p>
            Positions are scored once a week, and only after their catalyst date has passed — so
            the first results arrive a month or two after the first post.
          </p>
          <p>
            The <Link href="/">open book</Link> has the ones still waiting.
          </p>
        </div>
      ) : (
        <div className="blotter-wrap">
          <table className="blotter">
            <thead>
              <tr>
                <th scope="col">Ticker</th>
                <th scope="col">Side</th>
                <th scope="col">Opened</th>
                <th scope="col">Settled</th>
                <th scope="col">Outcome</th>
                <th scope="col">P&amp;L</th>
                <th scope="col" className="num">
                  Return
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id}>
                  <td>
                    <Link className="blotter__ticker" href={`/calls/${call.id}`}>
                      {call.ticker}
                    </Link>
                    {call.company ? (
                      <div className="blotter__company">{call.company}</div>
                    ) : null}
                  </td>
                  <td className={call.direction === 'long' ? 'up' : 'down'}>{call.direction}</td>
                  <td>{fmtTerm(call.entry_at)}</td>
                  <td>{fmtTerm(call.resolved_at)}</td>
                  <td className={toneOf(call.status)}>{OUTCOME[call.status]}</td>
                  <td>
                    <PnlBar pct={call.return_pct} max={max} />
                  </td>
                  <td className={`num ${toneOfReturn(call.return_pct)}`}>
                    {fmtPct(call.return_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

const OUTCOME: Record<string, string> = {
  won: 'Right',
  lost: 'Wrong',
  expired: 'Flat',
  open: 'Open',
}

function toneOf(status: string): string {
  return status === 'won' ? 'up' : status === 'lost' ? 'down' : 'flat'
}

function toneOfReturn(pct: number | null): string {
  if (pct === null) return 'flat'
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
}
