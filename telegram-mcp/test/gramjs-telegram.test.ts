import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "telegram";
import { GramJsTelegram, TelegramToolError, inviteHash, normalisePeer } from "../src/telegram/gramjs-telegram.js";
import { RateLimiter } from "../src/telegram/rate-limit.js";

const channel = { className: "Channel", id: 1234567890, title: "DevOps Jobs", username: "devopsjobs", broadcast: true };
const group = { className: "Chat", id: 77, title: "Old Group" };
const me = { className: "User", id: 1, firstName: "Me", username: "myself" };

/** A stand-in for GramJS: every method is a spy with a sensible default. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    getMe: vi.fn().mockResolvedValue(me),
    invoke: vi.fn().mockResolvedValue({}),
    getEntity: vi.fn().mockResolvedValue(channel),
    getInputEntity: vi.fn().mockResolvedValue({ className: "InputPeerChannel" }),
    getDialogs: vi.fn().mockResolvedValue([]),
    getParticipants: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ id: 5, message: "sent", date: 1_700_000_000 }),
    sendFile: vi.fn().mockResolvedValue({ id: 6, message: "", date: 1_700_000_000 }),
    forwardMessages: vi.fn().mockResolvedValue([{ id: 7, date: 1_700_000_000 }]),
    editMessage: vi.fn().mockResolvedValue({ id: 8, message: "edited", date: 1_700_000_000 }),
    deleteMessages: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(true),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from("file-bytes")),
    ...overrides,
  };
  return client as unknown as TelegramClient & typeof client;
}

function subject(client: ReturnType<typeof fakeClient>) {
  const limiter = new RateLimiter({
    buckets: { default: { capacity: 100, perMinute: 6000 } },
    maxFloodWaitSeconds: 60,
    floodWaitRetries: 0,
  });
  return new GramJsTelegram(async () => client, limiter);
}

describe("normalisePeer", () => {
  it("maps the Saved Messages aliases to me", () => {
    for (const alias of ["me", "Self", "saved", "Saved Messages"]) expect(normalisePeer(alias)).toBe("me");
  });

  it("keeps numeric ids numeric, including marked ones", () => {
    expect(normalisePeer("42")).toBe(42);
    expect(normalisePeer("-1001234567890")).toBe(-1001234567890);
  });

  it("strips @ and unwraps t.me links", () => {
    expect(normalisePeer("@devopsjobs")).toBe("devopsjobs");
    expect(normalisePeer("https://t.me/devopsjobs")).toBe("devopsjobs");
    expect(normalisePeer("t.me/s/devopsjobs")).toBe("devopsjobs");
    expect(normalisePeer("devopsjobs")).toBe("devopsjobs");
  });

  it("refuses an empty chat", () => {
    expect(() => normalisePeer("  ")).toThrow(TelegramToolError);
  });
});

describe("inviteHash", () => {
  it("recognises both invite link shapes and nothing else", () => {
    expect(inviteHash("https://t.me/+AbCdEf123")).toBe("AbCdEf123");
    expect(inviteHash("https://t.me/joinchat/AbCdEf123")).toBe("AbCdEf123");
    expect(inviteHash("https://t.me/devopsjobs")).toBeUndefined();
  });
});

describe("GramJsTelegram", () => {
  let client: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    client = fakeClient();
  });

  it("reports who it is signed in as", async () => {
    await expect(subject(client).status()).resolves.toMatchObject({
      authenticated: true,
      me: { id: "1", displayName: "Me" },
      cooldownSeconds: 0,
    });
  });

  it("reports not-authenticated instead of throwing", async () => {
    const failing = fakeClient({
      getMe: vi.fn().mockRejectedValue(Object.assign(new Error("no session"), { name: "NotAuthenticatedError" })),
    });
    await expect(subject(failing).status()).resolves.toMatchObject({ authenticated: false });
  });

  it("splits public search results into chats and users", async () => {
    client.invoke.mockResolvedValue({ chats: [channel], users: [me] });
    const result = await subject(client).searchPublicChats("devops jobs", 5);
    expect(result.chats[0]).toMatchObject({ id: "-1001234567890", kind: "channel" });
    expect(result.users[0]).toMatchObject({ id: "1", kind: "user" });
    expect(client.invoke.mock.calls[0]?.[0]).toMatchObject({ q: "devops jobs", limit: 5 });
  });

  it("explains what to do when a chat cannot be resolved", async () => {
    client.getEntity.mockRejectedValue(new Error("Could not find the input entity"));
    await expect(subject(client).resolveChat("-100999")).rejects.toThrow(/list_dialogs or search_chats first/);
  });

  it("filters dialogs by kind and query, then trims to the limit", async () => {
    client.getDialogs.mockResolvedValue([
      { entity: channel, unreadCount: 2, pinned: false, archived: false },
      { entity: { className: "Channel", id: 2, title: "Other Jobs", megagroup: true }, unreadCount: 0 },
      { entity: { className: "User", id: 3, firstName: "Ada" }, unreadCount: 0 },
    ]);
    const telegram = subject(client);
    await expect(telegram.listDialogs({ kinds: ["channel"] })).resolves.toHaveLength(1);
    await expect(telegram.listDialogs({ query: "jobs" })).resolves.toHaveLength(2);
    await expect(telegram.listDialogs({ limit: 1 })).resolves.toHaveLength(1);
    expect(client.getDialogs).toHaveBeenLastCalledWith({ limit: 1, archived: false });
  });

  it("enriches channel info with the description and member count", async () => {
    client.invoke.mockResolvedValue({ fullChat: { about: "Jobs board", participantsCount: 4242 } });
    await expect(subject(client).getChatInfo("@devopsjobs")).resolves.toMatchObject({
      about: "Jobs board",
      participantsCount: 4242,
    });
  });

  it("enriches user info with the bio", async () => {
    client.getEntity.mockResolvedValue({ className: "User", id: 9, firstName: "Ada", username: "ada" });
    client.invoke.mockResolvedValue({ fullUser: { about: "Analytical engine" } });
    await expect(subject(client).getUserInfo("@ada")).resolves.toMatchObject({ about: "Analytical engine" });
  });

  it("refuses to treat a channel as a user", async () => {
    await expect(subject(client).getUserInfo("@devopsjobs")).rejects.toThrow(/is not a user/);
  });

  it("joins a public channel by username", async () => {
    await expect(subject(client).joinChat("@devopsjobs")).resolves.toMatchObject({ isMember: true });
    expect(client.invoke.mock.calls[0]?.[0]?.className).toBe("channels.JoinChannel");
  });

  it("joins a private chat by invite link", async () => {
    client.invoke.mockResolvedValue({ chats: [channel] });
    await expect(subject(client).joinChat("https://t.me/+SecretHash")).resolves.toMatchObject({ title: "DevOps Jobs" });
    expect(client.invoke.mock.calls[0]?.[0]).toMatchObject({ hash: "SecretHash" });
  });

  it("errors when an invite is accepted but no chat comes back", async () => {
    client.invoke.mockResolvedValue({ chats: [] });
    await expect(subject(client).joinChat("https://t.me/+SecretHash")).rejects.toThrow(/returned no chat/);
  });

  it("leaves channels and basic groups through different calls", async () => {
    await subject(client).leaveChat("@devopsjobs");
    expect(client.invoke.mock.calls[0]?.[0]?.className).toBe("channels.LeaveChannel");

    const groupClient = fakeClient({ getEntity: vi.fn().mockResolvedValue(group) });
    await expect(subject(groupClient).leaveChat("-77")).resolves.toEqual({ left: true, chat: "-77" });
    expect(groupClient.invoke.mock.calls[0]?.[0]?.className).toBe("messages.DeleteChatUser");
  });

  it("lists members with the search filter", async () => {
    client.getParticipants.mockResolvedValue([{ className: "User", id: 3, firstName: "Ada", username: "ada" }]);
    await expect(subject(client).listChatMembers("@devopsjobs", { limit: 10, query: "ada" })).resolves.toEqual([
      { id: "3", kind: "user", displayName: "Ada", firstName: "Ada", username: "ada", link: "https://t.me/ada" },
    ]);
    expect(client.getParticipants).toHaveBeenCalledWith("devopsjobs", { limit: 10, search: "ada" });
  });

  it("passes paging and date filters through to getMessages", async () => {
    client.getMessages.mockResolvedValue([{ id: 3, message: "hi", date: 1_700_000_000 }]);
    const messages = await subject(client).readMessages("@devopsjobs", {
      limit: 5,
      offsetId: 100,
      minId: 50,
      beforeDate: "2023-11-14T22:13:20.000Z",
      fromUser: "@ada",
    });
    expect(messages[0]).toMatchObject({ id: 3, chatId: "-1001234567890", link: "https://t.me/devopsjobs/3" });
    expect(client.getMessages).toHaveBeenCalledWith("devopsjobs", {
      limit: 5,
      offsetId: 100,
      minId: 50,
      offsetDate: 1_700_000_000,
      fromUser: "ada",
    });
  });

  it("rejects an unparseable date", async () => {
    await expect(subject(client).readMessages("@devopsjobs", { beforeDate: "yesterday" })).rejects.toThrow(
      /not a valid date/,
    );
  });

  it("searches inside one chat and honours since_date", async () => {
    client.getMessages.mockResolvedValue([
      { id: 1, message: "old", date: 1_600_000_000 },
      { id: 2, message: "new", date: 1_700_000_000 },
    ]);
    const messages = await subject(client).searchMessages({
      query: "devops",
      chat: "@devopsjobs",
      sinceDate: "2023-01-01T00:00:00.000Z",
    });
    expect(messages.map((m) => m.id)).toEqual([2]);
    expect(client.getMessages.mock.calls[0]?.[1]).toMatchObject({ search: "devops", limit: 30 });
  });

  it("searches globally and attaches the chat and sender from the response index", async () => {
    client.invoke.mockResolvedValue({
      messages: [{ id: 11, message: "hiring a DevOps engineer", date: 1_700_000_000, peerId: { channelId: 1234567890 }, fromId: { userId: 1 } }],
      chats: [channel],
      users: [me],
    });
    const [message] = await subject(client).searchMessages({ query: "devops" });
    expect(message).toMatchObject({
      chatId: "-1001234567890",
      chatTitle: "DevOps Jobs",
      from: { id: "1", displayName: "Me" },
      link: "https://t.me/devopsjobs/11",
    });
    expect(client.invoke.mock.calls[0]?.[0]?.className).toBe("messages.SearchGlobal");
  });

  it("sends a message with markdown by default and no parse mode when asked", async () => {
    const telegram = subject(client);
    await telegram.sendMessage({ chat: "me", text: "hello" });
    expect(client.sendMessage).toHaveBeenLastCalledWith("me", expect.objectContaining({ parseMode: "markdown" }));
    await telegram.sendMessage({ chat: "me", text: "hello", parseMode: "none", silent: true });
    expect(client.sendMessage).toHaveBeenLastCalledWith("me", expect.objectContaining({ parseMode: undefined, silent: true }));
  });

  it("schedules a message for later", async () => {
    await subject(client).sendMessage({ chat: "me", text: "later", scheduleAt: "2023-11-14T22:13:20.000Z" });
    expect(client.sendMessage.mock.calls[0]?.[1]).toMatchObject({ schedule: 1_700_000_000 });
  });

  it("uploads base64 data as a named file", async () => {
    await subject(client).sendFile({
      chat: "me",
      source: { kind: "base64", data: Buffer.from("hello").toString("base64"), fileName: "note.txt" },
      caption: "notes",
    });
    const file = client.sendFile.mock.calls[0]?.[1]?.file as { name: string; size: number };
    expect(file).toMatchObject({ name: "note.txt", size: 5 });
  });

  it("fetches a URL and names the file after its path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    await subject(client).sendFile({ chat: "me", source: { kind: "url", url: "https://example.com/a/cv.pdf" } });
    expect((client.sendFile.mock.calls[0]?.[1]?.file as { name: string }).name).toBe("cv.pdf");
    fetchMock.mockRestore();
  });

  it("reports a failed download of a URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      subject(client).sendFile({ chat: "me", source: { kind: "url", url: "https://example.com/missing.pdf" } }),
    ).rejects.toThrow(/HTTP 404/);
    fetchMock.mockRestore();
  });

  it("passes a server path straight through", async () => {
    await subject(client).sendFile({ chat: "me", source: { kind: "path", path: "/tmp/a.pdf" }, asVoice: true });
    expect(client.sendFile.mock.calls[0]?.[1]).toMatchObject({ file: "/tmp/a.pdf", voiceNote: true });
  });

  it("forwards messages to another chat", async () => {
    await subject(client).forwardMessages({ fromChat: "@devopsjobs", messageIds: [1, 2], toChat: "me" });
    expect(client.forwardMessages).toHaveBeenCalledWith("me", {
      messages: [1, 2],
      fromPeer: "devopsjobs",
      silent: undefined,
    });
  });

  it("refuses to forward nothing", async () => {
    await expect(subject(client).forwardMessages({ fromChat: "a", messageIds: [], toChat: "me" })).rejects.toThrow(
      /must not be empty/,
    );
  });

  it("edits, deletes, marks read and reacts", async () => {
    const telegram = subject(client);
    await expect(telegram.editMessage({ chat: "me", messageId: 8, text: "fixed" })).resolves.toMatchObject({ id: 8 });
    await expect(telegram.deleteMessages({ chat: "me", messageIds: [1, 2] })).resolves.toEqual({ deleted: 2 });
    expect(client.deleteMessages).toHaveBeenCalledWith("me", [1, 2], { revoke: true });
    await expect(telegram.markRead("me")).resolves.toEqual({ ok: true });
    await expect(telegram.sendReaction({ chat: "me", messageId: 3, emoji: "👍" })).resolves.toEqual({ ok: true });
    expect(client.invoke.mock.lastCall?.[0]).toMatchObject({ msgId: 3 });
  });

  describe("downloadMedia", () => {
    const withMedia = {
      id: 4,
      date: 1_700_000_000,
      media: {
        className: "MessageMediaDocument",
        document: {
          mimeType: "application/pdf",
          attributes: [{ className: "DocumentAttributeFilename", fileName: "cv.pdf" }],
        },
      },
    };

    it("returns base64 for small files", async () => {
      client.getMessages.mockResolvedValue([withMedia]);
      await expect(subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4 })).resolves.toEqual({
        fileName: "cv.pdf",
        mimeType: "application/pdf",
        size: 10,
        base64: Buffer.from("file-bytes").toString("base64"),
      });
    });

    it("writes to disk when a path is given", async () => {
      client.getMessages.mockResolvedValue([withMedia]);
      const path = join(await mkdtemp(join(tmpdir(), "tg-dl-")), "cv.pdf");
      const result = await subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4, savePath: path });
      expect(result).toMatchObject({ path, size: 10 });
      expect(await readFile(path, "utf8")).toBe("file-bytes");
    });

    it("refuses to inline a file over the cap", async () => {
      client.getMessages.mockResolvedValue([withMedia]);
      await expect(
        subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4, maxBytes: 2 }),
      ).rejects.toThrow(/save_path/);
    });

    it("complains when the message or its media is missing", async () => {
      client.getMessages.mockResolvedValue([]);
      await expect(subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4 })).rejects.toThrow(/not found/);
      client.getMessages.mockResolvedValue([{ id: 4, message: "text only" }]);
      await expect(subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4 })).rejects.toThrow(/no media/);
    });

    it("complains when Telegram hands back no data", async () => {
      client.getMessages.mockResolvedValue([withMedia]);
      client.downloadMedia.mockResolvedValue(undefined);
      await expect(subject(client).downloadMedia({ chat: "@devopsjobs", messageId: 4 })).rejects.toThrow(/no file data/);
    });
  });
});
