import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import QRCode from "qrcode";
import { StringSession } from "telegram/sessions/index.js";
import { computeCheck } from "telegram/Password.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { toUserSummary, type RawEntity } from "./serialize.js";
import type { UserSummary } from "./types.js";

export class LoginError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

const LOGIN_MESSAGES: Record<string, string> = {
  PHONE_CODE_INVALID: "That code is not right. Check the message Telegram sent you and try again.",
  PHONE_CODE_EXPIRED: "That code has expired. Request a new one.",
  PHONE_NUMBER_INVALID: "Telegram does not recognise that phone number. Use the full international format.",
  PHONE_NUMBER_UNOCCUPIED: "No Telegram account exists for that number. Create one in the Telegram app first.",
  PHONE_NUMBER_BANNED: "Telegram has banned that phone number.",
  PASSWORD_HASH_INVALID: "That two-factor password is not right.",
  SESSION_PASSWORD_NEEDED: "This account has two-factor authentication enabled.",
  AUTH_RESTART: "Telegram asked us to restart the login. Go back and re-enter your phone number.",
  NO_PENDING_LOGIN: "This sign-in has expired. Start again with your phone number.",
};

export function loginError(error: unknown): LoginError {
  const code = String(
    (error as { errorMessage?: string })?.errorMessage ?? (error as Error)?.message ?? "UNKNOWN_ERROR",
  );
  return new LoginError(LOGIN_MESSAGES[code] ?? `Telegram rejected the sign-in: ${code}`, code);
}

export type LoginResult =
  | { step: "password_needed" }
  | { step: "authenticated"; session: string; user: UserSummary };

export type DeliveryKind =
  | "app"
  | "sms"
  | "call"
  | "missed_call"
  | "fragment"
  | "email"
  | "words"
  | "unknown";

export interface CodeDelivery {
  kind: DeliveryKind;
  /** A sentence telling the human exactly where to look. */
  message: string;
  /** Seconds before Telegram will let us send it another way. */
  retryAfterSeconds?: number;
  /** How a resend would arrive, when Telegram is willing to try something else. */
  nextKind?: DeliveryKind;
}

export type LoginStart =
  | { step: "code_sent"; loginId: string; phone: string; delivery: CodeDelivery }
  | LoginResult;

const DELIVERY: Record<string, { kind: DeliveryKind; message: string }> = {
  SentCodeTypeApp: {
    kind: "app",
    message:
      "Telegram sent the code as a service message to every other session already signed in to THIS account — " +
      "look in the chat called Telegram there. If it is a second account, switch to it in the app first: the code " +
      "goes to that account's own chat, not to whichever account you are looking at. Telegram does not send SMS " +
      "codes to third-party apps like this one, so no text message is coming.",
  },
  SentCodeTypeSms: { kind: "sms", message: "Telegram sent the code by SMS." },
  SentCodeTypeCall: { kind: "call", message: "Telegram is calling you and will read the code out loud." },
  SentCodeTypeMissedCall: {
    kind: "missed_call",
    message: "Telegram is placing a missed call. The code is the last digits of the calling number.",
  },
  SentCodeTypeFlashCall: {
    kind: "missed_call",
    message: "Telegram is placing a missed call. The code is the last digits of the calling number.",
  },
  SentCodeTypeFragmentSms: {
    kind: "fragment",
    message: "This is an anonymous Fragment number, so the code is waiting for you at fragment.com.",
  },
  SentCodeTypeFirebaseSms: { kind: "sms", message: "Telegram sent the code by SMS." },
  SentCodeTypeEmailCode: { kind: "email", message: "Telegram sent the code to the email on this account." },
  SentCodeTypeSetUpEmailRequired: {
    kind: "email",
    message:
      "Telegram will not send a code until this account has a login email set up. Do that in the Telegram app " +
      "under Settings -> Privacy and Security, then start again.",
  },
  SentCodeTypeSmsWord: { kind: "words", message: "Telegram sent a single word by SMS — enter the word, not digits." },
  SentCodeTypeSmsPhrase: { kind: "words", message: "Telegram sent a short phrase by SMS — enter the phrase." },
};

interface RawSentCodeType {
  className?: string;
}

/**
 * GramJS names types in a namespace with the namespace attached
 * ("auth.SentCodeTypeApp"), so the constructor name is taken off the end rather
 * than matched whole.
 */
function constructorName(type: RawSentCodeType | undefined): string {
  return (type?.className ?? "").split(".").pop() ?? "";
}

/** Turns Telegram's sent-code descriptor into something worth showing a human. */
export function describeDelivery(sentCode: {
  type?: RawSentCodeType;
  nextType?: RawSentCodeType;
  timeout?: number;
}): CodeDelivery {
  const known = DELIVERY[constructorName(sentCode.type)];
  const next = DELIVERY[constructorName(sentCode.nextType)];
  return {
    kind: known?.kind ?? "unknown",
    message:
      known?.message ??
      `Telegram says it sent the code (${sentCode.type?.className ?? "unknown method"}). Check Telegram and your SMS.`,
    retryAfterSeconds: sentCode.timeout,
    nextKind: next?.kind,
  };
}

interface RawSentCode {
  className?: string;
  phoneCodeHash?: unknown;
  type?: { className?: string };
  nextType?: { className?: string };
  timeout?: number;
}

interface Pending {
  client: TelegramClient;
  /** Absent for a QR sign-in, which never asks for a number. */
  phone?: string;
  phoneCodeHash?: string;
  expiresAt: number;
  /** Set by the updateLoginToken push once somebody scans the code. */
  scanned?: boolean;
  /** When the displayed QR stops being valid and a fresh one is needed. */
  qrExpiresAt?: number;
}

export interface QrCode {
  /** The tg://login URL encoded in the image. */
  url: string;
  /** The image itself, inline, so the page pulls nothing from anywhere else. */
  svg: string;
  expiresInSeconds: number;
}

export type QrPoll =
  | { step: "waiting"; qr?: QrCode }
  | { step: "password_needed" }
  | { step: "authenticated"; session: string; user: UserSummary };

export function defaultLoginClient(config: Config): TelegramClient {
  return new TelegramClient(new StringSession(""), config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
    connectionRetries: 3,
    retryDelay: 1000,
    useWSS: false,
  });
}

/**
 * The phone -> code -> 2FA conversation, one entry per browser doing it. These
 * live only in memory and only for minutes: what survives a completed sign-in is
 * the session string, which is handed to the OAuth layer and never stored here.
 */
export class LoginSessions {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly createClient: () => TelegramClient = () => defaultLoginClient(config),
    private readonly now: () => number = Date.now,
  ) {}

  private sweep(): void {
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= this.now()) {
        this.pending.delete(id);
        void entry.client.disconnect().catch(() => undefined);
      }
    }
  }

  private take(loginId: string): Pending {
    this.sweep();
    const entry = this.pending.get(loginId);
    if (!entry) throw loginError(new Error("NO_PENDING_LOGIN"));
    return entry;
  }

  private discard(loginId: string, entry: Pending): void {
    this.pending.delete(loginId);
    void entry.client.disconnect().catch(() => undefined);
  }

  /**
   * Asks Telegram to send a login code. This calls auth.sendCode directly rather
   * than going through GramJS's helper, which reduces the answer to a boolean —
   * and "which of six ways did it go, and when may we try another" is exactly
   * what somebody staring at an empty SMS inbox needs to know.
   */
  async start(phone: string): Promise<LoginStart> {
    this.sweep();
    if (this.pending.size >= this.config.MAX_PENDING_LOGINS) {
      throw new LoginError("Too many sign-ins are in progress right now. Try again in a few minutes.", "BUSY");
    }
    const client = this.createClient();
    await client.connect();
    const loginId = randomUUID();
    try {
      const sent = await this.sendCode(client, phone);
      // Telegram can decide the caller is already authorised and hand back a
      // session instead of sending anything. Rare, but it is a finished login.
      if (sent.className === "auth.SentCodeSuccess") {
        const entry: Pending = { client, phone, phoneCodeHash: "", expiresAt: this.now() };
        this.pending.set(loginId, entry);
        return this.finish(loginId, entry);
      }
      this.pending.set(loginId, {
        client,
        phone,
        phoneCodeHash: String(sent.phoneCodeHash ?? ""),
        expiresAt: this.now() + this.config.LOGIN_TIMEOUT_MINUTES * 60_000,
      });
      const delivery = describeDelivery(sent);
      this.logger.info(
        { loginId, delivery: delivery.kind, next: delivery.nextKind, retryAfter: delivery.retryAfterSeconds },
        "login code sent",
      );
      // The number is echoed back so a typo or a missing country code shows up
      // as a wrong number on screen rather than as a code that never arrives.
      return { step: "code_sent", loginId, phone, delivery };
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw loginError(error);
    }
  }

  private async sendCode(client: TelegramClient, phone: string, retried = false): Promise<RawSentCode> {
    try {
      return (await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: this.config.TELEGRAM_API_ID,
          apiHash: this.config.TELEGRAM_API_HASH,
          settings: new Api.CodeSettings({}),
        }),
      )) as unknown as RawSentCode;
    } catch (error) {
      // Telegram asks for exactly one restart when it wants the request replayed
      // on the data centre the number belongs to.
      if ((error as { errorMessage?: string }).errorMessage === "AUTH_RESTART" && !retried) {
        return this.sendCode(client, phone, true);
      }
      throw error;
    }
  }

  /** Asks Telegram to send the code again — usually by a different route. */
  async resend(loginId: string): Promise<CodeDelivery> {
    const entry = this.take(loginId);
    try {
      const sent = (await entry.client.invoke(
        new Api.auth.ResendCode({ phoneNumber: entry.phone, phoneCodeHash: entry.phoneCodeHash }),
      )) as unknown as RawSentCode;
      if (sent.phoneCodeHash) entry.phoneCodeHash = String(sent.phoneCodeHash);
      const delivery = describeDelivery(sent);
      this.logger.info({ loginId, delivery: delivery.kind }, "login code resent");
      return delivery;
    } catch (error) {
      throw loginError(error);
    }
  }

  async submitCode(loginId: string, code: string): Promise<LoginResult> {
    const entry = this.take(loginId);
    try {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (error) {
      const converted = loginError(error);
      // The pending login is kept alive: the password is the next step of it.
      if (converted.code === "SESSION_PASSWORD_NEEDED") return { step: "password_needed" };
      throw converted;
    }
    return this.finish(loginId, entry);
  }

  async submitPassword(loginId: string, password: string): Promise<LoginResult> {
    const entry = this.take(loginId);
    try {
      const passwordInfo = await entry.client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(passwordInfo, password);
      await entry.client.invoke(new Api.auth.CheckPassword({ password: check }));
    } catch (error) {
      throw loginError(error);
    }
    return this.finish(loginId, entry);
  }

  /**
   * Takes the session string off the finished login and closes the connection.
   * The pool opens its own connection when the account is first used, so there
   * is never a second idle client hanging around per sign-in.
   */
  private async finish(loginId: string, entry: Pending): Promise<LoginResult> {
    const me = (await entry.client.getMe()) as unknown as RawEntity;
    const session = String(entry.client.session.save());
    this.discard(loginId, entry);
    this.logger.info({ loginId, user: me.id }, "sign-in complete");
    return { step: "authenticated", session, user: toUserSummary(me) };
  }

  /**
   * Starts a QR sign-in. This is the flow Telegram Desktop and Web use, and the
   * one that works when a login code has nowhere to go: the account being signed
   * in is chosen on the phone, by whoever scans, rather than by typing a number
   * and hoping the code reaches it.
   */
  async startQr(): Promise<{ loginId: string; qr: QrCode }> {
    this.sweep();
    if (this.pending.size >= this.config.MAX_PENDING_LOGINS) {
      throw new LoginError("Too many sign-ins are in progress right now. Try again in a few minutes.", "BUSY");
    }
    const client = this.createClient();
    await client.connect();
    const loginId = randomUUID();
    try {
      const entry: Pending = {
        client,
        expiresAt: this.now() + this.config.LOGIN_TIMEOUT_MINUTES * 60_000,
      };
      // Telegram pushes updateLoginToken to this very connection the moment the
      // code is scanned, so there is no need to poll Telegram itself — the page
      // polls us, and we only ask Telegram once there is something to ask about.
      client.addEventHandler((update: { className?: string }) => {
        if (update?.className === "UpdateLoginToken") entry.scanned = true;
      });
      const qr = await this.exportQr(entry);
      this.pending.set(loginId, entry);
      this.logger.info({ loginId }, "qr sign-in started");
      return { loginId, qr };
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw loginError(error);
    }
  }

  private async exportQr(entry: Pending): Promise<QrCode> {
    const result = (await entry.client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: this.config.TELEGRAM_API_ID,
        apiHash: this.config.TELEGRAM_API_HASH,
        exceptIds: [],
      }),
    )) as unknown as { className?: string; token?: Buffer; expires?: number };
    if (result.className !== "auth.LoginToken" || !result.token) {
      throw new LoginError("Telegram did not hand out a login code to show.", "QR_UNAVAILABLE");
    }
    const expiresInSeconds = Math.max(
      5,
      (result.expires ?? Math.floor(this.now() / 1000) + 30) - Math.floor(this.now() / 1000),
    );
    entry.qrExpiresAt = this.now() + expiresInSeconds * 1000;
    const url = `tg://login?token=${Buffer.from(result.token).toString("base64url")}`;
    return { url, svg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), expiresInSeconds };
  }

  /**
   * Where a QR sign-in has got to. Returns a fresh code when the last one aged
   * out, which is normal — Telegram's tokens live about half a minute.
   */
  async pollQr(loginId: string): Promise<QrPoll> {
    const entry = this.take(loginId);
    if (!entry.scanned) {
      if (entry.qrExpiresAt !== undefined && entry.qrExpiresAt <= this.now()) {
        return { step: "waiting", qr: await this.exportQr(entry) };
      }
      return { step: "waiting" };
    }
    try {
      return await this.completeQr(loginId, entry);
    } catch (error) {
      const converted = loginError(error);
      // The scan worked; the account just also wants its password.
      if (converted.code === "SESSION_PASSWORD_NEEDED") return { step: "password_needed" };
      throw converted;
    }
  }

  private async completeQr(loginId: string, entry: Pending): Promise<QrPoll> {
    const result = (await entry.client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: this.config.TELEGRAM_API_ID,
        apiHash: this.config.TELEGRAM_API_HASH,
        exceptIds: [],
      }),
    )) as unknown as { className?: string; dcId?: number; token?: Buffer };

    if (result.className === "auth.LoginTokenMigrateTo") {
      // The account lives on another data centre; finish the handshake there.
      await (entry.client as unknown as { _switchDC(dc: number): Promise<void> })._switchDC(result.dcId!);
      const migrated = (await entry.client.invoke(
        new Api.auth.ImportLoginToken({ token: result.token! }),
      )) as unknown as { className?: string };
      if (migrated.className !== "auth.LoginTokenSuccess") {
        throw new LoginError(`Telegram returned ${migrated.className} after the scan.`, "QR_UNEXPECTED");
      }
      return this.finish(loginId, entry);
    }

    if (result.className === "auth.LoginTokenSuccess") return this.finish(loginId, entry);

    // Scanned but not accepted yet — the phone is still thinking about it.
    entry.scanned = false;
    return { step: "waiting", qr: await this.exportQr(entry) };
  }

  cancel(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (entry) this.discard(loginId, entry);
  }

  get size(): number {
    this.sweep();
    return this.pending.size;
  }

  async shutdown(): Promise<void> {
    for (const [id, entry] of this.pending) this.discard(id, entry);
  }
}
