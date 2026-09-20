import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { Telegram } from "../src/telegram/types.js";

function fakeTelegram(): { [K in keyof Telegram]: ReturnType<typeof vi.fn> } & Telegram {
  return {
    status: vi.fn().mockResolvedValue({ authenticated: true, cooldownSeconds: 0 }),
    searchPublicChats: vi.fn().mockResolvedValue({ chats: [], users: [] }),
    resolveChat: vi.fn().mockResolvedValue({ id: "-1001", kind: "channel", title: "Jobs" }),
    listDialogs: vi.fn().mockResolvedValue([]),
    getChatInfo: vi.fn().mockResolvedValue({ id: "-1001", kind: "channel", title: "Jobs" }),
    joinChat: vi.fn().mockResolvedValue({ id: "-1001", kind: "channel", title: "Jobs" }),
    leaveChat: vi.fn().mockResolvedValue({ left: true, chat: "-1001" }),
    listChatMembers: vi.fn().mockResolvedValue([]),
    getUserInfo: vi.fn().mockResolvedValue({ id: "1", kind: "user", displayName: "Ada" }),
    readMessages: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ id: 1, chatId: "1", date: "", text: "hi" }),
    sendFile: vi.fn().mockResolvedValue({ id: 2, chatId: "1", date: "", text: "" }),
    forwardMessages: vi.fn().mockResolvedValue([]),
    editMessage: vi.fn().mockResolvedValue({ id: 3, chatId: "1", date: "", text: "edited" }),
    deleteMessages: vi.fn().mockResolvedValue({ deleted: 1 }),
    markRead: vi.fn().mockResolvedValue({ ok: true }),
    sendReaction: vi.fn().mockResolvedValue({ ok: true }),
    downloadMedia: vi.fn().mockResolvedValue({ size: 3, base64: "AAA" }),
  } as never;
}

let telegram: ReturnType<typeof fakeTelegram>;
let client: Client;

async function connect() {
  telegram = fakeTelegram();
  const server = createMcpServer(telegram);
  client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function payload(result: CallToolResult): unknown {
  return JSON.parse(String(result.content[0]?.type === "text" ? result.content[0].text : ""));
}

describe("telegram tools over MCP", () => {
  beforeEach(connect);

  it("exposes every tool with a description and a schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "account_status",
        "chat_info",
        "delete_messages",
        "download_media",
        "edit_message",
        "forward_messages",
        "join_chat",
        "leave_chat",
        "list_chats",
        "list_members",
        "mark_read",
        "react",
        "read_messages",
        "resolve_chat",
        "search_chats",
        "search_messages",
        "send_file",
        "send_message",
        "user_info",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  it("marks read-only tools as read-only and destructive ones as destructive", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.get("read_messages")?.readOnlyHint).toBe(true);
    expect(byName.get("send_message")?.readOnlyHint).toBe(false);
    expect(byName.get("delete_messages")?.destructiveHint).toBe(true);
  });

  it("returns the account status as JSON", async () => {
    expect(payload(await call("account_status"))).toEqual({ authenticated: true, cooldownSeconds: 0 });
  });

  it("applies schema defaults", async () => {
    await call("search_chats", { query: "devops jobs" });
    expect(telegram.searchPublicChats).toHaveBeenCalledWith("devops jobs", 20);

    await call("read_messages", { chat: "@jobs" });
    expect(telegram.readMessages).toHaveBeenCalledWith("@jobs", expect.objectContaining({ limit: 30 }));
  });

  it("maps snake_case arguments onto the Telegram layer", async () => {
    await call("read_messages", { chat: "@jobs", limit: 5, offset_id: 100, min_id: 3, from_user: "@ada" });
    expect(telegram.readMessages).toHaveBeenCalledWith("@jobs", {
      limit: 5,
      offsetId: 100,
      minId: 3,
      beforeDate: undefined,
      fromUser: "@ada",
    });

    await call("forward_messages", { from_chat: "@jobs", message_ids: [1, 2], to_chat: "me" });
    expect(telegram.forwardMessages).toHaveBeenCalledWith({
      fromChat: "@jobs",
      messageIds: [1, 2],
      toChat: "me",
      silent: false,
    });

    await call("search_messages", { query: "devops", since_date: "2024-01-01T00:00:00Z" });
    expect(telegram.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ query: "devops", sinceDate: "2024-01-01T00:00:00Z" }),
    );

    await call("download_media", { chat: "@jobs", message_id: 9, save_path: "/tmp/x.pdf" });
    expect(telegram.downloadMedia).toHaveBeenCalledWith({
      chat: "@jobs",
      messageId: 9,
      savePath: "/tmp/x.pdf",
      maxBytes: undefined,
    });
  });

  it("builds the right file source and rejects ambiguous ones", async () => {
    await call("send_file", { chat: "me", url: "https://example.com/cv.pdf", caption: "cv" });
    expect(telegram.sendFile).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: "url", url: "https://example.com/cv.pdf", fileName: undefined } }),
    );

    const none = await call("send_file", { chat: "me" });
    expect(none.isError).toBe(true);
    expect(String((none.content[0] as { text: string }).text)).toMatch(/exactly one of url, base64 or path/);

    const both = await call("send_file", { chat: "me", url: "https://example.com/a.pdf", path: "/tmp/a.pdf" });
    expect(both.isError).toBe(true);

    const unnamed = await call("send_file", { chat: "me", base64: "AAA" });
    expect(unnamed.isError).toBe(true);
    expect(String((unnamed.content[0] as { text: string }).text)).toMatch(/file_name is required/);
  });

  it("turns a Telegram failure into a tool error, not a transport error", async () => {
    telegram.joinChat.mockRejectedValue(new Error("Telegram rate-limited this account for 300s (FLOOD_WAIT)"));
    const result = await call("join_chat", { chat: "@jobs" });
    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toMatch(/FLOOD_WAIT/);
  });

  it("rejects arguments that do not match the schema", async () => {
    const result = await call("react", { chat: "me", message_id: "not-a-number", emoji: "👍" });
    expect(result.isError).toBe(true);
    expect(telegram.sendReaction).not.toHaveBeenCalled();
  });

  it("tells the agent how to use the server", async () => {
    expect(client.getInstructions()).toMatch(/lead-generation/);
  });
});
