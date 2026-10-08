/** Fetch wrapper for the Unified CCTV API: bearer token, JSON, one quick retry for reads, 401 -> sign out. */
import { toast } from "./toast";

export type Session = { token: string; user: User };
export type User = {
  username: string; role: string; departments: string[]; features: string[]; cameras?: string[];
  is_super?: boolean; mfa?: boolean; tenant?: string; provider?: string;
};

const KEY = "uvp";                                  // same sessionStorage key as the legacy console -> both stay signed in together

export function loadSession(): Session | null {
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || "null"); return s?.token ? s : null; } catch { return null; }
}
export function saveSession(s: Session | null) {
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}
export function token(): string { return loadSession()?.token || ""; }

export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }
let downToastAt = 0;

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const req = () => fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts.headers || {}) } });
  let r: Response;
  try {
    try { r = await req(); }
    catch (e) { if (opts.method && opts.method !== "GET") throw e; await new Promise((ok) => setTimeout(ok, 400)); r = await req(); }
  } catch (e: any) {
    if (Date.now() - downToastAt > 8000) { downToastAt = Date.now(); toast(`Cannot reach the API server at ${location.host} (your network, or the api container restarting). Reconnecting automatically…`, "err"); }
    throw new ApiError(0, `API server ${location.host} unreachable while loading ${path.split("?")[0]} (${e?.message || "network error"})`);
  }
  if (r.status === 401) { onUnauthorized?.(); throw new ApiError(401, "session expired"); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new ApiError(r.status, j.detail || r.statusText); }
  return r.json();
}

export async function post<T = any>(path: string, body: unknown, tok?: string): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.detail || r.statusText);
  return j;
}

export const withTok = (url: string) => `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token())}`;
