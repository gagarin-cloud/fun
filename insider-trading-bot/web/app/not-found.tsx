import Link from 'next/link'

export const metadata = { title: 'Not found' }

export default function NotFound() {
  return (
    <div className="note">
      <h2>No position with that number</h2>
      <p>
        Positions are numbered in the order they were opened, and nothing is ever deleted — so
        this one was never written rather than taken down.
      </p>
      <p>
        The <Link href="/">open book</Link>, or the <Link href="/record">P&amp;L</Link>.
      </p>
    </div>
  )
}
