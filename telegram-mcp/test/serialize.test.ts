import { describe, expect, it } from "vitest";
import {
  displayName,
  entityKind,
  markedId,
  mediaSummary,
  messageLink,
  peerToMarkedId,
  primaryUsername,
  toChatSummary,
  toDialogSummary,
  toMessageSummary,
  toUserSummary,
  idToString,
} from "../src/telegram/serialize.js";

const user = { className: "User", id: 42, firstName: "Ada", lastName: "Lovelace", username: "ada", premium: true };
const channel = { className: "Channel", id: 1234567890, title: "DevOps Jobs", username: "devopsjobs", broadcast: true };
const supergroup = { className: "Channel", id: 555, title: "IT Chat", megagroup: true };
const basicGroup = { className: "Chat", id: 77, title: "Old Group" };

describe("idToString", () => {
  it("handles BigInteger-like objects, numbers and nullish ids", () => {
    expect(idToString({ value: 9007199254740993n })).toBe("9007199254740993");
    expect(idToString(42)).toBe("42");
    expect(idToString(undefined)).toBe("");
  });
});

describe("entityKind", () => {
  it("separates users, bots, groups, supergroups and channels", () => {
    expect(entityKind(user)).toBe("user");
    expect(entityKind({ ...user, bot: true })).toBe("bot");
    expect(entityKind(basicGroup)).toBe("group");
    expect(entityKind(supergroup)).toBe("supergroup");
    expect(entityKind(channel)).toBe("channel");
    expect(entityKind({ className: "Something" })).toBe("unknown");
  });
});

describe("markedId", () => {
  it("marks channels with -100 and basic groups with -, and leaves users alone", () => {
    expect(markedId(channel)).toBe("-1001234567890");
    expect(markedId(basicGroup)).toBe("-77");
    expect(markedId(user)).toBe("42");
  });

  it("does not double-mark an already marked id", () => {
    expect(markedId({ ...channel, id: "-1001234567890" })).toBe("-1001234567890");
  });

  it("is empty for an entity without an id", () => {
    expect(markedId({ className: "Channel" })).toBe("");
  });
});

describe("primaryUsername / displayName", () => {
  it("prefers the legacy username, then the active one from usernames[]", () => {
    expect(primaryUsername(user)).toBe("ada");
    expect(primaryUsername({ className: "Channel", usernames: [{ username: "second" }] })).toBe("second");
    expect(primaryUsername({ className: "User" })).toBeUndefined();
  });

  it("builds a readable name from whatever is present", () => {
    expect(displayName(channel)).toBe("DevOps Jobs");
    expect(displayName(user)).toBe("Ada Lovelace");
    expect(displayName({ className: "User", firstName: "Solo" })).toBe("Solo");
    expect(displayName({ className: "User", username: "handle" })).toBe("@handle");
    expect(displayName({ className: "User", id: 7 })).toBe("id:7");
  });
});

describe("toUserSummary", () => {
  it("summarises a user and links to their profile", () => {
    expect(toUserSummary(user, { about: "Analytical engine", isContact: true })).toEqual({
      id: "42",
      kind: "user",
      displayName: "Ada Lovelace",
      username: "ada",
      firstName: "Ada",
      lastName: "Lovelace",
      about: "Analytical engine",
      isPremium: true,
      isContact: true,
      link: "https://t.me/ada",
    });
  });

  it("omits absent fields rather than emitting undefined", () => {
    const summary = toUserSummary({ className: "User", id: 9, bot: true, firstName: "Botty" });
    expect(summary).toEqual({ id: "9", kind: "bot", displayName: "Botty", firstName: "Botty" });
    expect("link" in summary).toBe(false);
  });
});

describe("toChatSummary", () => {
  it("summarises a channel with its extras", () => {
    expect(toChatSummary(channel, { about: "Jobs board", participantsCount: 5000 })).toEqual({
      id: "-1001234567890",
      kind: "channel",
      title: "DevOps Jobs",
      username: "devopsjobs",
      link: "https://t.me/devopsjobs",
      about: "Jobs board",
      participantsCount: 5000,
      isMember: true,
    });
  });

  it("reports left channels as not a member", () => {
    expect(toChatSummary({ ...channel, left: true }).isMember).toBe(false);
  });
});

describe("mediaSummary", () => {
  it("names the media type and pulls the file name off a document", () => {
    expect(mediaSummary({ className: "MessageMediaPhoto" })).toEqual({ type: "photo" });
    expect(mediaSummary({ className: "MessageMediaWebPage" })).toEqual({ type: "webpage" });
    expect(mediaSummary({ className: "MessageMediaPoll" })).toEqual({ type: "poll" });
    expect(mediaSummary({ className: "MessageMediaContact" })).toEqual({ type: "other" });
    expect(mediaSummary(undefined)).toBeUndefined();
    expect(
      mediaSummary({
        className: "MessageMediaDocument",
        document: {
          mimeType: "application/pdf",
          size: { value: 2048n },
          attributes: [{ className: "DocumentAttributeFilename", fileName: "cv.pdf" }],
        },
      }),
    ).toEqual({ type: "document", fileName: "cv.pdf", mimeType: "application/pdf", size: 2048 });
  });

  it("recognises video, audio, voice and stickers by their attributes", () => {
    const doc = (attributes: { className: string }[], mimeType?: string) =>
      mediaSummary({ className: "MessageMediaDocument", document: { attributes, mimeType } })?.type;
    expect(doc([{ className: "DocumentAttributeVideo" }])).toBe("video");
    expect(doc([{ className: "DocumentAttributeAudio" }])).toBe("audio");
    expect(doc([{ className: "DocumentAttributeSticker" }])).toBe("sticker");
    expect(doc([{ className: "DocumentAttributeAudio" }], "audio/ogg")).toBe("voice");
  });
});

describe("peerToMarkedId", () => {
  it("marks each peer variant", () => {
    expect(peerToMarkedId({ userId: 5 })).toBe("5");
    expect(peerToMarkedId({ chatId: 5 })).toBe("-5");
    expect(peerToMarkedId({ channelId: 5 })).toBe("-1005");
    expect(peerToMarkedId(undefined)).toBe("");
  });
});

describe("messageLink", () => {
  it("links through the username when there is one", () => {
    expect(messageLink(channel, 12)).toBe("https://t.me/devopsjobs/12");
  });

  it("falls back to the /c/ form for private channels", () => {
    expect(messageLink(supergroup, 12)).toBe("https://t.me/c/555/12");
  });

  it("has no link for private chats or missing ids", () => {
    expect(messageLink(user, 12)).toBeUndefined();
    expect(messageLink(channel, undefined)).toBeUndefined();
  });
});

describe("toMessageSummary", () => {
  it("summarises a channel post", () => {
    const summary = toMessageSummary(
      {
        id: 99,
        date: 1_700_000_000,
        message: "We are hiring a DevOps engineer",
        views: 1200,
        forwards: 3,
        peerId: { channelId: 1234567890 },
        replyTo: { replyToMsgId: 90 },
        sender: user,
      },
      { chat: channel },
    );
    expect(summary).toMatchObject({
      id: 99,
      chatId: "-1001234567890",
      chatTitle: "DevOps Jobs",
      text: "We are hiring a DevOps engineer",
      views: 1200,
      forwards: 3,
      replyToMessageId: 90,
      from: { id: "42", displayName: "Ada Lovelace", username: "ada" },
      link: "https://t.me/devopsjobs/99",
    });
    expect(summary.date).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("falls back to peerId when no chat entity is supplied", () => {
    const summary = toMessageSummary({ id: 1, peerId: { userId: 42 } });
    expect(summary.chatId).toBe("42");
    expect(summary.text).toBe("");
    expect(summary.from).toBeUndefined();
  });

  it("keeps the forward origin and the outgoing flag", () => {
    const summary = toMessageSummary({ id: 2, out: true, fwdFrom: { fromName: "Some Channel" } });
    expect(summary.forwardedFrom).toBe("Some Channel");
    expect(summary.outgoing).toBe(true);
  });
});

describe("toDialogSummary", () => {
  it("carries unread state and the last message", () => {
    expect(
      toDialogSummary({
        entity: channel,
        unreadCount: 4,
        pinned: true,
        archived: false,
        message: { id: 7, message: "latest", date: 1_700_000_000 },
      }),
    ).toMatchObject({
      id: "-1001234567890",
      unreadCount: 4,
      pinned: true,
      archived: false,
      lastMessage: { id: 7, text: "latest" },
    });
  });

  it("copes with a dialog whose entity did not load", () => {
    expect(toDialogSummary({})).toMatchObject({ id: "", kind: "unknown", unreadCount: 0 });
  });
});
