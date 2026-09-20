import { join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import { SCOPE, TelegramOAuthProvider, sessionOf } from "../auth/provider.js";
import { SealError } from "../auth/sealed.js";
import type { AccountPool } from "../telegram/account-pool.js";
import { LoginError, type LoginSessions } from "../telegram/login.js";
import { renderLoginPage } from "./login-page.js";

export interface AppDependencies {
  config: Config;
  logger: Logger;
  provider: TelegramOAuthProvider;
  logins: LoginSessions;
  pool: AccountPool;
}

const startSchema = z.object({
  request: z.string().min(1),
  phone: z.string().regex(/^\+?[0-9 ()-]{6,20}$/, "Enter a valid phone number"),
});
const codeSchema = z.object({
  request: z.string().min(1),
  loginId: z.string().min(1),
  code: z.string().regex(/^\d{3,8}$/, "The login code is 5 digits"),
});
const resendSchema = z.object({ request: z.string().min(1), loginId: z.string().min(1) });
const qrStartSchema = z.object({ request: z.string().min(1) });
const qrPollSchema = z.object({ request: z.string().min(1), loginId: z.string().min(1) });
const passwordSchema = z.object({
  request: z.string().min(1),
  loginId: z.string().min(1),
  password: z.string().min(1, "Enter your two-factor password"),
});

/**
 * This server's own address. It has to be one fixed value rather than whatever
 * each request arrived as: it is the OAuth issuer, it is baked into every
 * metadata document and into the tokens clients have already been handed, and a
 * client that discovered one issuer will refuse a token minted under another.
 */
export function issuerOf(config: Config): string {
  return (config.PUBLIC_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, "");
}

export function createApp({ config, logger, provider, logins, pool }: AppDependencies): Express {
  const origin = issuerOf(config);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(`${origin}/mcp`));
  const app = express();
  app.disable("x-powered-by");
  // Behind Gagarin's proxy; needed for req.protocol and for rate limiting by IP.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "32mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "telegram-mcp", accounts: pool.size, pendingLogins: logins.size });
  });

  // The OAuth endpoints: /authorize, /token, /register, /revoke and the two
  // metadata documents, all built against the fixed issuer above.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      resourceServerUrl: new URL(`${origin}/mcp`),
      resourceName: "Telegram",
      scopesSupported: [SCOPE],
      // Registrations live inside the client_id rather than in a table, so a
      // secret that expired could not be rotated — it would just break the
      // connector. Clients that want one get one, and it lasts as long as the id.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, clientIdGeneration: false },
    }),
  );

  // The connector's mark. /icon.png is what the MCP handshake points clients at;
  // the favicon names are there because browsers and some clients just guess.
  const assets = join(import.meta.dirname, "assets");
  const sendIcon = (file: string) => (_req: Request, res: Response) => {
    res.type("image/png").set("cache-control", "public, max-age=86400").sendFile(join(assets, file));
  };
  app.get("/icon.png", sendIcon("icon-256.png"));
  app.get("/icon-64.png", sendIcon("icon-64.png"));
  app.get("/favicon.ico", sendIcon("icon-64.png"));
  app.get("/favicon.png", sendIcon("icon-64.png"));

  app.get("/", (_req, res) => res.redirect("/login"));

  app.get("/login", (req, res) => {
    const sealed = typeof req.query.request === "string" ? req.query.request : undefined;
    if (!sealed) {
      res.type("html").send(renderLoginPage());
      return;
    }
    try {
      const request = provider.readAuthRequest(sealed);
      const client = provider.clientsStore.getClient(request.clientId);
      void Promise.resolve(client).then((info) => {
        res.type("html").send(
          renderLoginPage({
            request: sealed,
            clientName: info?.client_name,
            redirectHost: new URL(request.redirectUri).host,
          }),
        );
      });
    } catch (error) {
      res.status(400).type("html").send(renderLoginPage({ error: (error as Error).message }));
    }
  });

  // Signing in is the one unauthenticated write on this server, and it costs
  // Telegram an SMS, so it is capped per IP.
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests", message: "Too many sign-in attempts. Try again in a few minutes." },
  });

  const loginRoute =
    <T>(schema: z.ZodType<T>, handler: (body: T) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid request" });
        return;
      }
      void handler(parsed.data)
        .then((value) => res.json(value))
        .catch((error: unknown) => {
          if (error instanceof LoginError) {
            res.status(400).json({ error: error.code, message: error.message });
            return;
          }
          if (error instanceof SealError) {
            res.status(400).json({ error: "invalid_request", message: error.message });
            return;
          }
          logger.error({ err: error }, "sign-in failed");
          res.status(500).json({ error: "internal_error", message: (error as Error).message });
        });
    };

  /** Turns a finished Telegram sign-in into the OAuth redirect back to the client. */
  const complete = (sealedRequest: string, session: string, userId: string) =>
    provider.completeAuthorization(sealedRequest, session, userId);

  app.post(
    "/api/login/start",
    loginLimit,
    loginRoute(startSchema, async ({ request, phone }) => {
      provider.readAuthRequest(request);
      const result = await logins.start(phone.replace(/[ ()-]/g, ""));
      // Telegram occasionally signs the caller straight in instead of sending a
      // code, which finishes the whole flow here.
      if (result.step === "authenticated") {
        return { step: "authenticated", ...complete(request, result.session, result.user.id) };
      }
      return result;
    }),
  );

  app.post(
    "/api/login/code",
    loginLimit,
    loginRoute(codeSchema, async ({ request, loginId, code }) => {
      provider.readAuthRequest(request);
      const result = await logins.submitCode(loginId, code);
      if (result.step === "password_needed") return result;
      return { step: "authenticated", ...complete(request, result.session, result.user.id) };
    }),
  );

  // The QR panel polls this every couple of seconds while somebody finds their
  // phone, so it gets a much larger allowance than the code endpoints — it costs
  // Telegram nothing until the code is actually scanned.
  const pollLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 400,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "too_many_requests", message: "Too many requests. Start the sign-in again." },
  });

  app.post(
    "/api/login/qr/start",
    loginLimit,
    loginRoute(qrStartSchema, async ({ request }) => {
      provider.readAuthRequest(request);
      return logins.startQr();
    }),
  );

  app.post(
    "/api/login/qr/poll",
    pollLimit,
    loginRoute(qrPollSchema, async ({ request, loginId }) => {
      provider.readAuthRequest(request);
      const result = await logins.pollQr(loginId);
      if (result.step === "authenticated") {
        return { step: "authenticated", ...complete(request, result.session, result.user.id) };
      }
      return result;
    }),
  );

  app.post(
    "/api/login/resend",
    loginLimit,
    loginRoute(resendSchema, async ({ request, loginId }) => {
      provider.readAuthRequest(request);
      return { delivery: await logins.resend(loginId) };
    }),
  );

  app.post(
    "/api/login/password",
    loginLimit,
    loginRoute(passwordSchema, async ({ request, loginId, password }) => {
      provider.readAuthRequest(request);
      const result = await logins.submitPassword(loginId, password);
      if (result.step === "password_needed") return result;
      return { step: "authenticated", ...complete(request, result.session, result.user.id) };
    }),
  );

  // One MCP server and transport per request: the protocol is stateless here, and
  // the account it acts as comes from the bearer token, not from a session.
  const mcp = async (req: Request, res: Response): Promise<void> => {
    const telegram = pool.telegramFor(sessionOf(req.auth));
    const server = createMcpServer(telegram, origin);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, "mcp request failed");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  app.post("/mcp", bearer, (req, res) => void mcp(req, res));
  app.get("/mcp", bearer, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server is stateless: use POST for every request." },
      id: null,
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}
