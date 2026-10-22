// Supabase Edge Function: ends a session and emails attendance reports.
// Called by the extension / dashboard when the teacher clicks "End class".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")} (${h} hr ${m} min ${sec} sec)`;
};
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL") ?? "ClassMeet <onboarding@resend.dev>", to: [to], subject, html }),
  });
  if (!res.ok) console.error("Resend error", to, await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { session_id } = await req.json();
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: session } = await admin.from("sessions").select("*, classes(*)").eq("id", session_id).single();
    if (!session || session.classes.teacher_id !== user.id) return json({ error: "Forbidden" }, 403);
    if (session.report_sent_at) return json({ error: "Reports for this session were already sent." }, 409);

    // Close anyone still marked as in the meeting (e.g. closed their laptop).
    const { data: rows } = await admin.from("attendance").select("*").eq("session_id", session_id);
    for (const r of rows ?? []) {
      if (r.in_meeting) await admin.from("attendance").update({ in_meeting: false, left_at: r.last_seen }).eq("id", r.id);
    }
    const endedAt = new Date().toISOString();
    await admin.from("sessions").update({ status: "ended", ended_at: endedAt }).eq("id", session_id);

    const { data: enrolled } = await admin.from("enrollments").select("student_id, profiles(email)").eq("class_id", session.class_id);
    const byStudent = new Map((rows ?? []).map((r) => [r.student_id, r]));
    const { data: teacher } = await admin.from("profiles").select("email").eq("id", user.id).single();

    const date = new Date(session.started_at).toUTCString();
    const code = session.classes.class_code;
    let sent = 0, failed = 0;
    const summary: string[] = [];

    for (const e of enrolled ?? []) {
      const email = (e as any).profiles?.email as string;
      const r = byStudent.get(e.student_id);
      const total = r?.total_seconds ?? 0, active = r?.active_seconds ?? 0, away = r?.away_count ?? 0;
      summary.push(`<tr><td>${esc(email)}</td><td>${r ? fmt(total) : "Absent"}</td><td>${r ? fmt(active) : "-"}</td><td>${away}</td></tr>`);
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px">
        <h2>Your attendance report</h2>
        <p>Class code <b>${esc(code)}</b> &middot; ${esc(date)}</p>
        ${r ? `<table cellpadding="8" style="border-collapse:collapse">
          <tr><td>Time in the meeting</td><td><b>${fmt(total)}</b></td></tr>
          <tr><td>Time with the Meet tab in focus</td><td><b>${fmt(active)}</b></td></tr>
          <tr><td>Times you left the Meet tab</td><td><b>${away}</b></td></tr></table>`
          : `<p>You were marked <b>absent</b> for this session.</p>`}
      </div>`;
      (await sendEmail(email, `Attendance report – class ${code}`, html)) ? sent++ : failed++;
    }

    if (teacher?.email) {
      await sendEmail(teacher.email, `Class summary – ${code}`,
        `<div style="font-family:Arial,sans-serif"><h2>Class summary</h2><p>${esc(date)}</p>
         <table border="1" cellpadding="6" style="border-collapse:collapse">
         <tr><th>Student</th><th>In meeting</th><th>Tab in focus</th><th>Tab exits</th></tr>${summary.join("")}</table></div>`);
    }

    await admin.from("sessions").update({ report_sent_at: new Date().toISOString() }).eq("id", session_id);
    return json({ ok: true, sent, failed, students: enrolled?.length ?? 0 });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
