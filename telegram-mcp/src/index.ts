import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./http/app.js";
import { Sealer } from "./auth/sealed.js";
import { TelegramOAuthProvider } from "./auth/provider.js";
import { AccountPool } from "./telegram/account-pool.js";
import { LoginSessions } from "./telegram/login.js";

const config = loadConfig();
const sealer = new Sealer(config.ENCRYPTION_KEY);
const pool = new AccountPool(config, logger);
const logins = new LoginSessions(config, logger);
const provider = new TelegramOAuthProvider(config, sealer, pool);

const app = createApp({ config, logger, provider, logins, pool });
const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, url: config.PUBLIC_URL ?? `http://localhost:${config.PORT}` },
    "telegram-mcp listening",
  );
});

// Accounts are released on use, but a server nobody is calling should still let
// its connections go rather than holding them until the next request.
const sweep = setInterval(() => pool.evictIdle(), 60_000);
sweep.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweep);
    server.close(() => {
      void Promise.all([pool.shutdown(), logins.shutdown()]).finally(() => process.exit(0));
    });
  });
}
