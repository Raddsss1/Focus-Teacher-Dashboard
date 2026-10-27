import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

const fmt = (t = 0) => {
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return `${h} hr ${m} min ${s} sec`;
};

export default function Dashboard() {
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [classCode, setClassCode] = useState("");
  const [rows, setRows] = useState([]);

  // keep track of who is logged in
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // load students + time spent, refresh every 15 seconds
  useEffect(() => {
    if (!session) return;

    async function load() {
      const { data: cls } = await supabase
        .from("classes")
        .select("id, class_code")
        .eq("teacher_id", session.user.id)
        .single();
      if (!cls) return;
      setClassCode(cls.class_code);

      const { data: students } = await supabase
        .from("enrollments")
        .select("student_id, profiles(name, email)")
        .eq("class_id", cls.id);

      const { data: attendance, error: attError } = await supabase
        .from("attendance")
        .select("student_id, total_seconds, sessions!inner(class_id)")
        .eq("sessions.class_id", cls.id);
      if (attError) console.error("attendance error:", attError);

      // add up each student's time across all sessions
      const totals = {};
      for (const a of attendance ?? []) {
        totals[a.student_id] = (totals[a.student_id] ?? 0) + a.total_seconds;
      }

      setRows(
        (students ?? []).map((s, i) => ({
          number: i + 1,
          id: s.student_id,
          name: s.profiles?.name,
          email: s.profiles?.email,
          seconds: totals[s.student_id] ?? 0,
        })),
      );
    }

    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [session]);

  async function login(e) {
    e.preventDefault();
    setError("");
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setError(error.message);
  }

  // not logged in -> show login form
  if (!session) {
    return (
      <div className="relative bg-slate-950 text-white min-h-screen flex flex-col items-center justify-center gap-4">
        {/* Circle Gradient */}
        <div className="absolute -top-20 -right-80 gradient-circle-lg blur-xl"></div>
        <div className="absolute bottom-20 -left-80 gradient-circle-lg blur-xl"></div>
        {/* HEADER */}
        <div className="p-6 px-[4em] bg-slate-900 rounded-lg text-white items-center justify-center">
          <h1 className="text-6xl md:text-7xl font-bold">Focus</h1>
        </div>
        {/* FORM */}
        <div className="flex flex-col items-center gap-4 mt-10">
          <form onSubmit={login} className="flex flex-col gap-3 w-80">
            <h1 className="text-xl font-bold">Teacher log in</h1>
            <input
              className="px-3 py-2 rounded bg-slate-800"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="px-3 py-2 rounded bg-slate-800"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button className="px-3 py-2 rounded bg-white text-slate-950 font-semibold cursor-pointer hover:bg-slate-300 transition-colors">
              Log in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="relative bg-slate-950 text-white min-h-screen">
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        {/* Circle Gradient */}
        <div className="absolute -top-30 -right-90 gradient-circle-lg blur-xl"></div>
        <div className="absolute bottom-10 -left-80 gradient-circle-lg blur-xl"></div>
        {/* HEADER */}
        <div className="p-6 px-[4em] flex flex-col bg-slate-900 rounded-lg text-white items-center justify-center">
          <h1 className="text-6xl md:text-7xl font-bold mb-2">
            Teacher Dashboard
          </h1>
          <button
            className="underline text-slate-400 cursor-pointer mb-4 hover:text-slate-200 transition-colors"
            onClick={() => supabase.auth.signOut()}
          >
            Log out
          </button>
          {/* STUDENTS TABLE */}
          <table className="table-auto border-collapse border border-slate-500">
            <thead>
              <tr>
                <th className="border border-slate-500 px-4 py-2">User ID</th>
                <th className="border border-slate-500 px-4 py-2">Name</th>
                <th className="border border-slate-500 px-4 py-2">Email</th>
                <th className="border border-slate-500 px-4 py-2">
                  Unique Class Code
                </th>
                <th className="border border-slate-500 px-4 py-2">
                  Time Spent
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="border border-slate-500 px-4 py-2 text-center text-slate-400"
                  >
                    No students yet. Share your class code.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="border border-slate-500 px-4 py-2">
                      {r.number}
                    </td>
                    <td className="border border-slate-500 px-4 py-2">
                      {r.name}
                    </td>
                    <td className="border border-slate-500 px-4 py-2">
                      {r.email}
                    </td>
                    <td className="border border-slate-500 px-4 py-2">
                      {classCode}
                    </td>
                    <td className="border border-slate-500 px-4 py-2">
                      {fmt(r.seconds)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
