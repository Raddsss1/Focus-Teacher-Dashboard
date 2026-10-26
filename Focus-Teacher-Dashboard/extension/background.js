// Service worker: the only place that talks to Supabase on behalf of the Meet tab.
import { getSession, getProfile, rest, rpc } from "./api.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e.message }));
  return true; // keep the channel open for the async reply
});

async function handle(msg) {
  if (!(await getSession()))
    return {
      mode: "none",
      reason: "You are logged out. Open the ClassMeet popup and log in.",
    };
  const profile = await getProfile();

  if (msg.type === "resolve") {
    if (profile?.role === "teacher") {
      // Teacher pressed "Start class" in the popup -> attach this Meet link to that session.
      const { pendingSession } =
        await chrome.storage.local.get("pendingSession");
      if (pendingSession && Date.now() - pendingSession.at < 10 * 60 * 1000) {
        await rest(`sessions?id=eq.${pendingSession.id}`, {
          method: "PATCH",
          body: {
            meeting_code: msg.code,
            meeting_url: `https://meet.google.com/${msg.code}`,
          },
        });
        await chrome.storage.local.remove("pendingSession");
      }
      return { mode: "teacher" };
    }
    // Student: is there a live class session using this Meet link?
    const rows = await rest(
      `sessions?meeting_code=eq.${msg.code}&status=eq.active&select=id&order=started_at.desc&limit=1`,
    );
    return rows[0]
      ? { mode: "student", sessionId: rows[0].id }
      : {
          mode: "none",
          reason: `No live class uses ${msg.code}. Check you joined the class code and the teacher's Meet link matches.`,
        };
  }

  if (msg.type === "presence") {
    const status = await rpc("record_presence", {
      p_session: msg.sessionId,
      p_tab_active: msg.tabActive,
      p_event: msg.event,
    });
    return { status };
  }
}
