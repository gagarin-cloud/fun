import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'

/**
 * In the container we log newline-delimited JSON to stdout and let the docker
 * json-file driver handle rotation. Locally, pino-pretty makes dry-run output
 * readable — it is a devDependency, so guard the transport behind NODE_ENV.
 */
export const logger = pino(
  process.env.NODE_ENV === 'production'
    ? { level }
    : {
        level,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      },
)

export type Logger = typeof logger
