// Runs inside Google Meet. Tracks: in the call? Is the tab in focus? How long?
(() => {
  const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;
  const st = { code: null, sessionId: null, joined: false, away: false, lastResolve: 0, joinedAt: 0, done: false };
  let badge = null;

  const send = (m) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(m, (r) => resolve(chrome.runtime.lastError ? null : r)); }
    catch { resolve(null); } // extension was reloaded; old script is orphaned
  });

  const meetCode = () => (location.pathname.match(CODE_RE) || [])[1] || null;
  // The "Leave call" button only exists once the student is really inside the call (not in the lobby).
  const inCall = () => !!document.querySelector('button[aria-label*="Leave call" i]');
  const isAway = () => document.hidden || !document.hasFocus();

  function reset() {
    Object.assign(st, { sessionId: null, joined: false, away: false, lastResolve: 0, done: false });
    badge?.remove(); badge = null;
  }

  function render(text) {
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;left:16px;bottom:88px;z-index:2147483647;padding:8px 12px;' +
        'border-radius:8px;background:#131b26;color:#fff;font:600 12px/1.3 system-ui,sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none';
      document.body.appendChild(badge);
    }
    badge.textContent = text;
  }

  async function evaluate() {
    const code = meetCode();
    if (code !== st.code) { reset(); st.code = code; }
    if (!code || st.done) return;

    if (!st.sessionId) {
      if (Date.now() - st.lastResolve < 30000) return; // check for a live class every 30s
      st.lastResolve = Date.now();
      const ctx = await send({ type: 'resolve', code });
      if (ctx?.mode === 'teacher') { st.done = true; return; }
      if (ctx?.mode !== 'student') return;
      st.sessionId = ctx.sessionId;
    }

    const call = inCall(), away = isAway();
    let event = 'heartbeat';
    if (call && !st.joined) { st.joined = true; st.joinedAt = Date.now(); st.away = away; event = 'joined'; }
    else if (!call && st.joined) { st.joined = false; event = 'left'; }
    else if (!st.joined) { render('Class attendance: waiting for you to join'); return; }
    else if (away !== st.away) { event = away ? 'tab_away' : 'tab_return'; }
    st.away = away;

    const res = await send({ type: 'presence', sessionId: st.sessionId, tabActive: !away, event });
    if (res?.status === 'session_inactive') {
      st.sessionId = null; st.joined = false; st.done = true;
      render('Class ended. Your report is on its way.');
    }
  }

  let t;
  const soon = () => { clearTimeout(t); t = setTimeout(evaluate, 300); };
  document.addEventListener('visibilitychange', soon);
  window.addEventListener('blur', soon);
  window.addEventListener('focus', soon);
  window.addEventListener('pagehide', () => {
    if (st.joined && st.sessionId) send({ type: 'presence', sessionId: st.sessionId, tabActive: false, event: 'left' });
  });

  setInterval(evaluate, 10000);                      // heartbeat
  setInterval(() => {                                // on-screen timer for this visit
    if (st.sessionId && st.joined && !st.done) {
      const s = Math.floor((Date.now() - st.joinedAt) / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
      render(`Class attendance on · ${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}${st.away ? ' · tab away' : ''}`);
    }
  }, 1000);
  setTimeout(evaluate, 1500);
})();
