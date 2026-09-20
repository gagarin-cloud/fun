import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
  redact: {
    paths: ["req.headers.authorization", "phone", "code", "password", "apiKey", "session"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
