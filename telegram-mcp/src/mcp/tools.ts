import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Telegram } from "../telegram/types.js";

const chat = z
  .string()
  .describe('Chat to act on: "@username", a t.me link, a numeric id from another tool, or "me" for Saved Messages.');

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

type Shape = Record<string, z.ZodTypeAny>;

interface ToolSpec<S extends Shape> {
  title: string;
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  destructive?: boolean;
}

/** Registers a tool whose result is JSON and whose errors come back as tool errors, not transport errors. */
export function registerJsonTool<S extends Shape>(
  server: McpServer,
  name: string,
  spec: ToolSpec<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  // The SDK's callback type is conditional on the shape generic, which cannot be
  // resolved inside a generic helper — so the callback is cast at this one spot.
  const register = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: unknown,
    cb: (args: unknown) => Promise<CallToolResult>,
  ) => void;
  register(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        title: spec.title,
        readOnlyHint: spec.readOnly ?? false,
        destructiveHint: spec.destructive ?? false,
        openWorldHint: true,
      },
    },
    async (args: unknown) => {
      try {
        return ok(await handler(args as z.infer<z.ZodObject<S>>));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

export function registerTelegramTools(server: McpServer, telegram: Telegram): void {
  registerJsonTool(
    server,
    "account_status",
    {
      title: "Account status",
      description:
        "Who this server is logged in as, and whether Telegram is currently rate-limiting us. Call this first if anything else fails with an auth error.",
      inputSchema: {},
      readOnly: true,
    },
    () => telegram.status(),
  );

  registerJsonTool(
    server,
    "search_chats",
    {
      title: "Search public chats and channels",
      description:
        "Search Telegram's public directory for groups, channels and people by keyword. This is the entry point for discovery: search for a topic ('devops jobs', 'react hiring'), then join_chat the promising results and read_messages from them.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords to search for, e.g. 'IT jobs remote'."),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum results."),
      },
      readOnly: true,
    },
    ({ query, limit }) => telegram.searchPublicChats(query, limit),
  );

  registerJsonTool(
    server,
    "resolve_chat",
    {
      title: "Resolve a username or link",
      description: "Turn a @username, t.me link or invite link into a chat object with its id, kind and title.",
      inputSchema: { chat },
      readOnly: true,
    },
    ({ chat: target }) => telegram.resolveChat(target),
  );

  registerJsonTool(
    server,
    "chat_info",
    {
      title: "Chat details",
      description: "Full details for one chat: description, member count, whether the account is a member.",
      inputSchema: { chat },
      readOnly: true,
    },
    ({ chat: target }) => telegram.getChatInfo(target),
  );

  registerJsonTool(
    server,
    "list_chats",
    {
      title: "List my chats",
      description:
        "List the chats, groups and channels this account is already in, newest activity first, with unread counts and the last message.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30).describe("Maximum chats to return."),
        archived: z.boolean().default(false).describe("List the archive instead of the main list."),
        kinds: z
          .array(z.enum(["user", "bot", "group", "supergroup", "channel"]))
          .optional()
          .describe("Only return these kinds of chat."),
        query: z.string().optional().describe("Only return chats whose title or username contains this."),
      },
      readOnly: true,
    },
    ({ limit, archived, kinds, query }) => telegram.listDialogs({ limit, archived, kinds, query }),
  );

  registerJsonTool(
    server,
    "join_chat",
    {
      title: "Join a chat or channel",
      description:
        "Join a public group/channel by username or link, or a private one by invite link (t.me/+hash). Joining is heavily rate-limited by Telegram — a few per hour, not dozens.",
      inputSchema: { chat },
    },
    ({ chat: target }) => telegram.joinChat(target),
  );

  registerJsonTool(
    server,
    "leave_chat",
    {
      title: "Leave a chat",
      description: "Leave a group or channel this account is in.",
      inputSchema: { chat },
      destructive: true,
    },
    ({ chat: target }) => telegram.leaveChat(target),
  );

  registerJsonTool(
    server,
    "list_members",
    {
      title: "List chat members",
      description:
        "List members of a group or channel, optionally filtered by a name query. Useful for lead generation: find who is in a niche community. Many large channels hide their member list; expect an error there.",
      inputSchema: {
        chat,
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum members to return."),
        query: z.string().optional().describe("Filter members by name or username."),
      },
      readOnly: true,
    },
    ({ chat: target, limit, query }) => telegram.listChatMembers(target, { limit, query }),
  );

  registerJsonTool(
    server,
    "user_info",
    {
      title: "User details",
      description: "Profile details for one user: display name, username, bio, whether they are a bot.",
      inputSchema: { user: z.string().describe("@username, numeric id, or t.me link of the user.") },
      readOnly: true,
    },
    ({ user }) => telegram.getUserInfo(user),
  );

  registerJsonTool(
    server,
    "read_messages",
    {
      title: "Read messages from a chat",
      description:
        "Read message history from a chat, newest first. Page backwards with offset_id (pass the id of the oldest message you got), or forwards with min_id to poll for new messages since the last run.",
      inputSchema: {
        chat,
        limit: z.number().int().min(1).max(200).default(30).describe("Maximum messages."),
        offset_id: z.number().int().optional().describe("Return messages older than this message id."),
        min_id: z.number().int().optional().describe("Only return messages newer than this message id."),
        before_date: z.string().optional().describe("Only messages before this ISO 8601 timestamp."),
        from_user: z.string().optional().describe("Only messages from this user."),
      },
      readOnly: true,
    },
    ({ chat: target, limit, offset_id, min_id, before_date, from_user }) =>
      telegram.readMessages(target, {
        limit,
        offsetId: offset_id,
        minId: min_id,
        beforeDate: before_date,
        fromUser: from_user,
      }),
  );

  registerJsonTool(
    server,
    "search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search over messages. With `chat`, searches inside that chat (works for any chat the account can see). Without it, searches globally across everything this account has joined — the fastest way to find, say, every 'looking for a DevOps engineer' post across all joined job channels.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for."),
        chat: z.string().optional().describe("Restrict the search to this chat. Omit to search all joined chats."),
        limit: z.number().int().min(1).max(200).default(30).describe("Maximum messages."),
        from_user: z.string().optional().describe("Only messages from this user (in-chat search only)."),
        since_date: z.string().optional().describe("Only messages at or after this ISO 8601 timestamp."),
        before_date: z.string().optional().describe("Only messages before this ISO 8601 timestamp."),
      },
      readOnly: true,
    },
    ({ query, chat: target, limit, from_user, since_date, before_date }) =>
      telegram.searchMessages({
        query,
        chat: target,
        limit,
        fromUser: from_user,
        sinceDate: since_date,
        beforeDate: before_date,
      }),
  );

  registerJsonTool(
    server,
    "send_message",
    {
      title: "Send a message",
      description:
        "Send a text message. Sending to strangers and cold-DMing at volume is what gets Telegram accounts limited — keep it slow and relevant.",
      inputSchema: {
        chat,
        text: z.string().min(1).describe("Message body."),
        reply_to_message_id: z.number().int().optional().describe("Reply to this message id."),
        parse_mode: z.enum(["markdown", "html", "none"]).default("markdown").describe("How to format `text`."),
        link_preview: z.boolean().default(true).describe("Show a preview for links in the message."),
        silent: z.boolean().default(false).describe("Deliver without a notification sound."),
        schedule_at: z.string().optional().describe("Send later, at this ISO 8601 timestamp."),
      },
    },
    ({ chat: target, text, reply_to_message_id, parse_mode, link_preview, silent, schedule_at }) =>
      telegram.sendMessage({
        chat: target,
        text,
        replyToMessageId: reply_to_message_id,
        parseMode: parse_mode,
        linkPreview: link_preview,
        silent,
        scheduleAt: schedule_at,
      }),
  );

  registerJsonTool(
    server,
    "send_file",
    {
      title: "Send a file, photo, video or voice note",
      description:
        "Send media from a URL, from base64 data, or from a path on the server. Telegram picks the right message type from the file, unless you force a document or a voice note.",
      inputSchema: {
        chat,
        url: z.string().url().optional().describe("Fetch the file from this URL and send it."),
        base64: z.string().optional().describe("Raw file bytes, base64 encoded. Requires file_name."),
        path: z.string().optional().describe("Path to a file on the server's filesystem."),
        file_name: z.string().optional().describe("Name the file is sent under."),
        caption: z.string().optional().describe("Caption to send with the file."),
        as_document: z.boolean().default(false).describe("Send as an uncompressed file rather than a photo/video."),
        as_voice: z.boolean().default(false).describe("Send an .ogg as a voice note."),
        reply_to_message_id: z.number().int().optional().describe("Reply to this message id."),
        silent: z.boolean().default(false).describe("Deliver without a notification sound."),
      },
    },
    ({ chat: target, url, base64, path, file_name, caption, as_document, as_voice, reply_to_message_id, silent }) => {
      const sources = [url, base64, path].filter(Boolean);
      if (sources.length !== 1) throw new Error("Pass exactly one of url, base64 or path");
      if (base64 && !file_name) throw new Error("file_name is required when sending base64 data");
      const source = url
        ? ({ kind: "url", url, fileName: file_name } as const)
        : base64
          ? ({ kind: "base64", data: base64, fileName: file_name! } as const)
          : ({ kind: "path", path: path! } as const);
      return telegram.sendFile({
        chat: target,
        source,
        caption,
        asDocument: as_document,
        asVoice: as_voice,
        replyToMessageId: reply_to_message_id,
        silent,
      });
    },
  );

  registerJsonTool(
    server,
    "forward_messages",
    {
      title: "Forward messages",
      description:
        'Forward messages from one chat to another. Pass "me" as to_chat to file them in Saved Messages — the usual way to collect leads you found.',
      inputSchema: {
        from_chat: z.string().describe("Chat the messages are currently in."),
        message_ids: z.array(z.number().int()).min(1).max(100).describe("Message ids to forward."),
        to_chat: z.string().describe('Destination chat. "me" is Saved Messages.'),
        silent: z.boolean().default(false).describe("Deliver without a notification sound."),
      },
    },
    ({ from_chat, message_ids, to_chat, silent }) =>
      telegram.forwardMessages({ fromChat: from_chat, messageIds: message_ids, toChat: to_chat, silent }),
  );

  registerJsonTool(
    server,
    "edit_message",
    {
      title: "Edit a message",
      description: "Replace the text of a message this account sent.",
      inputSchema: {
        chat,
        message_id: z.number().int().describe("Message to edit."),
        text: z.string().min(1).describe("New body."),
      },
    },
    ({ chat: target, message_id, text }) => telegram.editMessage({ chat: target, messageId: message_id, text }),
  );

  registerJsonTool(
    server,
    "delete_messages",
    {
      title: "Delete messages",
      description: "Delete messages. By default they are revoked for everyone, not just this account.",
      inputSchema: {
        chat,
        message_ids: z.array(z.number().int()).min(1).max(100).describe("Message ids to delete."),
        revoke: z.boolean().default(true).describe("Delete for everyone, not only for me."),
      },
      destructive: true,
    },
    ({ chat: target, message_ids, revoke }) =>
      telegram.deleteMessages({ chat: target, messageIds: message_ids, revoke }),
  );

  registerJsonTool(
    server,
    "mark_read",
    {
      title: "Mark a chat as read",
      description: "Clear the unread badge on a chat.",
      inputSchema: { chat },
    },
    ({ chat: target }) => telegram.markRead(target),
  );

  registerJsonTool(
    server,
    "react",
    {
      title: "React to a message",
      description: "Put an emoji reaction on a message.",
      inputSchema: {
        chat,
        message_id: z.number().int().describe("Message to react to."),
        emoji: z.string().min(1).describe("A single emoji, e.g. 👍."),
      },
    },
    ({ chat: target, message_id, emoji }) => telegram.sendReaction({ chat: target, messageId: message_id, emoji }),
  );

  registerJsonTool(
    server,
    "download_media",
    {
      title: "Download a message's media",
      description:
        "Download the file attached to a message. Returns base64 for small files, or writes it to save_path on the server and returns the path.",
      inputSchema: {
        chat,
        message_id: z.number().int().describe("Message whose media to download."),
        save_path: z.string().optional().describe("Write the file here on the server instead of returning base64."),
        max_bytes: z.number().int().min(1).optional().describe("Refuse to inline files larger than this."),
      },
      readOnly: true,
    },
    ({ chat: target, message_id, save_path, max_bytes }) =>
      telegram.downloadMedia({ chat: target, messageId: message_id, savePath: save_path, maxBytes: max_bytes }),
  );
}
