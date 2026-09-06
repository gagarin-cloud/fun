import { createServer, type Server } from 'node:http'
import { logger } from './logger.js'

/**
 * A liveness endpoint, and nothing more.
 *
 * This worker only makes outbound calls — it serves no API and receives no
 * Telegram updates — so left to itself it would listen on nothing. gagarin,
 * though, decides whether a service is ready by opening a connection to the port
 * the deploy declared: a container that listens nowhere never becomes ready, no
 * matter how well it is running. Under docker-compose nothing connects here and
 * the server just sits idle.
 *
 * It binds 0.0.0.0 rather than the Node default, because a listener on the
 * loopback address is invisible from outside the container and would fail in
 * exactly the same way as listening on nothing at all.
 */
export function startHealthServer(isHealthy: () => boolean): Server {
  const port = Number(process.env.PORT ?? 8080)

  const server = createServer((req, res) => {
    // Anything that is not the health path is somebody knocking on the wrong
    // door; there is no other route to offer them.
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n')
      return
    }
    // 503 once shutdown has begun, so the platform stops counting a draining pod
    // as ready rather than finding out when it disappears.
    const ok = isHealthy()
    res
      .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: ok ? 'ok' : 'shutting_down' }) + '\n')
  })

  server.listen(port, '0.0.0.0', () => logger.info({ port }, 'health endpoint listening'))
  return server
}
