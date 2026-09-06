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
}

export default nextConfig
