import type { Metadata } from 'next'

import { TerminalHeader } from '@/components/Terminal'
import './globals.css'

/**
 * The header reads the database, so the layout is per-request like the pages it
 * wraps. Without this Next would try to prerender it during `next build`, inside
 * a Docker build with no DB_URL.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: {
    default: 'Insider Terminal — the open book',
    template: '%s — Insider Terminal',
  },
  description:
    'A bot reads company news and takes a position in the second-order beneficiary — the ' +
    'supplier that just landed the customer, not the customer. Every open call, and the P&L.',
  robots: {
    // Idea-generation output with no validated edge, written by a language model
    // every three hours. Readable by anyone with the link; not something to feed
    // a search index as though it were research.
    index: false,
    follow: true,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap"
        />
      </head>
      <body>
        <TerminalHeader />

        <div className="shell">
          <main>{children}</main>

          <footer className="footer">
            <p>
              <strong>Not financial advice.</strong> These are machine-generated ideas with no
              validated edge, and the P&amp;L above is published precisely because it might turn
              out to be bad. Nobody is trading this book.
            </p>
            <p>
              Every position was posted to the Telegram channel first. This page reads the same
              Postgres the bot writes to, on each request.
            </p>
          </footer>
        </div>
      </body>
    </html>
  )
}
