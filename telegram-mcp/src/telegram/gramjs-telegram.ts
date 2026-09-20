import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  idToString,
  markedId,
  toChatSummary,
  toDialogSummary,
  toMessageSummary,
  toUserSummary,
  type RawEntity,
  type RawMessage,
} from "./serialize.js";
import type {
  AccountStatus,
  ChatSummary,
  DialogSummary,
  MessageSummary,
  ReadMessagesOptions,
  SearchMessagesOptions,
  SendFileOptions,
  SendMessageOptions,
  Telegram,
  UserSummary,
} from "./types.js";

const INVITE_LINK = /(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([\w-]+)/i;
const DEFAULT_LIMIT = 30;
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

export class TelegramToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramToolError";
  }
}

/** Turns "@name", "https://t.me/name", "-1001234", "me" into something GramJS accepts. */
export function normalisePeer(chat: string): string | number {
  const value = chat.trim();
  if (!value) throw new TelegramToolError("chat is required");
  const lower = value.toLowerCase();
  if (lower === "me" || lower === "self" || lower === "saved" || lower === "saved messages") return "me";
  if (/^-?\d+$/.test(value)) return Number(value);
  const link = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})/i.exec(value);
  if (link?.[1]) return link[1];
  return value.startsWith("@") ? value.slice(1) : value;
}

export function inviteHash(chat: string): string | undefined {
  return INVITE_LINK.exec(chat.trim())?.[1];
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TelegramToolError(`${field} is not a valid date: ${value}`);
  return date;
}

function unmarkedId(peer: unknown): string {
  if (!peer || typeof peer !== "object") return "";
  const p = peer as Record<string, unknown>;
  for (const key of ["userId", "chatId", "channelId"]) {
    if (p[key] !== undefined) return idToString(p[key]);
  }
  return "";
}

/** The concrete Telegram implementation. Every call is rate limited. */
export class GramJsTelegram implements Telegram {
  constructor(
    private readonly getClient: () => Promise<TelegramClient>,
    private readonly limiter: RateLimiter,
  ) {}

  private run<T>(category: string, fn: (client: TelegramClient) => Promise<T>): Promise<T> {
    return this.limiter.run(category, async () => fn(await this.getClient()));
  }

  private async entity(client: TelegramClient, chat: string): Promise<RawEntity> {
    try {
      return (await client.getEntity(normalisePeer(chat))) as unknown as RawEntity;
    } catch (error) {
      throw new TelegramToolError(
        `Could not resolve "${chat}": ${(error as Error).message}. ` +
          `Usernames and t.me links always work; numeric ids only work for chats this session has already seen ` +
          `(list_dialogs or search_chats first).`,
      );
    }
  }

  async status(): Promise<AccountStatus> {
    const cooldownSeconds = this.limiter.cooldownRemaining();
    try {
      const me = await this.run("default", (client) => client.getMe());
      return { authenticated: true, me: toUserSummary(me as unknown as RawEntity), cooldownSeconds };
    } catch (error) {
      if ((error as Error).name === "NotAuthenticatedError") return { authenticated: false, cooldownSeconds };
      throw error;
    }
  }

  async searchPublicChats(query: string, limit = 20): Promise<{ chats: ChatSummary[]; users: UserSummary[] }> {
    const result = await this.run("search", (client) =>
      client.invoke(new Api.contacts.Search({ q: query, limit })),
    );
    return {
      chats: (result.chats as unknown as RawEntity[]).map((chat) => toChatSummary(chat)),
      users: (result.users as unknown as RawEntity[]).map((user) => toUserSummary(user)),
    };
  }

  async resolveChat(chat: string): Promise<ChatSummary> {
    return this.run("default", async (client) => toChatSummary(await this.entity(client, chat)));
  }

  async listDialogs(
    options: { limit?: number; archived?: boolean; kinds?: string[]; query?: string } = {},
  ): Promise<DialogSummary[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const dialogs = await this.run("default", (client) =>
      client.getDialogs({ limit: options.query || options.kinds ? Math.max(limit * 5, 100) : limit, archived: options.archived ?? false }),
    );
    let summaries = dialogs.map((dialog) =>
      toDialogSummary({
        entity: dialog.entity as unknown as RawEntity,
        unreadCount: dialog.unreadCount,
        pinned: dialog.pinned,
        archived: dialog.archived,
        message: dialog.message as unknown as RawMessage | undefined,
      }),
    );
    if (options.kinds?.length) summaries = summaries.filter((d) => options.kinds!.includes(d.kind));
    if (options.query) {
      const needle = options.query.toLowerCase();
      summaries = summaries.filter(
        (d) => d.title.toLowerCase().includes(needle) || (d.username ?? "").toLowerCase().includes(needle),
      );
    }
    return summaries.slice(0, limit);
  }

  async getChatInfo(chat: string): Promise<ChatSummary> {
    return this.run("default", async (client) => {
      const entity = await this.entity(client, chat);
      if (entity.className === "Channel") {
        const full = await client.invoke(
          new Api.channels.GetFullChannel({ channel: normalisePeer(chat) }),
        );
        const fullChat = full.fullChat as unknown as { about?: string; participantsCount?: number };
        return toChatSummary(entity, { about: fullChat.about, participantsCount: fullChat.participantsCount });
      }
      if (entity.className === "User") {
        const full = await client.invoke(new Api.users.GetFullUser({ id: await client.getInputEntity(normalisePeer(chat)) }));
        return toChatSummary(entity, { about: (full.fullUser as unknown as { about?: string }).about });
      }
      return toChatSummary(entity);
    });
  }

  async joinChat(chat: string): Promise<ChatSummary> {
    const hash = inviteHash(chat);
    return this.run("join", async (client) => {
      if (hash) {
        const updates = (await client.invoke(new Api.messages.ImportChatInvite({ hash }))) as unknown as {
          chats?: RawEntity[];
        };
        const joined = updates.chats?.[0];
        if (!joined) throw new TelegramToolError("Telegram accepted the invite but returned no chat");
        return toChatSummary(joined);
      }
      const entity = await this.entity(client, chat);
      await client.invoke(new Api.channels.JoinChannel({ channel: normalisePeer(chat) }));
      return toChatSummary({ ...entity, left: false });
    });
  }

  async leaveChat(chat: string): Promise<{ left: true; chat: string }> {
    return this.run("join", async (client) => {
      const entity = await this.entity(client, chat);
      if (entity.className === "Chat") {
        await client.invoke(
          new Api.messages.DeleteChatUser({ chatId: entity.id as never, userId: new Api.InputUserSelf() }),
        );
      } else {
        await client.invoke(new Api.channels.LeaveChannel({ channel: normalisePeer(chat) }));
      }
      return { left: true as const, chat: markedId(entity) };
    });
  }

  async listChatMembers(chat: string, options: { limit?: number; query?: string } = {}): Promise<UserSummary[]> {
    return this.run("search", async (client) => {
      const participants = await client.getParticipants(normalisePeer(chat), {
        limit: options.limit ?? DEFAULT_LIMIT,
        search: options.query,
      });
      return (participants as unknown as RawEntity[]).map((user) => toUserSummary(user));
    });
  }

  async getUserInfo(user: string): Promise<UserSummary> {
    return this.run("default", async (client) => {
      const entity = await this.entity(client, user);
      if (entity.className !== "User") throw new TelegramToolError(`"${user}" is not a user, it is a ${entity.className}`);
      const full = await client.invoke(new Api.users.GetFullUser({ id: await client.getInputEntity(normalisePeer(user)) }));
      return toUserSummary(entity, { about: (full.fullUser as unknown as { about?: string }).about });
    });
  }

  async readMessages(chat: string, options: ReadMessagesOptions = {}): Promise<MessageSummary[]> {
    return this.run("default", async (client) => {
      const entity = await this.entity(client, chat);
      const messages = await client.getMessages(normalisePeer(chat), {
        limit: options.limit ?? DEFAULT_LIMIT,
        offsetId: options.offsetId,
        minId: options.minId,
        offsetDate: toUnix(parseDate(options.beforeDate, "before_date")),
        fromUser: options.fromUser ? normalisePeer(options.fromUser) : undefined,
      });
      return (messages as unknown as RawMessage[]).map((message) => toMessageSummary(message, { chat: entity }));
    });
  }

  async searchMessages(options: SearchMessagesOptions): Promise<MessageSummary[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (options.chat) {
      return this.run("search", async (client) => {
        const entity = await this.entity(client, options.chat!);
        const messages = await client.getMessages(normalisePeer(options.chat!), {
          search: options.query,
          limit,
          fromUser: options.fromUser ? normalisePeer(options.fromUser) : undefined,
          offsetDate: toUnix(parseDate(options.beforeDate, "before_date")),
        });
        const since = parseDate(options.sinceDate, "since_date");
        return (messages as unknown as RawMessage[])
          .map((message) => toMessageSummary(message, { chat: entity }))
          .filter((message) => !since || new Date(message.date) >= since);
      });
    }
    return this.run("search", async (client) => {
      const result = (await client.invoke(
        new Api.messages.SearchGlobal({
          q: options.query,
          limit,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: toUnix(parseDate(options.sinceDate, "since_date")),
          maxDate: toUnix(parseDate(options.beforeDate, "before_date")),
        }),
      )) as unknown as { messages?: RawMessage[]; chats?: RawEntity[]; users?: RawEntity[] };
      const index = new Map<string, RawEntity>();
      for (const entity of [...(result.chats ?? []), ...(result.users ?? [])]) {
        index.set(idToString(entity.id), entity);
      }
      return (result.messages ?? []).map((message) => {
        const chat = index.get(unmarkedId(message.peerId));
        const sender = message.sender ?? index.get(unmarkedId((message as { fromId?: unknown }).fromId));
        return toMessageSummary({ ...message, sender }, { chat });
      });
    });
  }

  async sendMessage(options: SendMessageOptions): Promise<MessageSummary> {
    return this.run("send", async (client) => {
      const entity = await this.entity(client, options.chat);
      const message = await client.sendMessage(normalisePeer(options.chat), {
        message: options.text,
        replyTo: options.replyToMessageId,
        parseMode: options.parseMode === "none" ? undefined : (options.parseMode ?? "markdown"),
        linkPreview: options.linkPreview ?? true,
        silent: options.silent,
        schedule: toUnix(parseDate(options.scheduleAt, "schedule_at")),
      });
      return toMessageSummary(message as unknown as RawMessage, { chat: entity });
    });
  }

  async sendFile(options: SendFileOptions): Promise<MessageSummary> {
    const file = await this.materialise(options.source);
    return this.run("send", async (client) => {
      const entity = await this.entity(client, options.chat);
      const message = await client.sendFile(normalisePeer(options.chat), {
        file,
        caption: options.caption,
        forceDocument: options.asDocument,
        voiceNote: options.asVoice,
        replyTo: options.replyToMessageId,
        silent: options.silent,
      });
      return toMessageSummary(message as unknown as RawMessage, { chat: entity });
    });
  }

  /** Pulls whatever the caller described into something GramJS can upload. */
  private async materialise(source: SendFileOptions["source"]): Promise<CustomFile | string> {
    if (source.kind === "path") return source.path;
    if (source.kind === "base64") {
      const buffer = Buffer.from(source.data, "base64");
      return new CustomFile(source.fileName, buffer.length, "", buffer);
    }
    const response = await fetch(source.url);
    if (!response.ok) throw new TelegramToolError(`Could not fetch ${source.url}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const name = source.fileName ?? (basename(new URL(source.url).pathname) || "file");
    return new CustomFile(name, buffer.length, "", buffer);
  }

  async forwardMessages(options: {
    fromChat: string;
    messageIds: number[];
    toChat: string;
    silent?: boolean;
  }): Promise<MessageSummary[]> {
    if (!options.messageIds.length) throw new TelegramToolError("message_ids must not be empty");
    return this.run("send", async (client) => {
      const target = await this.entity(client, options.toChat);
      const forwarded = await client.forwardMessages(normalisePeer(options.toChat), {
        messages: options.messageIds,
        fromPeer: normalisePeer(options.fromChat),
        silent: options.silent,
      });
      return (forwarded as unknown as RawMessage[]).map((message) => toMessageSummary(message, { chat: target }));
    });
  }

  async editMessage(options: { chat: string; messageId: number; text: string }): Promise<MessageSummary> {
    return this.run("send", async (client) => {
      const entity = await this.entity(client, options.chat);
      const message = await client.editMessage(normalisePeer(options.chat), {
        message: options.messageId,
        text: options.text,
      });
      return toMessageSummary(message as unknown as RawMessage, { chat: entity });
    });
  }

  async deleteMessages(options: { chat: string; messageIds: number[]; revoke?: boolean }): Promise<{ deleted: number }> {
    return this.run("send", async (client) => {
      await client.deleteMessages(normalisePeer(options.chat), options.messageIds, {
        revoke: options.revoke ?? true,
      });
      return { deleted: options.messageIds.length };
    });
  }

  async markRead(chat: string): Promise<{ ok: true }> {
    return this.run("default", async (client) => {
      await client.markAsRead(normalisePeer(chat));
      return { ok: true as const };
    });
  }

  async sendReaction(options: { chat: string; messageId: number; emoji: string }): Promise<{ ok: true }> {
    return this.run("send", async (client) => {
      await client.invoke(
        new Api.messages.SendReaction({
          peer: normalisePeer(options.chat),
          msgId: options.messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: options.emoji })],
        }),
      );
      return { ok: true as const };
    });
  }

  async downloadMedia(options: {
    chat: string;
    messageId: number;
    savePath?: string;
    maxBytes?: number;
  }): Promise<{ fileName?: string; mimeType?: string; size: number; path?: string; base64?: string }> {
    return this.run("download", async (client) => {
      const [message] = (await client.getMessages(normalisePeer(options.chat), { ids: [options.messageId] })) as unknown as [
        RawMessage | undefined,
      ];
      if (!message) throw new TelegramToolError(`Message ${options.messageId} not found in ${options.chat}`);
      if (!message.media) throw new TelegramToolError(`Message ${options.messageId} has no media attached`);
      const summary = toMessageSummary(message).media;
      const data = await client.downloadMedia(message as never, {});
      if (!data || typeof data === "string") throw new TelegramToolError("Telegram returned no file data");
      const buffer = Buffer.from(data);
      if (options.savePath) {
        await writeFile(options.savePath, buffer);
        return { fileName: summary?.fileName, mimeType: summary?.mimeType, size: buffer.length, path: options.savePath };
      }
      const cap = Math.min(options.maxBytes ?? MAX_INLINE_BYTES, MAX_INLINE_BYTES);
      if (buffer.length > cap) {
        throw new TelegramToolError(
          `File is ${buffer.length} bytes, over the ${cap} byte inline limit. Pass save_path to write it to disk instead.`,
        );
      }
      return {
        fileName: summary?.fileName,
        mimeType: summary?.mimeType,
        size: buffer.length,
        base64: buffer.toString("base64"),
      };
    });
  }
}

function toUnix(date: Date | undefined): number | undefined {
  return date ? Math.floor(date.getTime() / 1000) : undefined;
}
