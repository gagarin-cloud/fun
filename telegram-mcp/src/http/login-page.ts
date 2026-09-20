export interface LoginPageOptions {
  /** The sealed OAuth request, when the human arrived here from a real client. */
  request?: string;
  /** What to call the app that is asking, e.g. "Claude". */
  clientName?: string;
  /** Where the code will be sent back to, shown so the human can judge it. */
  redirectHost?: string;
  /** Shown instead of the form when the link itself is the problem. */
  error?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The sign-in UI: one self-contained page, no build step, no framework. */
export function renderLoginPage(options: LoginPageOptions = {}): string {
  const asking = escapeHtml(options.clientName?.trim() || "An application");
  const host = options.redirectHost ? escapeHtml(options.redirectHost) : "";
  const request = options.request ? escapeHtml(options.request) : "";
  const error = options.error ? escapeHtml(options.error) : "";

  const body = error
    ? `<h1>This link will not work</h1>
       <p class="sub">${error}</p>`
    : request
      ? `<h1>${asking} wants to use your Telegram</h1>
         <p class="sub">Signing in creates a new Telegram session for ${asking}, the same as logging in on a
         new device. You can end it any time from the Telegram app under <b>Settings → Devices</b>.
         ${host ? `The result is sent back to <code>${host}</code>.` : ""}</p>

         <div id="step-phone" class="step on">
           <label for="phone">Phone number</label>
           <input id="phone" type="tel" autocomplete="tel" placeholder="+15551234567" autofocus>
           <button id="send-code">Send code</button>
           <button id="to-qr" class="ghost">Scan a QR code instead</button>
         </div>

         <div id="step-qr" class="step">
           <div id="qr" class="qr"></div>
           <p class="sub" id="qr-help">
             In Telegram, switch to the account you want to connect, then open
             <b>Settings → Devices → Link Desktop Device</b> and scan this.
           </p>
           <button id="to-phone" class="ghost">Use a phone number instead</button>
         </div>

         <div id="step-code" class="step">
           <p class="where" id="where"></p>
           <label for="code">Login code</label>
           <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="12345">
           <button id="submit-code">Verify</button>
           <button id="resend" class="ghost" disabled>Didn't get it?</button>
         </div>

         <div id="step-password" class="step">
           <label for="password">Two-factor password</label>
           <input id="password" type="password" autocomplete="current-password">
           <button id="submit-password">Sign in</button>
         </div>`
      : `<h1>Nothing to sign in to</h1>
         <p class="sub">Sign-in starts from the app you are connecting. Add this server as a custom connector
         in Claude or ChatGPT and it will send you back here with everything it needs.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="same-origin">
<link rel="icon" href="/icon-64.png" type="image/png">
<title>Connect your Telegram account</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6f8; --card: #ffffff; --ink: #14161a; --muted: #6b7280;
    --line: #e3e6ea; --accent: #2aabee; --accent-ink: #ffffff; --bad: #c0392b; --good: #1e7f4f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0e1116; --card: #161a21; --ink: #e8eaed; --muted: #9aa3af;
            --line: #262c36; --bad: #ff6b5e; --good: #4ade80; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: var(--bg); color: var(--ink);
         font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line);
          border-radius: 14px; padding: 28px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p.sub { margin: 0 0 20px; color: var(--muted); font-size: 13px; }
  label { display: block; font-size: 12px; font-weight: 600; color: var(--muted);
          text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 6px; }
  input { width: 100%; padding: 10px 12px; font-size: 15px; color: var(--ink);
          background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  button { width: 100%; margin-top: 18px; padding: 11px; font-size: 15px; font-weight: 600;
           color: var(--accent-ink); background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); margin-top: 10px;
                 font-weight: 500; }
  p.where { margin: 0 0 4px; padding: 10px 12px; font-size: 13px; color: var(--ink);
            background: rgba(42,171,238,.10); border: 1px solid rgba(42,171,238,.35); border-radius: 8px; }
  .msg { margin-top: 16px; font-size: 13px; }
  .msg.bad { color: var(--bad); } .msg.good { color: var(--good); }
  code { background: rgba(127,127,127,.14); padding: 2px 5px; border-radius: 4px; font-size: 12.5px;
         word-break: break-all; }
  .step { display: none; } .step.on { display: block; }
  .qr { background: #fff; border-radius: 10px; padding: 12px; display: grid; place-items: center; }
  .qr svg { width: 100%; height: auto; max-width: 260px; display: block; }
  .qr.stale { opacity: .35; transition: opacity .2s; }
  footer { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line);
           font-size: 12.5px; color: var(--muted); }
</style>
</head>
<body>
<main class="card">
  ${body}
  <div id="msg" class="msg"></div>
  <footer>Your code and two-factor password are used to sign in and are never stored.</footer>
</main>
<script>
  const request = ${JSON.stringify(options.request ?? "")};
  const $ = (id) => document.getElementById(id);
  const msg = $("msg");
  let loginId = "";
  let sentTo = "";
  let countdown = null;

  const RESEND_LABEL = {
    // Telegram only offers SMS to third-party apps that asked it for permission
    // (sms@telegram.org, #enableSMS), so this label is what Telegram itself said
    // it would try — not a promise that a text message will arrive.
    sms: "Ask Telegram to try SMS",
    call: "Have Telegram call me instead",
    missed_call: "Send it by missed call instead",
    app: "Send it through the Telegram app instead",
  };

  // Telegram will not send another code until its own timer runs out, so the
  // button says how long rather than failing when pressed.
  function armResend(delivery) {
    const button = $("resend");
    if (!button) return;
    const label = RESEND_LABEL[delivery.nextKind] || "Send the code again";
    if (countdown) clearInterval(countdown);
    let left = Math.max(0, Math.round(delivery.retryAfterSeconds || 0));
    const tick = () => {
      if (left <= 0) {
        button.disabled = false;
        button.textContent = label;
        clearInterval(countdown);
        return;
      }
      button.disabled = true;
      button.textContent = label + " (" + left + "s)";
      left -= 1;
    };
    tick();
    countdown = setInterval(tick, 1000);
  }

  function showDelivery(delivery, phone) {
    $("where").textContent = (phone ? "Sent to " + phone + ". " : "") + delivery.message;
    armResend(delivery);
  }

  function show(step) {
    for (const el of document.querySelectorAll(".step")) el.classList.toggle("on", el.id === "step-" + step);
  }
  function say(text, kind) {
    msg.textContent = text || "";
    msg.className = "msg" + (kind ? " " + kind : "");
  }
  async function call(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, loginId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || ("Request failed with " + res.status));
    return data;
  }
  function done(result) {
    if (result.step === "password_needed") { say("This account has two-factor authentication.", ""); show("password"); return; }
    stopPolling();
    say("Signed in. Sending you back…", "good");
    window.location.href = result.redirectTo;
  }
  function bind(id, handler) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", async () => {
      el.disabled = true;
      say("");
      try { await handler(); } catch (error) { say(error.message, "bad"); }
      el.disabled = false;
    });
  }

  // The QR panel polls this server, not Telegram: the server is told the moment
  // the code is scanned and only then asks Telegram anything.
  let polling = null;
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = null;
  }
  function drawQr(qr) {
    const box = $("qr");
    box.innerHTML = qr.svg;
    box.classList.remove("stale");
    // Telegram's tokens last about half a minute; fading the old one is honest
    // about the moment it stops being scannable.
    setTimeout(() => box.classList.add("stale"), Math.max(1000, (qr.expiresInSeconds - 2) * 1000));
  }
  async function pollQr() {
    let result;
    try {
      result = await call("/api/login/qr/poll", {});
    } catch (error) {
      stopPolling();
      say(error.message, "bad");
      return;
    }
    if (result.qr) drawQr(result.qr);
    if (result.step === "waiting") return;
    stopPolling();
    done(result);
  }

  bind("to-qr", async () => {
    const result = await call("/api/login/qr/start", {});
    loginId = result.loginId;
    drawQr(result.qr);
    show("qr");
    stopPolling();
    polling = setInterval(pollQr, 2500);
  });
  bind("to-phone", async () => {
    stopPolling();
    loginId = "";
    show("phone");
  });

  bind("send-code", async () => {
    const result = await call("/api/login/start", { phone: $("phone").value.trim() });
    if (result.step === "authenticated") return done(result);
    loginId = result.loginId;
    sentTo = result.phone || "";
    showDelivery(result.delivery, sentTo);
    show("code");
  });
  bind("resend", async () => {
    const result = await call("/api/login/resend", {});
    showDelivery(result.delivery, sentTo);
    say("Sent again.", "good");
  });
  bind("submit-code", async () => done(await call("/api/login/code", { code: $("code").value.trim() })));
  bind("submit-password", async () => done(await call("/api/login/password", { password: $("password").value })));
</script>
</body>
</html>`;
}
