import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "../config.js";
import type { AccountPool } from "../telegram/account-pool.js";
import { SealedClientsStore } from "./clients.js";
import { ReplayGuard, Sealer, SealError } from "./sealed.js";

export const SCOPE = "telegram";
export const AUTH_REQUEST_PURPOSE = "oauth/request";
const CODE_PURPOSE = "oauth/code";
const ACCESS_PURPOSE = "oauth/access";
const REFRESH_PURPOSE = "oauth/refresh";
const AUTH_REQUEST_TTL_SECONDS = 15 * 60;
const CODE_TTL_SECONDS = 5 * 60;

/** What the login page carries while the human signs in to Telegram. */
export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
  resource?: string;
}

interface AuthCode extends AuthRequest {
  jti: string;
  session: string;
  userId: string;
}

interface TokenPayload {
  session: string;
  userId: string;
  clientId: string;
  scopes: string[];
  resource?: string;
}

/**
 * An OAuth 2.1 authorization server whose "user database" is Telegram itself.
 *
 * Signing in *is* creating a Telegram session; the tokens handed back are that
 * session, sealed with the server key. So the server stores no credentials: a
 * token presented later decrypts to the session it was minted from, and if the
 * account revoked that session in the Telegram app, the very next call fails.
 */
export class TelegramOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SealedClientsStore;
  private readonly usedCodes: ReplayGuard;

  constructor(
    private readonly config: Config,
    private readonly sealer: Sealer,
    private readonly pool: AccountPool,
    private readonly loginPath = "/login",
  ) {
    this.clientsStore = new SealedClientsStore(sealer);
    this.usedCodes = new ReplayGuard();
  }

  /** Step one: park the OAuth request in a sealed blob and send the human to sign in. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request: AuthRequest = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource?.href,
    };
    const sealed = this.sealer.seal(AUTH_REQUEST_PURPOSE, request, AUTH_REQUEST_TTL_SECONDS);
    res.redirect(302, `${this.loginPath}?request=${encodeURIComponent(sealed)}`);
  }

  /** Step two: the sign-in finished, so mint the code the client will exchange. */
  completeAuthorization(sealedRequest: string, session: string, userId: string): { redirectTo: string } {
    const request = this.readAuthRequest(sealedRequest);
    const code: AuthCode = { ...request, jti: randomUUID(), session, userId };
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", this.sealer.seal(CODE_PURPOSE, code, CODE_TTL_SECONDS));
    if (request.state !== undefined) url.searchParams.set("state", request.state);
    return { redirectTo: url.href };
  }

  readAuthRequest(sealedRequest: string): AuthRequest {
    try {
      return this.sealer.unseal<AuthRequest>(AUTH_REQUEST_PURPOSE, sealedRequest);
    } catch (error) {
      throw new SealError(
        error instanceof SealError && error.message.includes("expired")
          ? "This sign-in link has expired. Start again from the app you were connecting."
          : "This sign-in link is not valid. Start again from the app you were connecting.",
      );
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.readCode(client, authorizationCode).codeChallenge;
  }

  private readCode(client: OAuthClientInformationFull, authorizationCode: string): AuthCode {
    let code: AuthCode;
    try {
      code = this.sealer.unseal<AuthCode>(CODE_PURPOSE, authorizationCode);
    } catch {
      throw new InvalidGrantError("The authorization code is invalid or has expired");
    }
    if (code.clientId !== client.client_id) throw new InvalidGrantError("This code was issued to another client");
    return code;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.readCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the one the code was issued for");
    }
    // Codes are single use, for the life of the code itself.
    if (!this.usedCodes.claim(code.jti, CODE_TTL_SECONDS)) {
      throw new InvalidGrantError("This authorization code has already been used");
    }
    return this.issue({
      session: code.session,
      userId: code.userId,
      clientId: client.client_id,
      scopes: code.scopes?.length ? code.scopes : [SCOPE],
      resource: (resource ?? (code.resource ? new URL(code.resource) : undefined))?.href,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    let payload: TokenPayload;
    try {
      payload = this.sealer.unseal<TokenPayload>(REFRESH_PURPOSE, refreshToken);
    } catch {
      throw new InvalidGrantError("The refresh token is invalid or has expired");
    }
    if (payload.clientId !== client.client_id) {
      throw new InvalidGrantError("This refresh token was issued to another client");
    }
    return this.issue({
      ...payload,
      scopes: scopes?.length ? scopes : payload.scopes,
      resource: (resource?.href ?? payload.resource) as string | undefined,
    });
  }

  private issue(payload: TokenPayload): OAuthTokens {
    const expiresIn = this.config.ACCESS_TOKEN_TTL_HOURS * 3600;
    return {
      access_token: this.sealer.seal(ACCESS_PURPOSE, payload, expiresIn),
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: payload.scopes.join(" "),
      refresh_token: this.sealer.seal(REFRESH_PURPOSE, payload, this.config.REFRESH_TOKEN_TTL_DAYS * 86_400),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: TokenPayload;
    let expiresAt: number | undefined;
    try {
      payload = this.sealer.unseal<TokenPayload>(ACCESS_PURPOSE, token);
      expiresAt = this.sealer.expiryOf(ACCESS_PURPOSE, token);
    } catch {
      throw new InvalidTokenError("The access token is invalid or has expired");
    }
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes,
      expiresAt,
      extra: { session: payload.session, telegramUserId: payload.userId },
    };
  }

  /**
   * Revocation here is not bookkeeping: the token is the Telegram session, so
   * the only way to make it stop working is to end that session — which is
   * exactly what the account holder means by "disconnect this app".
   */
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    for (const purpose of [ACCESS_PURPOSE, REFRESH_PURPOSE]) {
      try {
        const payload = this.sealer.unseal<TokenPayload>(purpose, request.token);
        if (payload.clientId !== client.client_id) return;
        await this.pool.logout(payload.session);
        return;
      } catch {
        // Try the other purpose; an unrecognisable token is a no-op per RFC 7009.
      }
    }
  }
}

/** The Telegram session behind a verified access token. */
export function sessionOf(auth: AuthInfo | undefined): string {
  const session = auth?.extra?.session;
  if (typeof session !== "string" || !session) throw new InvalidTokenError("This token carries no Telegram session");
  return session;
}
