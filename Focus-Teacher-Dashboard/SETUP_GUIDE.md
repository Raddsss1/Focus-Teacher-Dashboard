# ClassMeet – Setup Guide

Project layout
```
classmeet/
├── extension/   Chrome extension (Manifest V3, no build step)
├── dashboard/   React + Vite teacher dashboard
└── supabase/    schema.sql + Edge Function that emails the reports
```
Do the parts in this order: **1 Supabase → 2 Dashboard locally → 3 Extension → 4 Emails → 5 Vercel → 6 Final wiring.**

---
## 1. Set up Supabase

1. Go to https://supabase.com → **New project**. Pick a name, a strong database password, and the region closest to you (e.g. Singapore). Wait ~2 minutes.
2. Open **SQL Editor → New query**, paste the full contents of `supabase/schema.sql`, click **Run**. This creates the tables, the automatic class-code generator (each teacher gets a 6-character code at sign-up), Row Level Security, and the `join_class` / `record_presence` functions.
3. **Authentication → Sign In / Providers → Email**: for testing, turn **off** "Confirm email" so people can log in right after sign-up. (If you leave it on, users must click the confirmation link first. Both the extension and the dashboard handle either setting.)
4. Copy your two keys from **Project Settings → API** (or **Connect**):
   - **Project URL** → `https://xxxxxxxx.supabase.co`
   - **anon / public key** (the long `eyJ…` string; newer projects may label it "publishable key")

   Never use the `service_role` key in the extension or dashboard. It bypasses all security.

## 2. Connect Supabase to the React dashboard

```bash
cd dashboard
npm install
cp .env.example .env
```
Edit `.env`:
```
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your anon key...
```
Run `npm run dev` and open the printed URL (http://localhost:5173). Sign up as a teacher and you will see your class code at the top.

The key lives in `src/supabaseClient.js`, which reads those two variables via `import.meta.env`. The anon key is meant to be public; Row Level Security in `schema.sql` is what protects the data.

## 3. Install the extension and link it to the same Supabase project

1. Open `extension/config.js` and set:
   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJ...same anon key...';
   export const DASHBOARD_URL = 'http://localhost:5173';  // change to your Vercel URL later
   ```
2. Open `extension/manifest.json` and replace `YOUR-PROJECT-REF` in `host_permissions` with your project's ref (the part before `.supabase.co`).
3. In Chrome go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose the `extension` folder. Pin it from the puzzle-piece menu.

**How the extension and dashboard connect:** they don't talk to each other directly. Both use the same Supabase project, and the same account works in both. The extension writes attendance, and the dashboard reads it (live, through Supabase Realtime). The popup's **Open dashboard** button just opens `DASHBOARD_URL`.

### Test it end to end
1. **Teacher** (Chrome profile A): popup → Sign up → Teacher. Copy the class code.
2. **Student** (Chrome profile B, or another computer): popup → Sign up → Student → paste the class code → Join.
3. Teacher clicks **Start class on Google Meet**. Meet opens; the extension attaches the meeting link to the session. Click **Join now** in Meet.
4. Student popup → **Join live class** → join the call. A small badge appears in the corner of Meet showing the tracked time.
5. Switch tabs as the student; on the dashboard, the status changes to "Away from tab" within about a second. Come back, and it returns to "Active".
6. Teacher clicks **End class & email reports** (popup or dashboard).

## 4. Turn on the emails (Edge Function + Resend)

1. Create a free account at https://resend.com and make an API key.
   - **Important:** without a verified domain, Resend only delivers to your own account email. To email real students, add and verify a domain in Resend, then use an address on it as `FROM_EMAIL`.
2. In Supabase go to **Edge Functions → Deploy a new function → Via Editor**, name it exactly `send-attendance-report`, paste `supabase/functions/send-attendance-report/index.ts`, and deploy. (CLI alternative: `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase functions deploy send-attendance-report`.)
3. **Edge Functions → Secrets**, add:
   - `RESEND_API_KEY` = your key
   - `FROM_EMAIL` = `ClassMeet <reports@yourdomain.com>` (optional while testing; defaults to Resend's `onboarding@resend.dev`)

   `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the function automatically.

Each enrolled student gets their own report (time in meeting, time with the tab in focus, number of tab exits, or "absent"). The teacher gets a summary table.

## 5. Deploy the dashboard on Vercel (free Hobby plan)

1. Put the project on GitHub. The `.gitignore` already keeps `.env` out of the repo.
   ```bash
   cd classmeet && git init && git add . && git commit -m "ClassMeet"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/YOU/classmeet.git && git push -u origin main
   ```
2. https://vercel.com → **Add New → Project** → import the repo.
3. Set **Root Directory** to `dashboard`. Framework preset: **Vite** (auto-detected; build `npm run build`, output `dist`).
4. Open **Environment Variables** and add both (same values as your `.env`):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. Click **Deploy**. You get a URL like `https://classmeet-xyz.vercel.app`. (If you edit the variables later, **Redeploy**, because Vite bakes them in at build time.)
   `vercel.json` makes page refreshes work.

## 6. Final wiring after deploying

- Supabase **Authentication → URL Configuration**: set **Site URL** to your Vercel URL (used in confirmation emails).
- `extension/config.js`: change `DASHBOARD_URL` to the Vercel URL, then click the reload icon on the extension in `chrome://extensions`.
- To distribute the extension to students: zip the `extension` folder and either share it for "Load unpacked" or publish it on the Chrome Web Store ($5 one-time developer fee; you must disclose that it collects attendance data).

---
## How tracking works
- The content script runs only on `meet.google.com`. It counts a student as **in the meeting** when Meet's "Leave call" button exists (not just the lobby), and as **away** when the tab is hidden or the window loses focus (`visibilitychange`, `blur`).
- It pings Supabase every 10 seconds and instantly on join/leave/tab changes. **Time is counted on the server**, so it can't be edited from the browser. Gaps longer than 30 seconds (laptop asleep, tab killed) are not counted.
- Display format: `5252` seconds → `1:27:32` (1 hr 27 min 32 sec).
- A student is "Disconnected" on the dashboard if no ping arrives for 35 seconds.

## Known limits
- Meet's "Leave call" button is found by its English label. If Meet runs in another language, change the selector in `extension/content.js` (`inCall`) to a label in that language.
- Google can change Meet's page structure, so recheck that selector if detection stops.
- "Away" means the tab/window lost focus. It can't see what the student does in another window.
- The extension doesn't end the class automatically when the teacher leaves Meet. The teacher presses **End class & email reports**.
- Sign-up role is chosen by the user. Anyone can register as a teacher. If you need to restrict this, add an invite code or approval step.
