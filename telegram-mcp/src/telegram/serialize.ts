import type { ChatKind, ChatSummary, DialogSummary, MediaSummary, MessageSummary, UserSummary } from "./types.js";

/** Loose structural view of the GramJS objects we read. Keeps serialisation testable. */
export interface RawEntity {
  className?: string;
  id?: unknown;
  title?: string;
  username?: string;
  usernames?: { username: string }[];
  firstName?: string;
  lastName?: string;
  phone?: string;
  bot?: boolean;
  verified?: boolean;
  scam?: boolean;
  premium?: boolean;
  megagroup?: boolean;
  broadcast?: boolean;
  gigagroup?: boolean;
  left?: boolean;
  participantsCount?: number;
  [key: string]: unknown;
}

export function idToString(id: unknown): string {
  if (id === null || id === undefined) return "";
  if (typeof id === "object" && "value" in (id as Record<string, unknown>)) {
    return String((id as { value: unknown }).value);
  }
  return String(id);
}

export function entityKind(entity: RawEntity): ChatKind {
  switch (entity.className) {
    case "User":
      return entity.bot ? "bot" : "user";
    case "Chat":
    case "ChatForbidden":
      return "group";
    case "Channel":
    case "ChannelForbidden":
      return entity.megagroup || entity.gigagroup ? "supergroup" : "channel";
    default:
      return "unknown";
  }
}

/** The id an agent can hand back to us: marked the way Telegram's bot API marks them. */
export function markedId(entity: RawEntity): string {
  const raw = idToString(entity.id);
  if (!raw) return "";
  const kind = entityKind(entity);
  if (kind === "supergroup" || kind === "channel") return raw.startsWith("-") ? raw : `-100${raw}`;
  if (kind === "group") return raw.startsWith("-") ? raw : `-${raw}`;
  return raw;
}

export function primaryUsername(entity: RawEntity): string | undefined {
  if (entity.username) return entity.username;
  const active = entity.usernames?.find((u) => u.username);
  return active?.username;
}

export function displayName(entity: RawEntity): string {
  if (entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  const username = primaryUsername(entity);
  return username ? `@${username}` : `id:${idToString(entity.id)}`;
}

function defined<T extends Record<string, unknown>>(object: T): T {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) delete object[key];
  }
  return object;
}

export function toUserSummary(user: RawEntity, extra?: { about?: string; isContact?: boolean }): UserSummary {
  const username = primaryUsername(user);
  return defined({
    id: markedId(user),
    kind: user.bot ? "bot" : "user",
    displayName: displayName(user),
    username,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    about: extra?.about,
    isPremium: user.premium || undefined,
    isContact: extra?.isContact,
    link: username ? `https://t.me/${username}` : undefined,
  }) as UserSummary;
}

export function toChatSummary(
  entity: RawEntity,
  extra?: { about?: string; participantsCount?: number },
): ChatSummary {
  const username = primaryUsername(entity);
  return defined({
    id: markedId(entity),
    kind: entityKind(entity),
    title: displayName(entity),
    username,
    link: username ? `https://t.me/${username}` : undefined,
    about: extra?.about,
    participantsCount: extra?.participantsCount ?? entity.participantsCount,
    verified: entity.verified || undefined,
    scam: entity.scam || undefined,
    isMember: entity.className === "Channel" ? !entity.left : undefined,
  }) as ChatSummary;
}

export function toDialogSummary(dialog: {
  entity?: RawEntity;
  unreadCount?: number;
  pinned?: boolean;
  archived?: boolean;
  message?: RawMessage;
}): DialogSummary {
  const entity = dialog.entity ?? {};
  return defined({
    ...toChatSummary(entity),
    unreadCount: dialog.unreadCount ?? 0,
    pinned: Boolean(dialog.pinned),
    archived: Boolean(dialog.archived),
    lastMessage: dialog.message ? toMessageSummary(dialog.message, { chat: entity }) : undefined,
  }) as DialogSummary;
}

export interface RawMessage {
  id?: number;
  date?: number;
  message?: string;
  out?: boolean;
  views?: number;
  forwards?: number;
  peerId?: unknown;
  chatId?: unknown;
  replyTo?: { replyToMsgId?: number };
  fwdFrom?: { fromName?: string; fromId?: unknown };
  sender?: RawEntity;
  chat?: RawEntity;
  media?: { className?: string; document?: unknown; photo?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export function mediaSummary(media: RawMessage["media"]): MediaSummary | undefined {
  if (!media) return undefined;
  if (media.className === "MessageMediaPhoto") return { type: "photo" };
  if (media.className === "MessageMediaWebPage") return { type: "webpage" };
  if (media.className === "MessageMediaPoll") return { type: "poll" };
  if (media.className === "MessageMediaDocument") {
    const document = media.document as
      | { mimeType?: string; size?: unknown; attributes?: { className?: string; fileName?: string }[] }
      | undefined;
    const attributes = document?.attributes ?? [];
    const fileName = attributes.find((a) => a.className === "DocumentAttributeFilename")?.fileName;
    const mimeType = document?.mimeType;
    let type: MediaSummary["type"] = "document";
    if (attributes.some((a) => a.className === "DocumentAttributeSticker")) type = "sticker";
    else if (attributes.some((a) => a.className === "DocumentAttributeVideo")) type = "video";
    else if (attributes.some((a) => a.className === "DocumentAttributeAudio")) type = "audio";
    if (mimeType?.startsWith("audio/ogg")) type = "voice";
    return defined({ type, fileName, mimeType, size: document?.size ? Number(idToString(document.size)) : undefined });
  }
  return { type: "other" };
}

export function peerToMarkedId(peer: unknown): string {
  if (!peer || typeof peer !== "object") return "";
  const p = peer as Record<string, unknown>;
  if (p.userId !== undefined) return idToString(p.userId);
  if (p.chatId !== undefined) return `-${idToString(p.chatId)}`;
  if (p.channelId !== undefined) return `-100${idToString(p.channelId)}`;
  return "";
}

export function messageLink(chat: RawEntity | undefined, messageId: number | undefined): string | undefined {
  if (!chat || !messageId) return undefined;
  // Only public-facing channels and supergroups have linkable messages; there is
  // no such thing as a link to a message in a private chat.
  const kind = entityKind(chat);
  if (kind !== "channel" && kind !== "supergroup") return undefined;
  const username = primaryUsername(chat);
  if (username) return `https://t.me/${username}/${messageId}`;
  return `https://t.me/c/${idToString(chat.id)}/${messageId}`;
}

export function toMessageSummary(message: RawMessage, context?: { chat?: RawEntity }): MessageSummary {
  const chat = context?.chat ?? message.chat;
  const sender = message.sender;
  return defined({
    id: message.id ?? 0,
    chatId: chat ? markedId(chat) : peerToMarkedId(message.peerId),
    chatTitle: chat ? displayName(chat) : undefined,
    date: message.date ? new Date(message.date * 1000).toISOString() : new Date(0).toISOString(),
    text: message.message ?? "",
    from: sender
      ? defined({
          id: markedId(sender),
          displayName: displayName(sender),
          username: primaryUsername(sender),
          isBot: sender.bot || undefined,
        })
      : undefined,
    outgoing: message.out || undefined,
    replyToMessageId: message.replyTo?.replyToMsgId,
    forwardedFrom: message.fwdFrom?.fromName,
    views: message.views,
    forwards: message.forwards,
    media: mediaSummary(message.media),
    link: messageLink(chat, message.id),
  }) as MessageSummary;
}
