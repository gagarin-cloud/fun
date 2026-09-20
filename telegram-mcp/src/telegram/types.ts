export type ChatKind = "user" | "bot" | "group" | "supergroup" | "channel" | "unknown";

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  username?: string;
  link?: string;
  about?: string;
  participantsCount?: number;
  verified?: boolean;
  scam?: boolean;
  isMember?: boolean;
}

export interface UserSummary {
  id: string;
  kind: "user" | "bot";
  displayName: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  about?: string;
  isPremium?: boolean;
  isContact?: boolean;
  link?: string;
}

export interface MediaSummary {
  type: "photo" | "document" | "video" | "audio" | "voice" | "sticker" | "webpage" | "poll" | "other";
  fileName?: string;
  mimeType?: string;
  size?: number;
}

export interface MessageSummary {
  id: number;
  chatId: string;
  chatTitle?: string;
  date: string;
  text: string;
  from?: { id: string; displayName: string; username?: string; isBot?: boolean };
  outgoing?: boolean;
  replyToMessageId?: number;
  forwardedFrom?: string;
  views?: number;
  forwards?: number;
  media?: MediaSummary;
  link?: string;
}

export interface DialogSummary extends ChatSummary {
  unreadCount: number;
  pinned: boolean;
  archived: boolean;
  lastMessage?: MessageSummary;
}

export interface AccountStatus {
  authenticated: boolean;
  me?: UserSummary;
  cooldownSeconds: number;
}

export type FileSource =
  | { kind: "url"; url: string; fileName?: string }
  | { kind: "base64"; data: string; fileName: string; mimeType?: string }
  | { kind: "path"; path: string };

export interface ReadMessagesOptions {
  limit?: number;
  offsetId?: number;
  minId?: number;
  beforeDate?: string;
  fromUser?: string;
  includeMedia?: boolean;
}

export interface SearchMessagesOptions {
  query: string;
  chat?: string;
  limit?: number;
  fromUser?: string;
  sinceDate?: string;
  beforeDate?: string;
}

export interface SendMessageOptions {
  chat: string;
  text: string;
  replyToMessageId?: number;
  parseMode?: "markdown" | "html" | "none";
  linkPreview?: boolean;
  silent?: boolean;
  scheduleAt?: string;
}

export interface SendFileOptions {
  chat: string;
  source: FileSource;
  caption?: string;
  asDocument?: boolean;
  asVoice?: boolean;
  replyToMessageId?: number;
  silent?: boolean;
}

/**
 * Everything the MCP tools are allowed to do to Telegram. The tool layer only
 * ever sees this interface, which is what makes it testable without a network.
 */
export interface Telegram {
  status(): Promise<AccountStatus>;
  searchPublicChats(query: string, limit?: number): Promise<{ chats: ChatSummary[]; users: UserSummary[] }>;
  resolveChat(chat: string): Promise<ChatSummary>;
  listDialogs(options?: {
    limit?: number;
    archived?: boolean;
    kinds?: ChatKind[];
    query?: string;
  }): Promise<DialogSummary[]>;
  getChatInfo(chat: string): Promise<ChatSummary>;
  joinChat(chat: string): Promise<ChatSummary>;
  leaveChat(chat: string): Promise<{ left: true; chat: string }>;
  listChatMembers(chat: string, options?: { limit?: number; query?: string }): Promise<UserSummary[]>;
  getUserInfo(user: string): Promise<UserSummary>;
  readMessages(chat: string, options?: ReadMessagesOptions): Promise<MessageSummary[]>;
  searchMessages(options: SearchMessagesOptions): Promise<MessageSummary[]>;
  sendMessage(options: SendMessageOptions): Promise<MessageSummary>;
  sendFile(options: SendFileOptions): Promise<MessageSummary>;
  forwardMessages(options: {
    fromChat: string;
    messageIds: number[];
    toChat: string;
    silent?: boolean;
  }): Promise<MessageSummary[]>;
  editMessage(options: { chat: string; messageId: number; text: string }): Promise<MessageSummary>;
  deleteMessages(options: { chat: string; messageIds: number[]; revoke?: boolean }): Promise<{ deleted: number }>;
  markRead(chat: string): Promise<{ ok: true }>;
  sendReaction(options: { chat: string; messageId: number; emoji: string }): Promise<{ ok: true }>;
  downloadMedia(options: {
    chat: string;
    messageId: number;
    savePath?: string;
    maxBytes?: number;
  }): Promise<{ fileName?: string; mimeType?: string; size: number; path?: string; base64?: string }>;
}
