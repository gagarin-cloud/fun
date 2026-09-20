import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTelegramTools } from "./tools.js";
import type { Telegram } from "../telegram/types.js";

export const SERVER_INSTRUCTIONS = `This server acts as a real Telegram user account — not a bot. It can see
everything that account sees and act as that account.

A typical lead-generation run looks like:
  1. search_chats to discover public groups and channels about a topic.
  2. join_chat the promising ones (Telegram rate-limits joins hard — a handful per hour).
  3. search_messages (no chat argument) to search across everything the account has joined,
     or read_messages on one chat to page through its history.
  4. forward_messages with to_chat "me" to file what you found in Saved Messages,
     or download_media / return the text to the user.

Chats can be addressed by @username, t.me link, or the id returned by another tool.
"me" means Saved Messages. Numeric ids are only resolvable for chats this server has
already seen since it started, so prefer usernames and links when you have them.

Every call is rate limited on the way out. If a tool reports FLOOD_WAIT, stop and wait
the number of seconds it names rather than retrying — retrying is what gets accounts banned.`;

export function createMcpServer(telegram: Telegram, origin?: string): McpServer {
  const server = new McpServer(
    {
      name: "telegram-mcp",
      title: "Telegram",
      version: "0.1.0",
      description: "Search, read, join and post to Telegram as a real account.",
      // Clients show this next to the connector. The icon is served from this
      // same deployment, so it needs the absolute address to fetch it from.
      ...(origin
        ? {
            websiteUrl: origin,
            icons: [
              { src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["256x256"] },
              { src: `${origin}/icon-64.png`, mimeType: "image/png", sizes: ["64x64"] },
            ],
          }
        : {}),
    },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTelegramTools(server, telegram);
  return server;
}
