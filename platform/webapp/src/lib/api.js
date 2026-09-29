/* API client, session and formatting helpers shared by every view. */

export const session = { token: null, user: null };
const hooks = { unauthorized: () => {}, unreachable: () => {} };
export function setApiHooks(h) { Object.assign(hooks, h); }

export function saveSession(j) {
  session.token = j.token; session.user = j.user;
  try { sessionStorage.setItem("uvp", JSON.stringify({ token: session.token, user: session.user })); } catch (_) {}
}
export function loadSession() {
  try { const s = JSON.parse(sessionStorage.getItem("uvp")); if (s?.token) { session.token = s.token; session.user = s.user; return s; } } catch (_) {}
  return null;
}
export function clearSession() { try { sessionStorage.removeItem("uvp"); } catch (_) {} session.token = null; session.user = null; }

export async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}`, ...(opts.headers || {}) } });
  } catch (e) {
    // "Failed to fetch" = no answer at all: the network to the server dropped, or the API container is restarting
    hooks.unreachable();
    throw new Error("server unreachable (" + (e.message || "network error") + ")");
  }
  if (r.status === 401) { hooks.unauthorized(); throw new Error("session expired"); }
  if (GATEWAY.includes(r.status)) { hooks.unreachable(); throw new Error(UNREACHABLE); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
export const apiJson = (path, method, body) => api(path, { method, body: JSON.stringify(body ?? {}) });

// 502/503/504 from a dev proxy or reverse proxy: the API itself is not answering
const GATEWAY = [502, 503, 504];
const UNREACHABLE = "Cannot reach the API server — is the backend running? (dev: start it, or run `npm run dev` without one for demo mode)";

/** Unauthenticated (or step-token) POST used by the login / MFA flow. */
export async function post(path, body, tok) {
  let r;
  try { r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body || {}) }); }
  catch (_) { throw new Error(UNREACHABLE); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || (GATEWAY.includes(r.status) ? UNREACHABLE : r.statusText));
  return j;
}

/** Multipart upload with the session token (no JSON content type). */
export async function upload(path, fd) {
  const r = await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${session.token}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

export const withTok = (u) => (u ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(session.token)}` : "");
const IST = { timeZone: "Asia/Kolkata", hour12: false };
export const fmtTime = (iso) => new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const toIso = (v) => (v ? new Date(v).toISOString() : "");
export const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const RANK = { viewer: 0, analyst: 1, supervisor: 2, admin: 3 };

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
