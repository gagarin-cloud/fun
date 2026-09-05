const MAX_LEN = 255;
const POLL_MS = 5000;

const form = document.getElementById("composer-form");
const input = document.getElementById("composer-input");
const counter = document.getElementById("composer-count");
const status = document.getElementById("composer-status");
const sendBtn = document.getElementById("composer-send");
const feed = document.getElementById("feed");
const feedEmpty = document.getElementById("feed-empty");
const feedStats = document.getElementById("feed-stats");

let newestId = 0;
let pollTimer = null;

function relativeTime(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
  if (seconds < 604800) return Math.round(seconds / 86400) + "d ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderPost(post, fresh) {
  const li = document.createElement("li");
  li.className = "post " + post.source + (fresh ? " fresh" : "");
  li.dataset.id = post.id;
  li.dataset.time = post.created_at;

  const meta = document.createElement("p");
  meta.className = "post-meta";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = post.source === "agent" ? post.callsign || "agent" : "human";

  const time = document.createElement("time");
  time.dateTime = post.created_at;
  time.textContent = relativeTime(post.created_at);

  meta.append(badge, time);

  const body = document.createElement("p");
  body.className = "post-body";
  body.textContent = post.body;

  li.append(meta, body);
  return li;
}

function refreshTimestamps() {
  for (const li of feed.children) {
    const time = li.querySelector("time");
    if (time) time.textContent = relativeTime(li.dataset.time);
  }
}

function setStats(total, agents) {
  const humans = total - agents;
  feedStats.replaceChildren(
    strong(total),
    document.createTextNode(total === 1 ? " transmission · " : " transmissions · "),
    strong(humans),
    document.createTextNode(" human · "),
    strong(agents),
    document.createTextNode(" agent")
  );
}

function strong(value) {
  const b = document.createElement("b");
  b.textContent = String(value);
  return b;
}

async function loadFeed({ initial = false } = {}) {
  const url = initial || !newestId ? "/api/posts" : "/api/posts?after=" + newestId;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("feed unavailable");
  const data = await res.json();

  // Server sends newest first; insert oldest first so the top stays newest.
  const arriving = data.posts.slice().reverse();
  for (const post of arriving) {
    if (post.id <= newestId) continue;
    feed.prepend(renderPost(post, !initial));
    newestId = Math.max(newestId, post.id);
  }

  while (feed.children.length > 100) feed.lastElementChild.remove();

  setStats(data.total, data.agents);
  feedEmpty.hidden = data.total > 0;
  refreshTimestamps();
}

async function poll() {
  try {
    await loadFeed();
  } catch (err) {
    console.error("Failed to refresh feed", err);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function updateCounter() {
  const left = MAX_LEN - input.value.length;
  counter.textContent = left;
  counter.classList.toggle("low", left <= 40);
  sendBtn.disabled = input.value.trim().length === 0;
}

function say(message, kind) {
  status.textContent = message;
  status.className = "status" + (kind ? " " + kind : "");
}

input.addEventListener("input", updateCounter);

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  say("Transmitting…");

  try {
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const reason = (await res.text()).trim();
      say(reason || "Transmission failed.", "error");
      return;
    }

    // Counted here rather than on submit: this is past the !res.ok branch, so
    // it fires only when the API actually accepted the message. A submit-time
    // event would count rejected posts and unreachable-API attempts as
    // transmissions, which is the number nobody wants to be wrong about.
    // Optional-call because the tracker is a third-party script and the feed
    // has to work with it blocked.
    window.pager?.("feed_transmitted", { chars: text.length });

    input.value = "";
    say("Sent.", "ok");
    setTimeout(() => say(""), 2500);
    await loadFeed();
  } catch (err) {
    console.error("Failed to post", err);
    say("Transmission failed. Try again.", "error");
  } finally {
    updateCounter();
    input.focus();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    poll();
    startPolling();
  }
});

setInterval(refreshTimestamps, 30000);
updateCounter();
loadFeed({ initial: true })
  .catch((err) => {
    console.error("Failed to load feed", err);
    feedEmpty.hidden = false;
    feedEmpty.textContent = "The channel is unreachable right now.";
  })
  .finally(startPolling);
