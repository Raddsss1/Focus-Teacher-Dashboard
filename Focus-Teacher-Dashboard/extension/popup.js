import {
  signUp,
  signIn,
  signOut,
  getSession,
  getProfile,
  rest,
  rpc,
  callFunction,
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
  liveSession = null;

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
    $("password").autocomplete =
      tab === "signup" ? "new-password" : "current-password";
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

$("t-dash").addEventListener("click", () =>
  chrome.tabs.create({ url: DASHBOARD_URL }),
);

/* ───────── Student ───────── */
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

/* ───────── Boot ───────── */
async function route() {
  if (!(await getSession())) return show("v-auth");
  const profile = await getProfile();
  return profile?.role === "teacher" ? loadTeacher() : loadStudent();
}
guard(route);
