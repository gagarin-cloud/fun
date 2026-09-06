import type { Read } from '@/lib/read'

/**
 * What to show when there is nothing to show.
 *
 * Both are states a correctly configured deployment passes through, so each says
 * what is true and what would change it, in the site's own voice — rather than
 * apologising, or implying the reader did something wrong.
 */
export function StateNote({ result }: { result: Extract<Read<unknown>, { ok: false }> }) {
  if (result.reason === 'no-schema') {
    return (
      <div className="note">
        <h2>No book yet</h2>
        <p>
          The bot has not run against this database. It creates its tables the first time it
          boots, and the first positions land after its first pipeline cycle.
        </p>
      </div>
    )
  }

  return (
    <div className="note">
      <h2>Database unreachable</h2>
      <p>
        The positions live in the bot’s Postgres and this page could not read it. On gagarin the
        usual cause is a missing dependency edge — a service that has not declared it reaches the
        database has its connections dropped rather than refused, so it times out.
      </p>
      <p>
        <code>gg deps ls insider-bot/web</code> shows what this service may reach.
      </p>
    </div>
  )
}
