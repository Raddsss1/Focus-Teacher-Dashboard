import {
  signUp,
  signIn,
  signOut,
  getSession,
  getProfile,
  rest,
  rpc,
  fmt,
} from "./api.js";
import { DASHBOARD_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const esc = (t) =>
  String(t).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
let tab = "login";
let teacherClass = null,
  liveSession = null,
  nowTimer;

function msg(text = "", ok = false) {
  const m = $("msg");
  m.textContent = text;
  m.className = ok ? "ok" : "";
}
function show(view) {
  for (const v of ["v-auth", "v-teacher", "v-student"])
    $(v).classList.toggle("hidden", v !== view);
  $("logout").classList.toggle("hidden", view === "v-auth");
}
async function guard(fn) {
  try {
    msg();
    await fn();
  } catch (e) {
    msg(e.message);
  }
}

/* ───────── Auth ───────── */
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    document
      .querySelectorAll(".tabs button")
      .forEach((x) => x.classList.toggle("on", x === b));
    $("roles").classList.toggle("hidden", tab !== "signup");
    $("submit").textContent = tab === "signup" ? "Create account" : "Log in";
    msg();
  }),
);

$("submit").addEventListener("click", () =>
  guard(async () => {
    const email = $("email").value.trim(),
      password = $("password").value;
    if (!email || password.length < 6)
      throw new Error("Enter your email and a password of 6+ characters.");
    if (tab === "signup") {
      const role = document.querySelector("input[name=role]:checked").value;
      const r = await signUp(email, password, role);
      if (r.needsConfirm)
        return msg(
          "Account created. Confirm the email we sent, then log in.",
          true,
        );
    } else {
      await signIn(email, password);
    }
    await route();
  }),
);

$("logout").addEventListener("click", async () => {
  await signOut();
  show("v-auth");
  msg();
});

/* ───────── Teacher ───────── */
async function loadTeacher() {
  show("v-teacher");
  const s = await getSession();
  [teacherClass] = await rest(`classes?teacher_id=eq.${s.user.id}&select=*`);
  $("t-code").textContent = teacherClass?.class_code ?? "------";
  [liveSession] = await rest(
    `sessions?class_id=eq.${teacherClass.id}&status=eq.active&order=started_at.desc&limit=1`,
  );
  $("t-idle").classList.toggle("hidden", !!liveSession);
  $("t-live").classList.toggle("hidden", !liveSession);
  if (liveSession) {
    const hasLink = !!liveSession.meeting_url;
    $("t-link").textContent = hasLink
      ? liveSession.meeting_url
      : "Waiting for the Meet tab to open…";
    $("t-paste").classList.toggle("hidden", hasLink);
  }
}

$("t-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(teacherClass.class_code);
  msg("Class code copied.", true);
});

$("t-start").addEventListener("click", () =>
  guard(async () => {
    const [session] = await rest("sessions", {
      method: "POST",
      body: { class_id: teacherClass.id },
      prefer: "return=representation",
    });
    await chrome.storage.local.set({
      pendingSession: { id: session.id, at: Date.now() },
    });
    chrome.tabs.create({ url: "https://meet.new" });
    window.close();
  }),
);

$("t-attach").addEventListener("click", () =>
  guard(async () => {
    const m = $("t-url")
      .value.trim()
      .toLowerCase()
      .match(/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    if (!m) throw new Error("Enter a Meet link or code like abc-defg-hij.");
    const rows = await rest(`sessions?id=eq.${liveSession.id}`, {
      method: "PATCH",
      body: {
        meeting_code: m[1],
        meeting_url: `https://meet.google.com/${m[1]}`,
      },
      prefer: "return=representation",
    });
    if (!rows.length)
      throw new Error(
        "Nothing was updated. Log out and back in, then try again.",
      );
    await loadTeacher();
    msg("Meet link saved.", true);
  }),
);

$("t-end").addEventListener("click", () =>
  guard(async () => {
    if (!confirm("End the class and save attendance?")) return;
    const r = await rpc("end_session", { p_session: liveSession.id });
    msg(`Class ended. ${r.attended} student(s) attended.`, true);
    await loadTeacher();
  }),
);

$("t-dash").addEventListener("click", () => {
  const url = /^https?:\/\//i.test(DASHBOARD_URL)
    ? DASHBOARD_URL
    : `https://${DASHBOARD_URL}`;
  chrome.tabs.create({ url });
});

/* ───────── Student ───────── */
async function refreshNow() {
  const s = await getSession();
  if (!s) return;
  const rows = await rest(
    `attendance?student_id=eq.${s.user.id}&in_meeting=eq.true&sessions.status=eq.active&select=total_seconds,away_count,sessions!inner(status)&limit=1`,
  );
  clearInterval(nowTimer);
  const el = $("s-now");
  if (!rows.length) {
    el.textContent = "Not in a class right now.";
    return;
  }
  const base = rows[0].total_seconds,
    t0 = Date.now();
  const draw = () => {
    el.innerHTML = `<b>${fmt(base + Math.floor((Date.now() - t0) / 1000))}</b><br>Left the tab ${rows[0].away_count}×`;
  };
  draw();
  nowTimer = setInterval(draw, 1000);
}
setInterval(() => refreshNow().catch(() => {}), 10000);

async function loadStudent() {
  show("v-student");
  const s = await getSession();
  const enr = await rest(
    `enrollments?student_id=eq.${s.user.id}&select=classes(id,class_code,name)`,
  );
  const box = $("s-classes");
  box.innerHTML = "";
  for (const { classes: c } of enr) {
    const [live] = await rest(
      `sessions?class_id=eq.${c.id}&status=eq.active&meeting_url=not.is.null&order=started_at.desc&limit=1`,
    );
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<div><b>${esc(c.class_code)}</b> · ${esc(c.name)}</div>` +
      (live
        ? `<button class="primary">Join live class</button>`
        : `<span class="hint">No live class right now.</span>`);
    card
      .querySelector("button")
      ?.addEventListener("click", () =>
        chrome.tabs.create({ url: live.meeting_url }),
      );
    box.appendChild(card);
  }
  const recent = await rest(
    `attendance?student_id=eq.${s.user.id}&select=total_seconds,away_count,sessions(started_at)&order=joined_at.desc&limit=4`,
  );
  $("s-recent").innerHTML = recent.length
    ? recent
        .map(
          (r) =>
            `${new Date(r.sessions.started_at).toLocaleDateString()}: <b>${fmt(r.total_seconds)}</b>, left tab ${r.away_count}×`,
        )
        .join("<br>")
    : "Nothing yet.";
  refreshNow().catch(() => {});
}

$("s-join").addEventListener("click", () =>
  guard(async () => {
    const code = $("s-code").value.trim();
    if (!code) throw new Error("Enter the class code from your teacher.");
    await rpc("join_class", { p_code: code });
    $("s-code").value = "";
    msg("You joined the class.", true);
    await loadStudent();
  }),
);

$("s-check").addEventListener("click", () =>
  guard(async () => {
    const s = await getSession();
    if (!s) throw new Error("Not logged in.");
    const p = await getProfile();
    const out = [`Logged in as: ${s.user.email} (${p?.role})`];
    const enr = await rest(
      `enrollments?student_id=eq.${s.user.id}&select=class_id`,
    );
    out.push(`Classes joined: ${enr.length}`);
    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    if (!tabs.length) out.push("Meet tab: none open in this Chrome profile");
    for (const t of tabs) {
      const code = (t.url.match(
        /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/,
      ) || [])[1];
      out.push(`Meet tab: ${code || t.url}`);
      if (!code) continue;
      const direct = await rest(
        `sessions?meeting_code=eq.${code}&status=eq.active&select=id`,
      );
      out.push(
        `  Database sees ${direct.length} live session(s) for this code`,
      );
      const bg = await new Promise((res) =>
        chrome.runtime.sendMessage({ type: "resolve", code }, (x) =>
          res(
            chrome.runtime.lastError
              ? { error: chrome.runtime.lastError.message }
              : x,
          ),
        ),
      );
      out.push(`  Background worker replies: ${JSON.stringify(bg)}`);
      const pg = await new Promise((res) =>
        chrome.tabs.sendMessage(t.id, { type: "status" }, (x) =>
          res(chrome.runtime.lastError ? null : x),
        ),
      );
      out.push(
        pg
          ? `  Meet page: script=${pg.version} in-call=${pg.inCall} tracking=${pg.joined} sessionFound=${pg.sessionId} teacherMode=${pg.teacher} note="${pg.note || ""}"`
          : "  Meet page: extension NOT running here (refresh the tab)",
      );
      if (direct.length) {
        try {
          const r = await rpc("record_presence", {
            p_session: direct[0].id,
            p_tab_active: true,
            p_event: "heartbeat",
          });
          out.push(`  Direct save test: ${JSON.stringify(r)}`);
        } catch (e) {
          out.push(`  Direct save test FAILED: ${e.message}`);
        }
      }
    }
    $("s-report").textContent = out.join("\n");
  }),
);

/* ───────── Boot ───────── */
async function route() {
  if (!(await getSession())) return show("v-auth");
  const profile = await getProfile();
  return profile?.role === "teacher" ? loadTeacher() : loadStudent();
}
guard(route);
