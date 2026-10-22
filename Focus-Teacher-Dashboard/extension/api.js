// Tiny Supabase client using plain fetch (no bundler needed for the extension).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const H = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
const nowSec = () => Math.floor(Date.now() / 1000);
const errMsg = (j, fb) => j?.msg || j?.error_description || j?.message || j?.error || fb;

async function saveSession(j) {
  const session = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || nowSec() + j.expires_in,
    user: { id: j.user.id, email: j.user.email },
  };
  await chrome.storage.local.set({ session });
  return session;
}

export async function signUp(email, password, role) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST', headers: H, body: JSON.stringify({ email, password, data: { role } }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(errMsg(j, 'Sign-up failed'));
  if (!j.access_token) return { needsConfirm: true }; // email confirmation is switched on
  await saveSession(j);
  return { needsConfirm: false, profile: await loadProfile() };
}

export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: H, body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(errMsg(j, 'Wrong email or password'));
  await saveSession(j);
  return loadProfile();
}

export const signOut = () => chrome.storage.local.remove(['session', 'profile', 'pendingSession']);

export async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return null;
  if (session.expires_at - 60 > nowSec()) return session;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: H, body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const j = await res.json();
  if (!res.ok) { await chrome.storage.local.remove('session'); return null; }
  return saveSession(j);
}

export async function rest(path, { method = 'GET', body, prefer } = {}) {
  const s = await getSession();
  if (!s) throw new Error('Please log in again.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { ...H, Authorization: `Bearer ${s.access_token}`, ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const j = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(errMsg(j, `Request failed (${res.status})`));
  return j;
}

export const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: args });

export async function callFunction(name, body) {
  const s = await getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { ...H, Authorization: `Bearer ${s.access_token}` }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || j.message || 'Function failed');
  return j;
}

export async function loadProfile() {
  const s = await getSession();
  const rows = await rest(`profiles?id=eq.${s.user.id}&select=*`);
  const profile = rows[0] || null;
  await chrome.storage.local.set({ profile });
  return profile;
}

export async function getProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return profile || loadProfile();
}

// 5252 -> "1:27:32 (1 hr 27 min 32 sec)"
export function fmt(total = 0) {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} (${h} hr ${m} min ${s} sec)`;
}
