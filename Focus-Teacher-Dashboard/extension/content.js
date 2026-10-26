(() => {
  const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;
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
    error: "",
    teacher: false,
    ended: false,
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
    if (!st.sessionId && !st.ended && !st.error) {
      badge?.remove();
      badge = null;
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.style.cssText =
        "position:fixed;left:16px;bottom:88px;z-index:2147483647;padding:8px 12px;border-radius:8px;" +
        "background:#131b26;color:#fff;font:600 12px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none;max-width:280px";
      document.body.appendChild(badge);
    }
    if (st.error) badge.textContent = `ClassMeet error: ${st.error}`;
    else if (st.ended) badge.textContent = "ClassMeet: class ended";
    else if (!st.joined)
      badge.textContent =
        "ClassMeet: live class found. Join the call to start tracking.";
    else
      badge.textContent = `ClassMeet tracking · ${clock(Math.floor((Date.now() - st.joinedAt) / 1000))}${st.away ? " · tab away" : ""}`;
  }

  function reset() {
    Object.assign(st, {
      sessionId: null,
      joined: false,
      away: false,
      lastResolve: 0,
      error: "",
      teacher: false,
      ended: false,
    });
    paint();
  }

  async function run() {
    const code = meetCode();
    if (code !== st.code) {
      reset();
      st.code = code;
    }
    if (!code || st.teacher) return;

    if (!st.sessionId) {
      if (Date.now() - st.lastResolve < 30000) return; // look for a live class every 30s
      st.lastResolve = Date.now();
      const ctx = await send({ type: "resolve", code });
      if (ctx?.error) {
        st.error = ctx.error;
        paint();
        return;
      }
      if (ctx?.mode === "teacher") {
        st.teacher = true;
        return;
      }
      if (ctx?.mode !== "student") return;
      st.sessionId = ctx.sessionId;
      st.ended = false;
      st.error = "";
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
    console.log("[ClassMeet]", { event, call, away, res });
    if (res?.error) st.error = res.error;
    else st.error = "";
    if (res?.status === "session_inactive") {
      // class ended: stop, but keep looking for the next one
      st.sessionId = null;
      st.joined = false;
      st.ended = true;
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

  setInterval(evaluate, 10000); // heartbeat
  setInterval(paint, 1000); // on-screen timer
  setTimeout(evaluate, 1500);
})();
