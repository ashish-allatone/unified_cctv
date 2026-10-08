/* Field-officer PWA: same API as the console, phone-sized. Installs from the browser menu ("Add to Home screen"). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (iso) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const S = { token: null, user: null, mfa: null, ws: null };
const tok = (u) => `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(S.token)}`;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}`, ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); throw new Error("session expired"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}
function setSession(j) { S.token = j.token; S.user = j.user; try { localStorage.setItem("uvp-field", JSON.stringify({ token: S.token, user: S.user })); } catch (_) {} }
function logout() { try { localStorage.removeItem("uvp-field"); } catch (_) {} location.reload(); }

$("#login-form").onsubmit = async (ev) => {
  ev.preventDefault(); const f = ev.target; $("#login-error").textContent = "";
  try {
    let j;
    if (S.mfa) j = await fetch("/api/auth/mfa/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mfa_token: S.mfa, code: f.code.value }) }).then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e.detail); }));
    else j = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }).then((r) => r.ok ? r.json() : r.json().then((e) => { throw new Error(e.detail); }));
    if (j.mfa_required) { S.mfa = j.mfa_token; $("#mfa-row").classList.remove("hidden"); f.code.focus(); return; }
    setSession(j); start();
  } catch (e) { $("#login-error").textContent = e.message; }
};
$("#logout").onclick = logout;
$$("#nav button").forEach((b) => b.onclick = () => show(b.dataset.v));

function show(v) {
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  $$("#app section").forEach((s) => s.classList.toggle("hidden", s.id !== `v-${v}`));
  ({ alerts: loadAlerts, incidents: loadIncidents, cases: loadCases }[v] || (() => {}))();
}
async function start() {
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#who").textContent = `${S.user.username} · ${S.user.role} · ${(S.user.departments || []).join(", ")}`;
  if (S.user.branding && S.user.branding.title) $("#title").textContent = S.user.branding.title;
  loadAlerts(); connectWs();
}
async function loadAlerts() {
  const rows = await api("/api/alerts?limit=50");
  $("#alerts-sub").textContent = `${rows.filter((a) => !a.ack_by).length} open`;
  $("#alerts").innerHTML = rows.map((a) => `<div class="card ${esc(a.priority)}"><div class="row"><span class="plate">${esc(a.plate)}</span><span class="small muted">${esc(fmt(a.ts))}</span></div>
    <div class="small"><span class="chip">${esc(a.match === "rule" ? a.watchlist_plate.toLowerCase().replace(/_/g, " ") : "watchlist " + a.match)}</span>${esc(a.camera_id)} · ${esc(a.department)}</div>
    <div class="small muted">${esc(a.reason)}</div>${a.crop_url ? `<img class="snap" src="${esc(tok(a.crop_url))}" alt="">` : ""}
    ${a.ack_by ? `<div class="small ok">acknowledged by ${esc(a.ack_by)}</div>` : (S.user.features || []).includes("alerts_ack") ? `<button class="ghost" data-ack="${esc(a.id)}">Acknowledge</button>` : ""}</div>`).join("") || '<p class="muted">No alerts.</p>';
  $$("[data-ack]").forEach((b) => b.onclick = () => api(`/api/alerts/${b.dataset.ack}/ack`, { method: "POST" }).then(loadAlerts));
}
$("#lookup-form").onsubmit = async (ev) => {
  ev.preventDefault(); const p = ev.target.plate.value.trim().toUpperCase().replace(/\s+/g, "");
  $("#lookup").innerHTML = '<p class="muted">Searching…</p>';
  try {
    const [r, reg] = await Promise.all([api(`/api/events?plate=${encodeURIComponent(p)}&limit=20`), api(`/api/vehicles/${encodeURIComponent(p)}/registration`).catch(() => null)]);
    const regHtml = reg ? `<div class="card"><b>Registration</b><div class="small">${Object.entries(reg.registration).filter(([k]) => k !== "note").map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div></div>` : "";
    $("#lookup").innerHTML = regHtml + (r.events.map((e) => `<div class="card"><div class="row"><span class="plate">${esc(e.plate)}</span><span class="small muted">${esc(fmt(e.ts))}</span></div>
      <div class="small">${esc(e.camera_id)} · ${esc(e.department)} · ${[e.vehicle_colour, (e.vehicle_type || "").replace(/_/g, " ")].filter(Boolean).map(esc).join(" ")}</div>
      <div class="small">${(e.tags || []).filter((t) => !/^(type|colour|plate):/.test(t)).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      ${e.crop_url ? `<img class="snap" src="${esc(tok(e.crop_url))}" alt="">` : ""}</div>`).join("") || '<p class="muted">No sightings.</p>');
  } catch (e) { $("#lookup").innerHTML = `<p class="error">${esc(e.message)}</p>`; }
};
async function loadIncidents() {
  const rows = await api("/api/incidents?limit=50");
  $("#incidents").innerHTML = rows.map((i) => `<div class="card ${esc(i.priority)}"><div class="row"><b>${esc(i.label)}</b><span class="small muted">${esc(fmt(i.ts))}</span></div>
    <div class="small">${esc(i.camera_id)} · ${esc(i.zone)}${i.plate ? ` · <span class="plate">${esc(i.plate)}</span>` : ""}</div>${i.snapshot_url ? `<img class="snap" src="${esc(tok(i.snapshot_url))}" alt="">` : ""}
    ${i.ack_by ? `<div class="small ok">seen by ${esc(i.ack_by)}</div>` : (S.user.features || []).includes("alerts_ack") ? `<button class="ghost" data-iack="${esc(i.id)}">Acknowledge</button>` : ""}</div>`).join("") || '<p class="muted">No incidents.</p>';
  $$("[data-iack]").forEach((b) => b.onclick = () => api(`/api/incidents/${b.dataset.iack}/ack`, { method: "POST" }).then(loadIncidents));
}
async function loadCases() {
  if (!(S.user.features || []).includes("cases")) return $("#cases").innerHTML = '<p class="muted">Your role has no case access.</p>';
  const rows = await api("/api/cases?mine=true");
  $("#cases").innerHTML = rows.map((c) => `<div class="card"><div class="row"><b>${esc(c.number)}</b><span class="chip">${esc(c.status)}</span></div><div>${esc(c.title)}</div><div class="small muted">${esc(c.reference)} · ${c.items} items · ${esc(fmt(c.updated_at))}</div></div>`).join("") || '<p class="muted">No cases assigned to you.</p>';
}
function connectWs() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/alerts?token=${encodeURIComponent(S.token)}`);
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.type === "alert" || msg.type === "incident") { if (navigator.vibrate) navigator.vibrate(200); loadAlerts(); } };
  ws.onclose = () => setTimeout(connectWs, 5000);
  setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/m/sw.js").catch(() => {});
(function boot() {
  try { const s = JSON.parse(localStorage.getItem("uvp-field")); if (s && s.token) { S.token = s.token; S.user = s.user; return start(); } } catch (_) {}
})();
