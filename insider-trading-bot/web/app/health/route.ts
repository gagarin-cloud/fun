/**
 * Liveness, and deliberately nothing more.
 *
 * It does not touch the database. gagarin decides whether to send traffic here
 * by asking this service if it is up; answering "no" because Postgres is
 * momentarily unreachable would take a page that renders a perfectly good
 * "can't reach the database" message and replace it with no page at all.
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ status: 'ok' })
}
