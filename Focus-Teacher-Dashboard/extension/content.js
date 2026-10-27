(() => {
  const VERSION = "v4";
  console.log("[ClassMeet] content script", VERSION, "loaded:", location.href);

  const CODE_RE = /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;
  const IN_CALL = [
    'button[aria-label*="Leave call" i]',
    'button[jsname="CQylAd"]',
    'button[aria-label*="Chat with everyone" i]',
    'button[aria-label*="Show everyone" i]',
    'button[aria-label*="Present now" i]',
  ].join(",");

  const st = {
    code: null,
    sessionId: null,
    joined: false,
    away: false,
    lastResolve: 0,
    joinedAt: 0,
    teacher: false,
    note: "",
  };
  let badge = null,
    running = false,
    again = false;

  const send = (m) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(m, (r) =>
          resolve(
            chrome.runtime.lastError
              ? { error: chrome.runtime.lastError.message }
              : r,
          ),
        );
      } catch {
        resolve({ error: "Extension was reloaded. Refresh this tab." });
      }
    });

  const meetCode = () => (location.pathname.match(CODE_RE) || [])[1] || null;
  const inCall = () => !!document.querySelector(IN_CALL);
  const isAway = () => document.hidden || !document.hasFocus();
  const clock = (s) =>
    `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  function paint() {
    let text = st.note;
    if (st.sessionId) {
      text = st.joined
        ? `Tracking · ${clock(Math.floor((Date.now() - st.joinedAt) / 1000))}${st.away ? " · tab away" : ""}${st.note ? " · " + st.note : ""}`
        : "Live class found. Join the call to start tracking.";
    }
    if (!st.code || !text) {
      badge?.remove();
      badge = null;
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText =
        "position:fixed;left:16px;bottom:88px;z-index:2147483647;padding:8px 12px;border-radius:8px;" +
        "background:#131b26;color:#fff;font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none;max-width:300px";
      document.body.appendChild(badge);
    }
    badge.textContent = "ClassMeet: " + text;
  }

  function reset() {
    Object.assign(st, {
      sessionId: null,
      joined: false,
      away: false,
      lastResolve: 0,
      teacher: false,
      note: "",
    });
    paint();
  }

  async function run() {
    const code = meetCode();
    if (code !== st.code) {
      reset();
      st.code = code;
    }
    if (!code) {
      paint();
      return;
    }
    if (st.teacher) return;

    if (!st.sessionId) {
      if (Date.now() - st.lastResolve < 15000) return;
      st.lastResolve = Date.now();
      st.note = "Checking for a live class…";
      paint();
      const ctx = await send({ type: "resolve", code });
      console.log("[ClassMeet] resolve", code, ctx);
      if (!ctx || ctx.error) {
        st.note =
          ctx?.error ||
          "No reply from the extension. Reload it and refresh this tab.";
        paint();
        return;
      }
      if (ctx.mode === "teacher") {
        st.teacher = true;
        st.note = "";
        paint();
        return;
      }
      if (ctx.mode !== "student") {
        st.note = ctx.reason || "No live class found for this Meet link.";
        paint();
        return;
      }
      st.sessionId = ctx.sessionId;
      st.note = "";
    }

    const call = inCall(),
      away = isAway();
    let event = "heartbeat";
    if (call && !st.joined) {
      st.joined = true;
      st.joinedAt = Date.now();
      st.away = away;
      event = "joined";
    } else if (!call && st.joined) {
      st.joined = false;
      event = "left";
    } else if (!st.joined) {
      paint();
      return;
    } else if (away !== st.away) {
      event = away ? "tab_away" : "tab_return";
    }
    st.away = away;

    const res = await send({
      type: "presence",
      sessionId: st.sessionId,
      tabActive: !away,
      event,
    });
    console.log("[ClassMeet] presence", { event, call, away, res });
    st.note = res?.error ? "Error: " + res.error : "";
    if (res?.status === "session_inactive") {
      st.sessionId = null;
      st.joined = false;
      st.note = "Class ended.";
      st.lastResolve = Date.now();
    }
    paint();
  }

  async function evaluate() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await run();
      } while (again);
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.type === "status") {
      reply({
        version: VERSION,
        sessionId: !!st.sessionId,
        joined: st.joined,
        inCall: inCall(),
        teacher: st.teacher,
        note: st.note,
      });
    }
  });

  let t;
  const soon = () => {
    clearTimeout(t);
    t = setTimeout(evaluate, 300);
  };
  document.addEventListener("visibilitychange", soon);
  window.addEventListener("blur", soon);
  window.addEventListener("focus", soon);
  window.addEventListener("pagehide", () => {
    if (st.joined && st.sessionId)
      send({
        type: "presence",
        sessionId: st.sessionId,
        tabActive: false,
        event: "left",
      });
  });
  setInterval(evaluate, 10000);
  setInterval(paint, 1000);
  setTimeout(evaluate, 1500);
})();
