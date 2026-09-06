import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * This app has its own lockfile and sits inside the bot's project directory,
   * which also has one. Left to infer, the bundler walks up, picks the bot's,
   * and traces the wrong tree. The Docker context is this directory alone, so
   * saying so is the same answer in both places.
   */
  turbopack: { root: import.meta.dirname },

  /**
   * Emit `.next/standalone` — a self-contained server with only the traced
   * dependencies — so the runtime image can be `node server.js` over a copied
   * directory rather than a full `node_modules` and the Next CLI. See the
   * Dockerfile, which copies exactly the three things this produces.
   */
  output: 'standalone',

  /**
   * `pg` speaks the Postgres wire protocol in JS, but it also carries an
   * optional `require('pg-native')` that only resolves when the native binding
   * is installed. Bundling it makes that conditional require a hard one and the
   * build fails on a module nothing here wants. Leaving pg external means it is
   * loaded from node_modules at runtime, the way the bot loads it.
   */
  serverExternalPackages: ['pg'],

  /**
   * The bot is the only writer; this app issues nothing but SELECTs. Sending a
   * framework banner and an ETag for pages that are dynamic anyway buys nothing.
   */
  poweredByHeader: false,

  /**
   * Response headers for a public, read-only, entirely GET-driven site.
   *
   * What these are and are not: the site takes no input — no query parameters,
   * no cookies, no forms, no user accounts — and every string it renders is
   * React-escaped, so these are hardening rather than the thing standing between
   * it and an attack. The two that do real work are `frame-ancestors`, which
   * stops the page being framed and passed off as somebody else's, and
   * `form-action`/`base-uri`, which close the two ways injected markup would try
   * to exfiltrate if it ever got in.
   *
   * The CSP carries `'unsafe-inline'` for scripts because Next's hydration
   * bootstrap is inline and nonces would mean adding middleware to every
   * request. That is an honest limit rather than a hidden one: with
   * `'unsafe-inline'` a CSP does **not** block `javascript:` URLs, so the
   * defence against a hostile link out of an ingested news feed is the scheme
   * allowlist in `lib/format.ts`, not this header.
   */
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; ')

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // The site links out to news articles. Sending only the origin means a
          // publisher's logs never learn which call sent the reader.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Nothing here uses any of them.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ]
  },
}

export default nextConfig
