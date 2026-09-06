import { CallEntry } from '@/components/CallEntry'
import { Scoreboard } from '@/components/Scoreboard'
import { StateNote } from '@/components/StateNote'
import { getIntake, getOpenCalls, getScoreboard } from '@/lib/queries'
import { read } from '@/lib/read'

/**
 * Rendered per request, never at build time.
 *
 * Without this Next would prerender the route during `next build` — inside a
 * Docker build, on a machine with no database and no DB_URL. Nothing here is
 * worth caching anyway: the bot writes a handful of rows every three hours and
 * the queries are three small SELECTs.
 */
export const dynamic = 'force-dynamic'

export default async function OpenBookPage() {
  const result = await read(async () => {
    // Concurrently: three independent round trips against a pool of four.
    const [calls, numbers, intake] = await Promise.all([
      getOpenCalls(),
      getScoreboard(),
      getIntake(),
    ])
    return { calls, numbers, intake }
  })

  if (!result.ok) return <StateNote result={result} />

  const { calls, numbers, intake } = result.data

  return (
    <>
      <Scoreboard numbers={numbers} />

      {intake.seen > 0 ? (
        <p className="intake">
          Over the last seven days it read {intake.seen.toLocaleString('en-GB')} news items and
          carried {intake.passed} of them through to a thesis.
        </p>
      ) : null}

      <div className="section-head">
        <h2>Open book</h2>
        <span className="field">Newest first</span>
      </div>

      {calls.length === 0 ? (
        <div className="note">
          <h2>Book is flat</h2>
          <p>
            Everything the bot has published has been scored and closed. It opens a position when
            a news event survives triage, a thesis clears the conviction floor, and the ticker is
            not in cooldown — a few times a week at most, and often not at all.
          </p>
          <p>
            The <a href="/record">P&amp;L</a> has the ones it has already settled.
          </p>
        </div>
      ) : (
        <ul className="ledger">
          {calls.map((call) => (
            <CallEntry key={call.id} call={call} />
          ))}
        </ul>
      )}
    </>
  )
}
