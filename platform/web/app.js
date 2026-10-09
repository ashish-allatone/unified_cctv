/* Unified CCTV Viewer — operator console (no build step, no external CDN). */
"use strict";

const S = { token: null, user: null, cfg: null, cameras: [], camById: {}, grid: "2x2", tiles: [], ws: null,
            alertsOpen: 0, lastResults: [], caseSel: null };
const RANK = { viewer: 0, analyst: 1, supervisor: 2, admin: 3 };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IST = { timeZone: "Asia/Kolkata", hour12: false };
const fmtTime = (iso) => new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const withTok = (u) => u ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(S.token)}` : "";
const roleRank = (u) => { if (!u) return -1; if (u.role in RANK) return RANK[u.role]; const f = u.features || [];
  return f.includes("admin") ? 3 : (f.includes("export") || f.includes("watchlist") || f.includes("alerts_ack")) ? 2 : (f.includes("search") || f.includes("playback")) ? 1 : 0; };
const can = (role) => S.user && roleRank(S.user) >= RANK[role];
// Attach a handler only if the element exists: a stale cached index.html must never stop the whole script.
function bind(sel, ev, fn) { const el = $(sel); if (el) el[ev] = fn; else console.warn("missing element", sel, "(hard-refresh the page: Ctrl+Shift+R)"); }
// ------------------------------------------------------------------ i18n (en / hi); strings in /i18n/<lang>.json
const I18N = { lang: "en", dict: {} };
const t = (k, fallback) => I18N.dict[k] || fallback || k;
async function setLang(lang) {
  try { I18N.dict = await fetch(`i18n/${lang}.json`).then((r) => r.json()); I18N.lang = lang; } catch (_) { I18N.dict = {}; I18N.lang = "en"; }
  try { localStorage.setItem("uvp-lang", I18N.lang); } catch (_) {}
  document.documentElement.lang = I18N.lang;
  $$("[data-i18n]").forEach((el) => { const v = I18N.dict[el.dataset.i18n]; if (v) el.textContent = v; });
  $$("[data-i18n-placeholder]").forEach((el) => { const v = I18N.dict[el.dataset.i18nPlaceholder]; if (v) el.placeholder = v; });
}
const has = (feature) => !!(S.user && (S.user.features || []).includes(feature));
// per-camera permission (Admin -> Permissions): cameras list each one's perms; a camera without the list allows everything the role does
const camAllows = (camId, perm) => { const c = S.camById && S.camById[camId]; return !c || !Array.isArray(c.perms) || c.perms.includes(perm); };
const setSession = (j) => { S.token = j.token; S.user = j.user; sessionStorage.setItem("uvp", JSON.stringify({ token: S.token, user: S.user })); };

// Embedded mode: the React shell (platform/web-react) shows a legacy page inside an iframe at /legacy/?embed=1#view=<name>.
// The sidebar / topbar are hidden, the view fills the frame, and view changes are mirrored to the parent.
const EMBED = new URLSearchParams(location.search).get("embed") === "1";
if (EMBED) document.documentElement.classList.add("embedded");
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "uvp:show") return;
  if (e.data.sec) { try { localStorage.setItem("uvp-admin-sec", e.data.sec); } catch (_) {} ADMIN_SEC = e.data.sec; }
  if (S.user && typeof show === "function" && $(`#tabs button[data-view="${e.data.view}"]`)) show(e.data.view);
});

let API_DOWN_TOAST = 0;
async function api(path, opts = {}) {
  let r;
  const req = () => fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}`, ...(opts.headers || {}) } });
  try {
    try { r = await req(); }
    catch (e1) { if (opts.method && opts.method !== "GET") throw e1; await new Promise((ok) => setTimeout(ok, 400)); r = await req(); }   // one quick retry for reads: a dropped connection is not "the server is down"
  } catch (e) {
    // "Failed to fetch" = no answer at all: your network to the server dropped, or the API container is restarting
    if (Date.now() - API_DOWN_TOAST > 8000) { API_DOWN_TOAST = Date.now(); toast(`Cannot reach the API server at ${location.host} (your network, or the api container restarting). Reconnecting automatically…`, "err"); }
    watchServer();
    throw new Error(`API server ${location.host} unreachable while loading ${path.split("?")[0]} (${e.message || "network error"}) — check: docker compose ps api · docker compose logs api --tail 50`);
  }
  if (r.status === 401) { logout(); throw new Error("session expired"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

// ------------------------------------------------------------------ login (password -> optional MFA step -> session)
let MFA = { token: null };
async function post(path, body, tok) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}
async function login(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  $("#login-error").textContent = "";
  try {
    const j = await post("/api/auth/login", { username: f.get("username"), password: f.get("password") });
    if (j.mfa_required) { MFA.token = j.mfa_token; return j.enrol ? showEnrol(j.mfa_token) : showStep2(); }
    setSession(j);
    if (j.mfa_enrol_required) toast(`Two-factor sign-in is required for your role: ${j.grace_left} sign-ins left before it is enforced. Use the 2FA button.`, "warn");
    start();
  } catch (e) { $("#login-error").textContent = e.message; }
}
function showStep2() { $("#login-step1").classList.add("hidden"); $("#login-step2").classList.remove("hidden"); $("#login-form").code.focus(); }
// First run: no account exists yet -> the sign-up card creates the super admin, then sign-up closes for good.
function showSetup(rules) {
  $("#login-step1").classList.add("hidden"); $("#login-setup").classList.remove("hidden");
  $("#setup-rules").textContent = `Password: ${rules || "at least 10 characters, one uppercase letter, one digit"}`;
  $("#login-form").su_username.focus();
}
async function signup() {
  const f = $("#login-form");
  $("#login-error").textContent = "";
  if (f.su_password.value !== f.su_password2.value) { $("#login-error").textContent = "passwords do not match"; return; }
  try {
    const j = await post("/api/auth/signup", { username: f.su_username.value.trim(), password: f.su_password.value });
    setSession(j);
    await start();
    toast("Super admin created. Sign-up is now closed; add users from the Admin tab.", "ok");
    if (j.mfa_setup_recommended) { setTimeout(() => mfaSetupFromApp().catch(() => {}), 800); }
  } catch (e) { $("#login-error").textContent = e.message; }
}
async function showEnrol(tok) {
  const e = await post("/api/auth/mfa/enrol", {}, tok);
  $("#login-step1").classList.add("hidden"); $("#login-enrol").classList.remove("hidden");
  $("#mfa-qr").src = e.qr; $("#mfa-secret").textContent = e.secret;
}
async function mfaVerify() {
  $("#login-error").textContent = "";
  try { const j = await post("/api/auth/mfa/verify", { mfa_token: MFA.token, code: $("#login-form").code.value }); setSession(j); start(); }
  catch (e) { $("#login-error").textContent = e.message; }
}
async function mfaConfirm(tok) {
  $("#login-error").textContent = "";
  try {
    const j = await post("/api/auth/mfa/confirm", { code: $("#login-form").enrol_code.value }, tok || MFA.token);
    setSession(j);
    modal(`<h3>Two-factor sign-in enabled</h3><p>Backup codes (each works once; keep them safe):</p><pre>${esc(j.backup_codes.join("\n"))}</pre>`);
    start();
  } catch (e) { $("#login-error").textContent = e.message; toast(e.message, "err"); }
}
async function mfaSetupFromApp() {
  const e = await post("/api/auth/mfa/enrol", {}, S.token);
  modal(`<h3>Enable two-factor sign-in</h3><p class="muted">Scan with Google/Microsoft Authenticator, then enter the code.</p>
    <img src="${e.qr}" alt="QR" style="width:180px;height:180px;background:#fff;border-radius:8px"><p class="small muted">Manual key: <code>${esc(e.secret)}</code></p>
    <form id="mfa-app-form" class="search-form"><label>Code <input name="code" inputmode="numeric" required></label><button class="btn primary">Activate</button></form>`);
  $("#mfa-app-form").onsubmit = async (ev) => { ev.preventDefault();
    try { const j = await post("/api/auth/mfa/confirm", { code: ev.target.code.value }, S.token); setSession(j);
      modal(`<h3>Two-factor sign-in enabled</h3><p>Backup codes (each works once):</p><pre>${esc(j.backup_codes.join("\n"))}</pre>`); refreshMfaButton(); }
    catch (e) { toast(e.message, "err"); } };
}
// header button: "2FA" (enrol) or "2FA on" (turn off with a current code, unless the role requires it)
async function refreshMfaButton() {
  const btn = $("#mfa-setup");
  if (!btn) return;
  if (S.user.provider === "oidc") { btn.classList.add("hidden"); return; }
  const st = await api("/api/auth/mfa/status").catch(() => null);
  if (!st) { btn.classList.toggle("hidden", !!S.user.mfa); return; }
  btn.classList.remove("hidden");
  if (st.state === "enrolled") {
    btn.textContent = "2FA on"; btn.title = st.required ? "Two-factor sign-in is required for your role" : "Two-factor sign-in is on · click to turn off";
    btn.onclick = () => mfaDisableFromApp(st);
  } else {
    btn.textContent = st.required ? "Set up 2FA (required)" : "2FA"; btn.title = "Enable two-factor sign-in";
    btn.onclick = mfaSetupFromApp;
  }
}
async function mfaDisableFromApp(st) {
  if (st.required) { toast("Two-factor sign-in is required for your role and cannot be turned off.", "warn"); return; }
  const code = prompt("Turn off two-factor sign-in: enter the current 6-digit code from your authenticator app");
  if (!code) return;
  try { const j = await post("/api/auth/mfa/disable", { code }, S.token); setSession(j); toast("Two-factor sign-in turned off", "ok"); await refreshMfaButton(); $("#user-name").textContent = `${S.user.username} · ${S.user.role}`; }
  catch (e) { toast(e.message, "err"); }
}
function logout() {
  sessionStorage.removeItem("uvp");
  S.tiles.forEach(stopTile);
  if (EMBED) { try { parent.postMessage({ type: "uvp:logout" }, location.origin); } catch (_) {} }
  location.reload();
}

async function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  try { const me = await api("/api/auth/me"); S.user = { ...S.user, ...me }; sessionStorage.setItem("uvp", JSON.stringify({ token: S.token, user: S.user })); } catch (_) {}
  $("#user-name").textContent = `${S.user.username} · ${S.user.role}${S.user.mfa ? " · 2FA" : ""}${S.user.tenant ? " · " + S.user.tenant : ""}`;
  licenseBanner();
  if (S.user.branding && S.user.branding.title) { $(".brand").lastChild.textContent = S.user.branding.title; document.title = S.user.branding.title; }
  if (S.user.branding && S.user.branding.accent) document.documentElement.style.setProperty("--accent", S.user.branding.accent);
  $$("[data-role]").forEach((el) => { if (!can(el.dataset.role)) el.classList.add("hidden"); });
  $$("[data-feature]").forEach((el) => el.classList.toggle("hidden", !has(el.dataset.feature)));
  S.cfg = await api("/api/config");
  const prov = await fetch("/api/auth/providers").then((r) => r.json()).catch(() => ({}));
  $("#break-glass").classList.toggle("hidden", true);    // break-glass access is disabled in this deployment (kept in the code behind this flag)
  await refreshMfaButton();
  renderBreakGlassBanner();
  await loadCameras();
  loadDetection();
  buildWall(S.grid);
  restoreWall();
  loadLayouts();
  loadRoutes();
  connectWs();
  refreshAlertBadge();
  refreshInbox();
  setInterval(loadCameras, 15000);
  setInterval(refreshInbox, 30000);
  setInterval(refreshAccess, 60000);
  let last = "overview";
  try { last = localStorage.getItem("uvp-view") || "overview"; } catch (_) {}
  const hp = new URLSearchParams(location.hash.slice(1));                              // /legacy/?embed=1#view=admin&sec=holds
  const wanted = hp.get("view");
  if (wanted && $(`#tabs button[data-view="${wanted}"]`)) last = wanted;
  if (hp.get("sec")) { ADMIN_SEC = hp.get("sec"); try { localStorage.setItem("uvp-admin-sec", ADMIN_SEC); } catch (_) {} }
  if (!$(`#tabs button[data-view="${last}"]`) || $(`#tabs button[data-view="${last}"]`).classList.contains("hidden")) last = "wall";
  show(last);
}


// ------------------------------------------------------------------ registry (centralised CCTV inventory)
const REG_FIELDS = [
  ["name", "Name", "text", true], ["department", "Department", "text", true], ["camera_type", "Camera type", ["", "fixed", "dome", "bullet", "ptz", "anpr", "thermal", "other"]],
  ["make_model", "Make / model", "text"], ["resolution", "Resolution", "text"], ["lat", "Latitude", "number"], ["lon", "Longitude", "number"],
  ["heading", "Heading (° from N)", "number"], ["fov", "Field of view (°)", "number"], ["range_m", "Useful range (m)", "number"],
  ["ownership", "Ownership", ["", "department", "vendor-managed", "leased", "private-shared", "other"]], ["owner_contact", "Owner contact", "text"],
  ["connectivity", "Connectivity", ["", "fibre", "lan", "4g", "wifi", "offline-dvr", "none"]], ["storage_type", "Storage", ["", "nvr", "dvr", "cloud", "edge", "none"]],
  ["storage_days", "Retention (days)", "number"], ["install_date", "Installed", "date"], ["warranty_until", "Warranty until", "date"],
  ["maintenance_status", "Maintenance", ["", "ok", "due", "under_repair", "faulty", "decommissioned", "planned"]], ["last_maintenance", "Last maintenance", "date"],
  ["address", "Address", "text"], ["zone", "Zone", "text"], ["ward", "Ward", "text"], ["pole_id", "Pole / mount id", "text"], ["tags", "Tags (; separated)", "text"], ["notes", "Notes", "text"]];
let REG_ROWS = [];
async function loadRegistry() {
  const f = $("#reg-filter"), qs = new URLSearchParams();
  ["q", "department", "camera_type", "status", "connectivity", "ownership", "maintenance", "integrated"].forEach((k) => { if (f[k].value) qs.set(k, f[k].value); });
  const [rows, st] = await Promise.all([api(`/api/registry?${qs}`), api("/api/registry/stats")]);
  REG_ROWS = rows;
  const sel = f.department;
  if (sel.options.length <= 1) Object.keys(st.by_department).sort().forEach((d) => sel.add(new Option(d, d)));
  const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  $("#reg-kpis").innerHTML = [
    kpi("Cameras registered", st.total), kpi("Integrated (live feed)", st.integrated, "ok"), kpi("Registry only", st.registry_only),
    kpi("Offline now", st.health.offline || 0, st.health.offline ? "bad" : "ok"), kpi("Maintenance due / faulty", st.maintenance_due, st.maintenance_due ? "warn" : "ok"),
    kpi("Ageing (≥ 5 y) / warranty expired", `${st.ageing} / ${st.warranty_expired}`, st.ageing ? "warn" : ""), kpi("Geolocated", `${st.geolocated} / ${st.total}`, st.geolocated === st.total ? "ok" : "warn"),
    kpi("Metadata incomplete", st.missing_metadata, st.missing_metadata ? "warn" : "ok")].join("");
  $("#reg-count").textContent = `${rows.length} camera${rows.length === 1 ? "" : "s"} match`;
  const chip = (h) => `<span class="${h === "online" ? "ok-chip" : h === "offline" ? "bad-chip" : "tagchip"}">${esc(h)}</span>`;
  $("#reg-table tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
    <td class="mono small">${esc(r.id)}</td><td><b>${esc(r.name)}</b>${r.address ? `<div class="muted small">${esc(r.address)}</div>` : ""}</td><td>${esc(r.department)}</td>
    <td>${esc(r.camera_type || "–")}${r.anpr_enabled ? ' <span class="tagchip">ANPR</span>' : ""}</td><td>${chip(r.health)}</td>
    <td>${esc(r.connectivity || "–")}</td><td>${esc(r.storage_type || "–")}${r.storage_days != null ? ` · ${r.storage_days} d` : ""}</td>
    <td>${esc(r.install_date || "–")}${r.age_years != null ? `<div class="muted small">${r.age_years} y${r.warranty_expired ? " · warranty expired" : ""}</div>` : ""}</td>
    <td>${r.maintenance_status && r.maintenance_status !== "ok" ? `<span class="bad-chip">${esc(r.maintenance_status)}</span>` : esc(r.maintenance_status || "–")}</td>
    <td class="small">${r.lat != null ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : '<span class="muted">not geolocated</span>'}</td>
    <td style="white-space:nowrap"><button class="btn small" data-reg-edit="${esc(r.id)}">${has("registry_edit") ? "Edit" : "View"}</button> <button class="btn small ghost" data-reg-hist="${esc(r.id)}">History</button>${has("registry_edit") && r.registry_only ? ` <button class="btn small danger" data-reg-del="${esc(r.id)}">Delete</button>` : ""}</td></tr>`).join("")
    : '<tr><td colspan="11" class="muted">No cameras match.</td></tr>';
  $$("#reg-table [data-reg-edit]").forEach((b) => b.onclick = () => regEdit(b.dataset.regEdit));
  $$("#reg-table [data-reg-hist]").forEach((b) => b.onclick = () => regHistory(b.dataset.regHist));
  $$("#reg-table [data-reg-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove ${b.dataset.regDel} from the registry?`)) return;
    await api(`/api/registry/${b.dataset.regDel}`, { method: "DELETE" }); toast("removed", "ok"); loadRegistry();
  });
}
function regForm(r = {}) {
  const ro = !has("registry_edit");
  return REG_FIELDS.map(([k, label, type, req]) => {
    const v = k === "tags" ? (r.tags || []).join("; ") : (r[k] ?? "");
    const inp = Array.isArray(type)
      ? `<select name="${k}" ${ro ? "disabled" : ""}>${type.map((o) => `<option value="${o}" ${String(v) === o ? "selected" : ""}>${o || "–"}</option>`).join("")}</select>`
      : `<input name="${k}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${esc(v)}" ${req ? "required" : ""} ${ro ? "readonly" : ""}>`;
    return `<label>${label} ${inp}</label>`;
  }).join("");
}
function regRead(f) {
  const body = {};
  REG_FIELDS.forEach(([k, , type]) => {
    let v = f[k].value;
    if (type === "number") v = v === "" ? null : Number(v);
    else if (k === "tags") v = v.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    body[k] = v;
  });
  return body;
}
window.regEdit = async (id) => {
  const r = id ? REG_ROWS.find((x) => x.id === id) || await api(`/api/registry/${id}`) : {};
  modal(`<h3>${id ? `${esc(r.name)} <span class="muted small mono">${esc(id)}</span>` : "Add camera to the registry"}</h3>
    ${id && !r.registry_only ? '<p class="muted small">This camera is fed by a departmental source: its stream comes from sources.yaml, everything else is editable here.</p>' : ""}
    <form id="reg-form" class="search-form" style="max-height:60vh;overflow:auto">${regForm(r)}
    ${has("registry_edit") ? '<div style="width:100%"><button class="btn small ghost" type="button" id="reg-find">Find on map by name</button> <span class="muted small" id="reg-find-note"></span></div>' : ""}
    ${has("registry_edit") ? `<div style="width:100%;display:flex;gap:8px;justify-content:flex-end"><button class="btn primary">${id ? "Save changes" : "Add camera"}</button></div>` : ""}</form>`);
  const f = $("#reg-form");
  if ($("#reg-find")) $("#reg-find").onclick = async () => {
    const q = f.name.value.trim(); if (!q) { toast("type the camera name first", "err"); return; }
    $("#reg-find-note").textContent = "searching…";
    try { const r = await api("/api/registry/geocode", { method: "POST", body: JSON.stringify({ query: q }) });
      const c = r.candidates.filter((x) => x.lat != null);
      if (!c.length) { $("#reg-find-note").textContent = "not found — try a shorter name or add the city (e.g. 'Paldi Circle, Ahmedabad')"; return; }
      $("#reg-find-note").innerHTML = c.map((x, i) => `<a href="#" data-i="${i}">${esc(x.label)}</a>`).join(" · ");
      $$("#reg-find-note a").forEach((a) => a.onclick = (ev) => { ev.preventDefault(); const x = c[+a.dataset.i]; f.lat.value = x.lat.toFixed(6); f.lon.value = x.lon.toFixed(6); $("#reg-find-note").textContent = `set to ${esc(x.label)} — Save to keep`; });
    } catch (e) { $("#reg-find-note").textContent = e.message; }
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = regRead(f);
      if (id) await api(`/api/registry/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/api/registry", { method: "POST", body: JSON.stringify(body) });
      closeModal(); toast(id ? "saved" : "camera added to the registry", "ok"); loadRegistry();
    } catch (e) { toast(e.message, "err"); }
  };
};
async function regHistory(id) {
  const h = await api(`/api/registry/${id}/history`);
  modal(`<h3>History · ${esc(h.camera.name)} <span class="muted small mono">${esc(id)}</span></h3>
    <p class="muted small">Created ${esc(h.camera.created_at ? fmtTime(h.camera.created_at) : "with the source config")} by ${esc(h.camera.created_by || "adapter")} · last change ${esc(h.camera.updated_at ? fmtTime(h.camera.updated_at) : "–")} by ${esc(h.camera.updated_by || "–")}</p>
    <h4>Metadata changes (audit trail)</h4>
    <table class="table"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>${h.changes.length ? h.changes.map((c) => `<tr><td>${esc(fmtTime(c.ts))}</td><td>${esc(c.user)}</td><td>${esc(c.action)}</td><td class="small">${esc(c.detail)}</td></tr>`).join("") : '<tr><td colspan="4" class="muted">no changes recorded</td></tr>'}</tbody></table>
    <h4 style="margin-top:12px">Health transitions</h4>
    <table class="table"><thead><tr><th>When</th><th>Status</th><th>Detail</th></tr></thead><tbody>${h.status.length ? h.status.slice(0, 40).map((x) => `<tr><td>${esc(fmtTime(x.ts))}</td><td>${esc(x.status)}</td><td class="small">${esc(x.detail)}</td></tr>`).join("") : '<tr><td colspan="3" class="muted">no transitions (not integrated, or always up)</td></tr>'}</tbody></table>`);
}
function regImport() {
  modal(`<h3>Bulk import from CSV</h3>
    <p class="muted small">Columns as in the <a href="#" id="reg-tpl-link">template</a>: <code>id</code> (optional, otherwise generated from department + name), <code>name</code>, <code>department</code>, <code>lat</code>, <code>lon</code>, <code>heading</code>, <code>fov</code>, <code>range_m</code>, <code>camera_type</code>, <code>make_model</code>, <code>resolution</code>, <code>ownership</code>, <code>owner_contact</code>, <code>connectivity</code>, <code>storage_type</code>, <code>storage_days</code>, <code>install_date</code>, <code>warranty_until</code>, <code>maintenance_status</code>, <code>last_maintenance</code>, <code>address</code>, <code>zone</code>, <code>ward</code>, <code>pole_id</code>, <code>tags</code>, <code>notes</code>. Unknown columns are kept as extra metadata. Existing ids are updated, new ones created. The file is checked first; nothing is written while any row has an error.</p>
    <form id="reg-import-form" class="search-form"><label>CSV file <input name="file" type="file" accept=".csv,text/csv" required></label><button class="btn">Check file</button><button class="btn primary hidden" id="reg-import-apply" type="button">Import</button><span class="muted small" id="reg-import-note"></span></form>
    <div id="reg-import-result"></div>`);
  $("#reg-tpl-link").onclick = (e) => { e.preventDefault(); window.open(withTok("/api/registry/template.csv")); };
  const f = $("#reg-import-form"), out = $("#reg-import-result"), note = $("#reg-import-note");
  const send = async (apply) => {
    const fd = new FormData(); fd.append("file", f.file.files[0]);
    const r = await fetch(`/api/registry/import?apply=${apply}`, { method: "POST", headers: { Authorization: `Bearer ${S.token}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || r.statusText);
    return j;
  };
  const render = (j) => {
    note.textContent = j.apply ? `${j.created} created · ${j.updated} updated · ${j.unchanged} unchanged · ${j.errors.length} rejected` : `${j.rows} rows · ${j.valid} valid · ${j.errors.length} with errors`;
    out.innerHTML = (j.errors.length ? `<h4 style="margin-top:10px">Rows with errors</h4><table class="table"><thead><tr><th>Row</th><th>ID</th><th>Problem</th></tr></thead><tbody>${j.errors.map((e) => `<tr><td>${e.row}</td><td class="mono small">${esc(e.id)}</td><td class="small">${esc(e.errors.join("; "))}</td></tr>`).join("")}</tbody></table>` : "")
      + (!j.apply && j.preview.length ? `<h4 style="margin-top:10px">Preview (first ${j.preview.length})</h4><table class="table"><thead><tr><th>Row</th><th>ID</th><th>Name</th><th>Department</th><th>Type</th><th>Location</th></tr></thead><tbody>${j.preview.map((p) => `<tr><td>${p.row}</td><td class="mono small">${esc(p.id)}</td><td>${esc(p.name)}</td><td>${esc(p.department)}</td><td>${esc(p.camera_type || "–")}</td><td class="small">${p.lat != null ? `${p.lat}, ${p.lon}` : "–"}</td></tr>`).join("")}</tbody></table>` : "")
      + (j.note ? `<p class="bad-chip">${esc(j.note)}</p>` : "");
    $("#reg-import-apply").classList.toggle("hidden", j.apply || j.errors.length > 0 || !j.valid);
  };
  f.onsubmit = async (ev) => { ev.preventDefault(); try { render(await send(0)); } catch (e) { toast(e.message, "err"); } };
  $("#reg-import-apply").onclick = async () => { try { const j = await send(1); render(j); if (j.created + j.updated) { toast(`${j.created} created, ${j.updated} updated`, "ok"); loadRegistry(); } } catch (e) { toast(e.message, "err"); } };
}
function regGaps() {
  modal(`<h3>Gap-analysis report</h3><p class="muted small">Grid the area spanned by the cameras and list every cell no working camera covers (largest holes first), plus ageing, maintenance, offline and retention findings. Opens as a printable page; the map can overlay the uncovered cells (Map → “Uncovered zones”).</p>
    <form id="reg-gaps-form" class="search-form"><label>Grid cell (m) <input name="cell_m" type="number" value="100" min="50" max="5000"></label><label>Ageing threshold (years) <input name="age_years" type="number" value="5" min="1" max="30"></label><label>Retention policy (days) <input name="min_storage_days" type="number" value="30" min="1" max="3650"></label>
    <label>Department <select name="department"><option value="">all</option>${[...$("#reg-filter").department.options].slice(1).map((o) => `<option>${esc(o.value)}</option>`).join("")}</select></label>
    <button class="btn primary">Open report</button><button class="btn ghost" type="button" id="reg-gaps-csv">Uncovered cells CSV</button><button class="btn ghost" type="button" id="reg-gaps-map">Show on map</button></form>`);
  const f = $("#reg-gaps-form");
  const qs = () => new URLSearchParams({ cell_m: f.cell_m.value, age_years: f.age_years.value, min_storage_days: f.min_storage_days.value, department: f.department.value });
  f.onsubmit = (ev) => { ev.preventDefault(); window.open(withTok(`/api/registry/gaps?format=html&${qs()}`)); };
  $("#reg-gaps-csv").onclick = () => window.open(withTok(`/api/registry/gaps?format=csv&${qs()}`));
  $("#reg-gaps-map").onclick = () => { closeModal(); show("map"); setTimeout(() => { $("#map-gaps").checked = true; drawGaps(); }, 400); };
}

function regGeocode() {
  modal(`<h3>Locate cameras by name</h3>
    <p class="muted small">Looks each camera <b>without coordinates</b> up on OpenStreetMap (Nominatim) using its name — e.g. <i>Paldi Circle</i>, <i>Timbavadi gate, Junagadh</i> — and proposes a position. Review the proposals, then apply the ones that look right; you can always fine-tune lat/lon with <b>Edit</b>. About one camera per second.</p>
    <form id="reg-geo-form" class="search-form"><label>Cameras per run <input name="limit" type="number" min="1" max="25" value="10"></label><button class="btn">Find proposals</button><span class="muted small" id="reg-geo-note"></span></form>
    <div id="reg-geo-result"></div>`);
  const f = $("#reg-geo-form"), out = $("#reg-geo-result"), note = $("#reg-geo-note");
  f.onsubmit = async (ev) => {
    ev.preventDefault(); note.textContent = "looking up… (one camera per second)"; out.innerHTML = "";
    try {
      const r = await api("/api/registry/geocode", { method: "POST", body: JSON.stringify({ limit: +f.limit.value }) });
      note.textContent = `${r.rows.length} looked up · ${r.rows.filter((x) => x.best).length} found · ${r.remaining_without_coordinates} still without coordinates`;
      if (!r.rows.length) { out.innerHTML = '<p class="muted small">Every camera you can see already has coordinates.</p>'; return; }
      out.innerHTML = `<table class="table"><thead><tr><th><input type="checkbox" id="geo-all" checked></th><th>Camera</th><th>Searched for</th><th>Proposed place</th><th>Lat, lon</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr><td>${x.best ? `<input type="checkbox" class="geo-pick" data-id="${esc(x.id)}" checked>` : ""}</td><td><b>${esc(x.name)}</b><div class="muted small mono">${esc(x.id)}</div></td><td class="small">${esc(x.query)}</td>
          <td class="small">${x.best ? esc(x.best.label) : `<span class="bad-chip">${esc((x.candidates[0] || {}).error || "not found — set it with Edit")}</span>`}</td><td class="small mono">${x.best ? `${x.best.lat.toFixed(5)}, ${x.best.lon.toFixed(5)}` : "–"}</td></tr>`).join("")}</tbody></table>
        <div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary" id="geo-apply">Apply selected</button></div>`;
      $("#geo-all").onchange = (e) => $$(".geo-pick", out).forEach((c) => c.checked = e.target.checked);
      $("#geo-apply").onclick = async () => {
        const ids = $$(".geo-pick:checked", out).map((c) => c.dataset.id);
        if (!ids.length) return;
        try { const a = await api("/api/registry/geocode", { method: "POST", body: JSON.stringify({ ids, apply: true, limit: 25 }) });
          toast(`${a.applied} camera(s) placed on the map · ${a.remaining_without_coordinates} still without coordinates`, "ok"); closeModal(); loadRegistry(); if (MAP) MAP.data = null;
        } catch (e) { toast(e.message, "err"); }
      };
    } catch (e) { note.textContent = ""; toast(e.message, "err"); }
  };
}
function regApi() {
  modal(`<h3>Registry API</h3><p class="muted small">Same endpoints the console uses. Authenticate with a session token (<code>Authorization: Bearer …</code>) or a machine API key (<code>X-API-Key</code>, Admin → API keys, feature <code>registry_edit</code>). Full OpenAPI: <a href="/docs" target="_blank">/docs</a>.</p>
    <pre class="small" style="white-space:pre-wrap">GET    /api/registry?department=&camera_type=&status=&connectivity=&ownership=&maintenance=&zone=&integrated=yes|no&q=
GET    /api/registry/{id}                 one camera
POST   /api/registry                      onboard one camera (JSON body: name, department, lat, lon, camera_type, ownership, …)
PATCH  /api/registry/{id}                 change any metadata fields
DELETE /api/registry/{id}                 registry-only cameras
GET    /api/registry/{id}/history         audit trail + health transitions
POST   /api/registry/import?apply=0|1     multipart CSV (dry run, then apply)
GET    /api/registry/template.csv         import template
GET    /api/registry/export.csv?…filters  filtered export (audited)
GET    /api/registry/stats                counts by department / type / health / connectivity / ownership, ageing, maintenance
GET    /api/registry/gaps?format=json|csv|html&cell_m=100&age_years=5&min_storage_days=30&department=

curl -s -X POST http://HOST:8000/api/registry -H "X-API-Key: $KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Paldi cross roads","department":"Municipal","lat":23.0117,"lon":72.5606,"camera_type":"bullet","ownership":"department","connectivity":"fibre","storage_type":"nvr","storage_days":30,"install_date":"2019-06-01"}'</pre>`);
}


// ------------------------------------------------------------------ connect a device (Sources tab)
let DEV_TYPES = null;
async function loadDevices() {
  if (!$("#dev-table")) return;
  let rows = [];
  try { rows = await api("/api/devices"); } catch (_) { return; }
  $("#dev-table tbody").innerHTML = rows.length ? rows.map((d) => `<tr><td class="mono small">${esc(d.id)}</td><td><b>${esc(d.name)}</b></td><td>${esc(d.department)}</td>
    <td>${esc(d.config.vendor || d.adapter)}</td><td class="small">${esc(d.config.host || (d.config.streams || [])[0]?.main || "")}</td><td>${d.cameras} / ${d.channels}</td>
    <td>${d.status === "ok" ? '<span class="ok-chip">ok</span>' : d.status === "error" ? `<span class="bad-chip" title="${esc(d.status_detail)}">error</span>` : '<span class="muted">connecting…</span>'}${d.status_detail && d.status !== "ok" ? `<div class="muted small">${esc(d.status_detail.slice(0, 90))}</div>` : ""}</td>
    <td style="white-space:nowrap">${has("admin") ? `${d.adapter === "push" ? `<button class="btn small primary" data-dev-bundle="${esc(d.id)}" title="docker-compose bundle to run at the site">Site connector</button> ` : ""}<button class="btn small" data-dev-edit="${esc(d.id)}">Edit</button> <button class="btn small danger" data-dev-del="${esc(d.id)}">Disconnect</button>` : ""}</td></tr>`).join("")
    : '<tr><td colspan="8" class="muted">No devices connected from the console yet — click <b>Connect a device</b>.</td></tr>';
  $$("#dev-table [data-dev-edit]").forEach((b) => b.onclick = () => connectDevice(rows.find((x) => x.id === b.dataset.devEdit)));
  $$("#dev-table [data-dev-bundle]").forEach((b) => b.onclick = () => window.open(withTok(`/api/devices/${b.dataset.devBundle}/site-connector.zip`)));
  $$("#dev-table [data-dev-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Disconnect ${b.dataset.devDel}? Its cameras leave the wall and the registry.`)) return;
    const r = await api(`/api/devices/${b.dataset.devDel}`, { method: "DELETE" }); toast(`disconnected, ${r.cameras_removed} camera(s) removed`, "ok"); loadDevices(); loadCameras();
  });
}
async function connectDevice(existing = null) {
  try { DEV_TYPES ||= await api("/api/devices/types"); } catch (e) { toast(e.message, "err"); return; }
  const c = existing?.config || {};
  const kind = existing ? (c.adapter === "push" ? "push" : c.streams ? "camera" : c.vendor ? "nvr" : c.adapter === "onvif" ? "onvif" : "template") : "nvr";
  const site = c.site || {};
  const vendors = Object.entries(DEV_TYPES.vendors);
  modal(`<h3>${existing ? `Edit device · ${esc(existing.name)}` : "Connect a device"}</h3>
    <p class="muted small">Give the platform a <b>read-only</b> account on the device. Credentials are stored encrypted and never shown again; the relay pulls each stream once, however many people watch.</p>
    <form id="dev-form" class="search-form">
      <label>Device type <select name="type" ${existing ? "disabled" : ""}>${Object.entries(DEV_TYPES.types).map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <span class="muted small" id="dev-help" style="flex-basis:100%"></span>
      <label>Name <input name="name" required value="${esc(existing?.name || "")}" placeholder="e.g. Sola police station NVR"></label>
      <label>Department <input name="department" required value="${esc(existing?.department || "")}" placeholder="Police / Municipal / Transport…"></label>
      <label data-for="nvr push">Vendor <select name="vendor">${vendors.map(([k, v]) => `<option value="${k}" ${k === (c.vendor || site.vendor) ? "selected" : ""}>${k}${v.adapter === "onvif" ? " (ONVIF)" : ""}</option>`).join("")}</select></label>
      <label data-for="nvr template onvif">Host / IP <input name="host" value="${esc(c.host || "")}" placeholder="10.20.30.40 or nvr.police.gov.in"></label>
      <label data-for="push">Recorder LAN IP at the site <input name="host" value="${esc(site.host || "")}" placeholder="192.168.1.108 (as seen from the connector box)"></label>
      <label data-for="nvr template push">RTSP port <input name="rtsp_port" type="number" value="${c.rtsp_port || site.rtsp_port || 554}"></label>
      <label data-for="onvif">ONVIF port <input name="onvif_port" type="number" value="${c.onvif_port || 80}"></label>
      <label data-for="template" style="flex-basis:100%">Main stream template <input name="main_template" value="${esc(c.main || "")}" placeholder="rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}"></label>
      <label data-for="template" style="flex-basis:100%">Sub stream template (optional) <input name="sub_template" value="${esc(c.sub || "")}" placeholder="leave blank if the device has one stream per channel"></label>
      <label data-for="camera" style="flex-basis:100%">Main stream URL <input name="main_url" value="${esc((c.streams || [])[0]?.main || "")}" placeholder="rtsp://10.0.0.9:554/Streaming/Channels/101 (no user:pass in the URL)"></label>
      <label data-for="camera" style="flex-basis:100%">Sub stream URL (optional) <input name="sub_url" value="${esc((c.streams || [])[0]?.sub || "")}"></label>
      <label data-for="camera">Latitude <input name="lat" type="number" step="any" value="${(c.streams || [])[0]?.lat ?? ""}"></label>
      <label data-for="camera">Longitude <input name="lon" type="number" step="any" value="${(c.streams || [])[0]?.lon ?? ""}"></label>
      <label data-for="nvr template push">Channels <input name="channels" type="number" min="1" max="512" value="${(c.channels || []).length || Object.keys(c.cameras || {}).length || 4}"></label>
      <label data-for="nvr template onvif camera">Username <input name="username" autocomplete="off" value="${esc(existing?.username || "")}" placeholder="read-only account"></label>
      <label data-for="nvr template onvif camera">Password <input name="password" type="password" autocomplete="new-password" placeholder="${existing ? "leave blank to keep" : ""}"></label>
      <span data-for="push" class="muted small" style="flex-basis:100%">The recorder's user / password are typed into the connector box at the site, never here. A publish key is generated for the site when you save; download the connector bundle from the device list.</span>
      <label class="check"><input type="checkbox" name="anpr" ${(c.channels || c.streams || []).some((x) => x.anpr) ? "checked" : ""}> ANPR on these cameras</label>
      <label>Record <select name="record"><option value="anpr" ${c.record === "anpr" ? "selected" : ""}>ANPR cameras only</option><option value="all" ${c.record === "all" ? "selected" : ""}>all cameras</option><option value="none" ${c.record === "none" ? "selected" : ""}>none</option></select></label>
      <label>Max streams pulled at once <input name="max_concurrent_pulls" type="number" min="1" value="${c.max_concurrent_pulls || ""}" placeholder="= channels"></label>
      <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="dev-test">Test connection</button><button class="btn primary" id="dev-save">${existing ? "Save changes" : "Save & connect"}</button><span class="small" id="dev-result"></span></div>
    </form>`);
  const f = $("#dev-form");
  const showFields = () => { const t = f.type.value; $("#dev-help").textContent = DEV_TYPES.types[t].help + (t === "nvr" && DEV_TYPES.vendors[f.vendor.value]?.notes ? ` ${DEV_TYPES.vendors[f.vendor.value].notes}` : "");
    $$("[data-for]", f).forEach((el) => el.classList.toggle("hidden", !el.dataset.for.split(" ").includes(t))); };
  f.type.onchange = f.vendor.onchange = showFields; showFields();
  const read = () => { const b = {}; [...f.elements].forEach((el) => { if (!el.name || el.closest("[data-for]")?.classList.contains("hidden")) return; b[el.name] = el.type === "checkbox" ? el.checked : el.value; });
    b.type = f.type.value; ["lat", "lon", "rtsp_port", "onvif_port", "channels", "max_concurrent_pulls"].forEach((k) => { b[k] = b[k] === "" ? null : Number(b[k]); }); return b; };
  $("#dev-test").onclick = async () => {
    if (f.type.value === "push") { $("#dev-result").innerHTML = '<span class="muted">nothing to test from here — the connector box at the site tests its recorder</span>'; return; }
    const out = $("#dev-result"); out.textContent = "testing… (up to 20 s)";
    try { const r = await api("/api/devices/test", { method: "POST", body: JSON.stringify(read()) });
      out.innerHTML = r.ok ? `<span class="ok-chip">stream OK</span> ${esc(r.codec)} ${esc(r.size || "")} ${r.note ? `· ${esc(r.note)}` : ""} · ${r.cameras} camera(s) will be added` : `<span class="bad-chip">${esc(r.error)}</span>`;
    } catch (e) { out.innerHTML = `<span class="bad-chip">${esc(e.message)}</span>`; }
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      if (existing) await api(`/api/devices/${existing.id}`, { method: "PATCH", body: JSON.stringify(read()) });
      else await api("/api/devices", { method: "POST", body: JSON.stringify(read()) });
      closeModal(); toast(existing ? "saved — the adapters re-sync within seconds" : "device saved — cameras appear on the wall and in the registry within ~15 s", "ok");
      loadDevices(); setTimeout(loadCameras, 12000); setTimeout(loadDevices, 15000);
    } catch (e) { toast(e.message, "err"); }
  };
}


// ------------------------------------------------------------------ counts (vehicles + people per camera)
let COUNTS_TIMER = null;
function spark(points, idx, colour, max) {
  if (!points.length) return "";
  const w = 120, h = 26, n = points.length, m = Math.max(1, max);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, n - 1)) * w},${h - (Math.min(p[idx], m) / m) * (h - 2) - 1}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle"><path d="${d}" fill="none" stroke="${colour}" stroke-width="1.6"/></svg>`;
}
async function loadCountsView() {
  if (!$("#counts-table")) return;
  clearTimeout(COUNTS_TIMER);
  const hours = $("#counts-hours").value;
  let live = { cameras: [], total: {} }, tl = { cameras: [] }, st = null;
  try { [live, tl, st] = await Promise.all([api("/api/counts"), api(`/api/counts/timeline?hours=${hours}`), api("/api/counts/status").catch(() => null)]); } catch (e) { toast(e.message, "err"); return; }
  if (st) {
    const ok = st.detecting_count > 0 && st.cameras_last_5min > 0;
    $("#counts-status").innerHTML = `<span class="${ok ? "ok-chip" : st.detecting_count ? "tagchip" : "bad-chip"}">${ok ? "counting" : st.detecting_count ? "starting" : "not counting"}</span>
      <span class="muted">${st.expected_count} camera${st.expected_count === 1 ? "" : "s"} selected · ${st.detecting_count} sending detections now · last per-minute row ${st.last_row_age_s == null ? "never" : st.last_row_age_s < 90 ? `${Math.round(st.last_row_age_s)} s ago` : `${Math.round(st.last_row_age_s / 60)} min ago`} · ${st.cameras_last_5min} camera${st.cameras_last_5min === 1 ? "" : "s"} with rows in the last 5 min</span>
      ${st.hint ? `<div class="bad-chip" style="margin-top:6px;white-space:normal">${esc(st.hint)}</div>` : ""}`;
  }
  const liveBy = Object.fromEntries((live.cameras || []).map((c) => [c.camera_id, c]));
  const tlBy = Object.fromEntries(tl.cameras.map((c) => [c.camera_id, c]));
  const ids = [...new Set([...Object.keys(liveBy), ...Object.keys(tlBy)])];
  const cams = ids.map((id) => ({ id, l: liveBy[id], t: tlBy[id], cam: S.camById?.[id] }))
    .filter((x) => !x.cam || !x.cam.registry_only)
    .map((x) => ({ ...x, name: x.l?.name || x.t?.name || x.cam?.name || x.id, dept: x.l?.department || x.t?.department || x.cam?.department || "",
      v: x.l && !x.l.stale ? x.l.vehicles : null, p: x.l && !x.l.stale ? x.l.persons : null, max: x.t?.crowd_max ?? tl.crowd_default ?? 25 }))
    .sort((a, b) => ((b.v ?? 0) + (b.p ?? 0)) - ((a.v ?? 0) + (a.p ?? 0)) || a.name.localeCompare(b.name));
  const crowded = cams.filter((x) => x.p != null && x.p > x.max), busy = cams.filter((x) => x.p != null && x.p > x.max * 0.7 && x.p <= x.max);
  const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  const totV = cams.reduce((n, x) => n + (x.v || 0), 0), totP = cams.reduce((n, x) => n + (x.p || 0), 0);
  $("#counts-kpis").innerHTML = [kpi("Vehicles in view now", totV), kpi("People in view now", totP), kpi("Cameras counting", cams.filter((x) => x.v != null).length + " / " + cams.length),
    kpi("Crowded now", crowded.length, crowded.length ? "bad" : "ok"), kpi("Busy (> 70 % of threshold)", busy.length, busy.length ? "warn" : ""),
    kpi(`Peak people (${hours} h)`, Math.max(0, ...cams.map((x) => x.t?.peak_persons || 0))), kpi(`Peak vehicles (${hours} h)`, Math.max(0, ...cams.map((x) => x.t?.peak_vehicles || 0)))].join("");
  const crowdChip = (x) => x.p == null ? '<span class="muted small">no signal</span>' : x.p > x.max ? `<span class="bad-chip">crowded ${x.p} / ${x.max}</span>` : x.p > x.max * 0.7 ? `<span class="tagchip" style="background:#f59e0b33">busy ${x.p} / ${x.max}</span>` : `<span class="ok-chip">normal ${x.p} / ${x.max}</span>`;
  $("#counts-table tbody").innerHTML = cams.length ? cams.map((x) => { const pts = x.t?.points || []; const mv = Math.max(1, ...pts.map((p) => p[1])), mp = Math.max(1, ...pts.map((p) => p[2]));
    return `<tr><td><b>${esc(x.name)}</b><div class="muted small mono">${esc(x.id)}</div></td><td>${esc(x.dept)}</td>
    <td><b>${x.v ?? "–"}</b></td><td><b>${x.p ?? "–"}</b></td><td>${crowdChip(x)}</td>
    <td>${x.t?.avg_vehicles ?? "–"}</td><td>${x.t?.peak_vehicles ?? "–"}</td><td>${x.t?.avg_persons ?? "–"}</td><td>${x.t?.peak_persons ?? "–"}</td>
    <td class="small">${x.t && (x.t.flow.a_to_b || x.t.flow.b_to_a) ? `${x.t.flow.a_to_b} → · ${x.t.flow.b_to_a} ←` : '<span class="muted">no line</span>'}</td>
    <td>${spark(pts, 1, "#06d6a0", mv)} ${spark(pts, 2, "#ef476f", mp)}</td></tr>`; }).join("")
    : '<tr><td colspan="11" class="muted">No counts yet — the analytics worker counts every pulled camera; rows appear about a minute after a camera comes online.</td></tr>';
  $("#counts-note").textContent = `Live = objects in the last detection (≤ 10 s). Per-minute averages and peaks come from the analytics worker (ANALYTICS_FPS frames/s). Crowd threshold: ${tl.crowd_default ?? 25} persons by default (CROWD_MAX_PERSONS), per camera under crowd.max_persons in config/analytics.yaml.`;
  if (S.view === "counts") COUNTS_TIMER = setTimeout(loadCountsView, 5000);
}


// ------------------------------------------------------------------ spoken alerts (browser text-to-speech, en / hi / gu)
const SPEAK = { on: false, voices: [] };
const SPEAK_LANG = { en: "en-IN", hi: "hi-IN", gu: "gu-IN" };
function speakVoice(lang) {
  const want = SPEAK_LANG[lang] || "en-IN", vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  return vs.find((v) => v.lang.replace("_", "-") === want) || vs.find((v) => v.lang.startsWith(want.slice(0, 2))) || null;
}
function speak(text, lang = I18N.lang) {
  if (!SPEAK.on || !window.speechSynthesis || !text) return;
  SPEAK.last = text;                                    // what was said last (tests / debugging)
  const u = new SpeechSynthesisUtterance(text);
  const v = speakVoice(lang) || speakVoice("en");
  if (v) u.voice = v;
  u.lang = v ? v.lang : SPEAK_LANG[lang] || "en-IN";
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function speakPlate(p) { return String(p || "").split("").join(" "); }   // "G J 0 1 A B 1 2 3 4" reads clearly in every language
function speakAlert(a) {
  const kind = a.match === "rule" ? t("speak.rule", "violation") : a.match === "face" ? t("speak.person", "person of interest sighted") : t("speak.watchlist", "watchlist vehicle");
  const plate = a.match === "face" ? (a.reason || "").split(/[:(]/)[0].trim() : speakPlate(a.plate);
  speak(t("speak.alert", "Alert. {kind} {plate} at {camera}, {department}.").replace("{kind}", kind).replace("{plate}", plate)
    .replace("{camera}", S.camById[a.camera_id]?.name || a.camera_id).replace("{department}", a.department || ""));
}
function setSpeak(on, announce = true) {
  SPEAK.on = on;
  try { localStorage.setItem("uvp-speak", on ? "1" : "0"); } catch (_) {}
  const b = $("#speak-toggle"); if (b) b.setAttribute("aria-pressed", on ? "true" : "false");
  if (announce) { toast(on ? t("speak.on", "Alerts will be spoken") : t("speak.off", "Alerts muted"), "ok"); if (on) speak(t("speak.test", "Spoken alerts are on.")); }
  if (on && window.speechSynthesis && !speakVoice(I18N.lang) && I18N.lang !== "en") toast(`No ${I18N.lang === "hi" ? "Hindi" : "Gujarati"} voice installed in this browser / OS — alerts are spoken in English. Windows: Settings → Time & language → Speech → Add voices.`, "warn");
}


// ------------------------------------------------------------------ server-down watcher: recover everything when it answers again
let SERVER_WATCH = null, SERVER_DOWN_AT = 0;
function watchServer() {
  if (SERVER_WATCH) return;
  SERVER_DOWN_AT = Date.now();
  $("#ws-dot") && ($("#ws-dot").className = "dot off");
  SERVER_WATCH = setInterval(async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });        // every 1.5 s: the moment the API answers again, everything reconnects
      if (!r.ok) return;
      clearInterval(SERVER_WATCH); SERVER_WATCH = null;
      const secs = Math.round((Date.now() - SERVER_DOWN_AT) / 1000);
      toast(`Server reachable again after ${secs} s — reconnecting streams`, "ok");
      try { if (S.ws && S.ws.readyState !== 1) connectWs(); } catch (_) {}
      try { await loadCameras(); } catch (_) {}
      S.tiles.filter((t) => t.cam).forEach((t) => { clearTimeout(t.retry); playTile(t); });
      if (S.view && typeof show === "function") show(S.view);
    } catch (_) { /* still down */ }
  }, 1500);
}


// ------------------------------------------------------------------ detection switch (AI runs only while ON)
const DET_STATE = { enabled: true, cameras: {}, locked: true };   // locked = AI detection always on, switch hidden
function detAllows(cid) { return cid in DET_STATE.cameras ? !!DET_STATE.cameras[cid] : !!DET_STATE.enabled; }
function applyDetection(st) {
  Object.assign(DET_STATE, { enabled: !!st.enabled, cameras: st.cameras || {}, locked: !!st.locked });
  if (DET_STATE.locked) { $("#detect-toggle")?.classList.add("hidden"); $$(".tile .det-badge, .tile [data-a=detect]").forEach((el) => el.remove()); return; }
  const b = $("#detect-toggle");
  if (b) { b.setAttribute("aria-pressed", DET_STATE.enabled ? "true" : "false"); b.textContent = `Detection: ${DET_STATE.enabled ? "ON" : "OFF"}`;
    b.classList.toggle("hidden", !can("supervisor")); }
  S.tiles.forEach((t) => { if (!t.cam) return; let d = t.el.querySelector(".det-badge"); if (!d) { d = document.createElement("span"); d.className = "det-badge"; t.el.appendChild(d); }
    const on = detAllows(t.cam), ov = t.cam in DET_STATE.cameras; d.textContent = on ? `AI on${ov ? " (this camera)" : ""}` : `AI off${ov ? " (this camera)" : ""}`; d.classList.toggle("on", on); });
}
async function loadDetection() { try { applyDetection(await api("/api/detection")); } catch (_) {} }
async function setDetection(body) {
  try { applyDetection(await api("/api/detection", { method: "POST", body: JSON.stringify(body) })); toast(`Detection ${body.enabled != null ? (body.enabled ? "ON" : "OFF") + " for all cameras" : body.on == null ? "follows the global switch" : (body.on ? "ON" : "OFF") + " for this camera"} — workers apply it within 5 s`, "ok"); }
  catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------------ navigation
function show(view) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
  const btn = $(`#tabs button[data-view="${view}"]`);
  if (btn && $("#page-title")) $("#page-title").textContent = btn.querySelector("span")?.textContent || view;
  if ($("#page-sub")) $("#page-sub").textContent = { wall: `${S.tiles.filter((t) => t.cam).length} feeds`, overview: new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) }[view] || "";
  S.view = view;
  if (EMBED) { try { parent.postMessage({ type: "uvp:view", view }, location.origin); } catch (_) {} }
  else { try { localStorage.setItem("uvp-view", view); } catch (_) {} }
  ({ overview: loadOverview, search: loadSearch, alerts: loadAlerts, watchlist: loadWatchlist, upload: loadUploads, registry: loadRegistry, counts: loadCountsView, sources: loadSources, audit: loadAudit, playback: loadPlayback, admin: loadAdmin, notifications: loadNotifications, reports: loadReports, cases: loadCases, map: loadMap, movement: loadMovementCases, multicam: loadMulti, violations: loadViolations }[view] || (() => {}))();
}

async function loadCounts() {
  if (!$("#ov-counts")) return;
  try {
    const r = await api("/api/counts");
    const live = r.cameras.filter((c) => !c.stale);
    $("#ov-counts-sub").textContent = live.length ? `${r.total.vehicles} vehicles · ${r.total.persons} people on ${r.total.cameras} cameras now` : "no analytics cameras reporting";
    $("#ov-counts").innerHTML = live.slice(0, 8).map((c) => `<div class="item"><span class="dot ok"></span><span class="name">${esc(c.name)}</span><span class="muted">${c.vehicles} veh · ${c.persons} ppl${c.faces ? ` · ${c.faces} face${c.faces > 1 ? "s" : ""}` : ""}${(c.known || []).length ? ` · <span class="bad-chip">${esc(c.known.join(", "))}</span>` : ""}</span></div>`).join("")
      || '<p class="muted small">Enable <code>traffic:</code> / <code>crowd:</code> / <code>face: true</code> on cameras in config/analytics.yaml to see live counts.</p>';
  } catch (_) {}
  clearTimeout(S.countsTimer);
  if (S.view === "overview") S.countsTimer = setTimeout(loadCounts, 5000);
}

// ------------------------------------------------------------------ persons of interest (face recognition)
async function loadPersons() {
  const tb = $("#persons-table tbody");
  if (!tb) return;
  try {
    const rows = await api("/api/persons");
    tb.innerHTML = rows.map((p) => `<tr class="${p.active ? "" : "muted"}"><td>${p.photo_urls[0] ? `<img class="crop" style="height:44px" src="${esc(withTok(p.photo_urls[0]))}" alt="">` : "–"}</td>
      <td><b>${esc(p.name)}</b>${p.active ? "" : ' <span class="bad-chip">inactive</span>'}<br><span class="small muted">${esc(p.reason)}</span></td><td>${esc(p.category)}</td><td>${esc(p.priority)}</td><td>${esc(p.reference || "–")}</td><td>${p.photos}</td>
      <td class="small">${p.last_seen_at ? `${esc(fmtTime(p.last_seen_at))}<br>${esc(S.camById[p.last_seen_camera]?.name || p.last_seen_camera)}` : "–"}</td><td>${p.sightings}</td><td class="small">${p.expires_at ? esc(fmtTime(p.expires_at)) : "never"}</td>
      <td><button class="btn ghost small" data-psee="${esc(p.id)}">Sightings</button> ${has("watchlist") ? `<button class="btn ghost small" data-pactive="${esc(p.id)}" data-on="${p.active}">${p.active ? "Pause" : "Resume"}</button> <button class="btn small danger" data-pdel="${esc(p.id)}">Remove</button>` : ""}</td></tr>`).join("")
      || '<tr><td colspan="10" class="muted">No persons enrolled.</td></tr>';
    $$("[data-pdel]").forEach((b) => b.onclick = async () => { if (confirm("Remove this person, their photos and embeddings?")) { await api(`/api/persons/${b.dataset.pdel}`, { method: "DELETE" }); loadPersons(); } });
    $$("[data-pactive]").forEach((b) => b.onclick = async () => { await api(`/api/persons/${b.dataset.pactive}`, { method: "PATCH", body: JSON.stringify({ active: b.dataset.on !== "true" }) }); loadPersons(); });
    $$("[data-psee]").forEach((b) => b.onclick = async () => {
      const r = await api(`/api/persons/${b.dataset.psee}/sightings`);
      modal(`<h3>Sightings</h3>${r.length ? `<table class="table"><thead><tr><th>When (IST)</th><th>Camera</th><th>Similarity</th><th>Snapshot</th></tr></thead><tbody>${r.map((x) => `<tr><td>${esc(fmtTime(x.ts))}</td><td>${esc(S.camById[x.camera_id]?.name || x.camera_id)}</td><td>${x.score ?? "–"}</td><td>${x.snapshot_url ? `<img class="crop" style="height:60px" src="${esc(withTok(x.snapshot_url))}" alt="">` : "–"}</td></tr>`).join("")}</tbody></table>` : '<p class="muted">No sightings yet.</p>'}`);
    });
  } catch (e) { tb.innerHTML = `<tr><td colspan="10" class="muted">${esc(e.message)}</td></tr>`; }
}
async function enrolPerson(ev) {
  ev.preventDefault();
  const f = ev.target, fd = new FormData(f), note = $("#person-form-note");
  if (!fd.getAll("photos").filter((x) => x && x.size).length) { toast("Choose at least one photo", "err"); return; }
  note.textContent = "Detecting faces in the photos…";
  try {
    const r = await fetch("/api/persons", { method: "POST", headers: { Authorization: `Bearer ${S.token}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || r.statusText);
    toast(`${j.name} enrolled with ${j.photos} photo${j.photos > 1 ? "s" : ""}; matching starts within 30 s on face-enabled cameras.`, "ok");
    f.reset(); f.days.value = 90; note.textContent = "";
    loadPersons();
  } catch (e) { note.textContent = ""; toast(e.message, "err"); }
}

// ------------------------------------------------------------------ uploaded video / photo analysis
async function runAnalysis(ev) {
  ev.preventDefault();
  const f = ev.target, fd = new FormData(), note = $("#analysis-note"), out = $("#analysis-result");
  const files = [...f.files.files];
  if (!files.length) { toast("Choose a video or photos", "err"); return; }
  files.forEach((x) => fd.append("files", x));
  fd.append("plates", f.plates.checked ? "1" : "0"); fd.append("note", f.note.value);
  const mb = files.reduce((n, x) => n + x.size, 0) / 1048576;
  out.innerHTML = ""; note.innerHTML = `Uploading ${mb.toFixed(1)} MB… <progress id="analysis-bar" max="100" value="0" style="width:180px;vertical-align:middle"></progress> <span id="analysis-pct">0%</span>`;
  const btn = f.querySelector("button.primary"); btn.disabled = true;
  try {
    // XHR instead of fetch: it reports upload progress, so a 150 MB phone video shows how far it has got
    const t0 = Date.now();
    const j = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/analyses"); x.setRequestHeader("Authorization", `Bearer ${S.token}`);
      x.upload.onprogress = (e) => { if (!e.lengthComputable) return; const pct = Math.round(e.loaded / e.total * 100);
        const bar = $("#analysis-bar"), p = $("#analysis-pct"); if (bar) bar.value = pct;
        const secs = (Date.now() - t0) / 1000, rate = e.loaded / 1048576 / Math.max(secs, 0.5);
        if (p) p.textContent = `${pct}% · ${rate.toFixed(1)} MB/s${pct < 100 ? ` · ~${Math.max(1, Math.round((e.total - e.loaded) / 1048576 / rate))}s left` : " · starting analysis"}`; };
      x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch (_) {} x.status < 300 ? resolve(b) : reject(new Error(b.detail || x.statusText)); };
      x.onerror = () => reject(new Error("upload failed (network)")); x.send(fd);
    });
    const poll = async () => {
      const a = await api(`/api/analyses/${j.id}`);
      if (a.status === "running") {
        const tot = a.total || 0, pct = tot ? Math.min(99, Math.round(a.progress / tot * 100)) : 0;
        note.innerHTML = `Analysing… <progress max="100" value="${pct}" style="width:180px;vertical-align:middle"></progress> frame ${a.progress}${tot ? ` of ~${tot}` : ""}`;
        setTimeout(poll, 1000); return; }
      if (a.status === "failed") { note.textContent = ""; btn.disabled = false; toast(`Analysis failed: ${a.error}`, "err"); return; }
      btn.disabled = false;
      note.textContent = analysisSummary(a);
      renderAnalysis(a);
      loadUploads(false);
    };
    poll();
  } catch (e) { note.textContent = ""; btn.disabled = false; toast(e.message, "err"); }
}
function analysisSummary(a) {
  const t = a.timing || {};
  return `${a.frames} frames · ${a.faces} face detections · ${a.persons.length} distinct person${a.persons.length === 1 ? "" : "s"} · ${a.plates.length} plate${a.plates.length === 1 ? "" : "s"}`
    + (t.total ? ` · analysed in ${t.total}s (faces ${t.faces}s, plates ${t.plates}s, decode ${t.decode}s)` : "");
}
async function loadUploads(clear = true) {
  if (clear) { $("#analysis-result").innerHTML = ""; $("#analysis-note").textContent = ""; }
  let rows = [];
  try { rows = await api("/api/analyses"); } catch (_) { return; }
  $("#upload-table tbody").innerHTML = rows.length ? rows.map((r) => `<tr>
      <td>${esc(fmtTime(r.created_at))}</td><td>${esc((r.files || []).join(", "))}</td><td>${esc(r.note || "")}</td>
      <td>${r.status === "done" ? '<span class="ok-chip">done</span>' : r.status === "failed" ? '<span class="bad-chip">failed</span>' : '<span class="muted">running…</span>'}</td>
      <td>${r.persons ?? ""}</td><td>${r.plates ?? ""}</td>
      <td><button class="btn small" data-open="${esc(r.id)}">Open</button> ${can("supervisor") ? `<button class="btn small danger" data-rm="${esc(r.id)}">Delete</button>` : ""}</td></tr>`).join("")
    : '<tr><td colspan="7" class="muted">Nothing uploaded yet.</td></tr>';
  $$("#upload-table [data-open]").forEach((b) => b.onclick = async () => {
    let a; try { a = await api(`/api/analyses/${b.dataset.open}`); } catch (e) { toast(e.message, "err"); return; }
    $("#analysis-note").textContent = a.status === "done" ? analysisSummary(a) : a.status;
    if (a.status === "done") renderAnalysis(a);
    $("#analysis-result").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $$("#upload-table [data-rm]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this upload, its crops and results?")) return;
    await api(`/api/analyses/${b.dataset.rm}`, { method: "DELETE" });
    loadUploads();
  });
}
function renderAnalysis(a) {
  const out = $("#analysis-result");
  const persons = a.persons.map((c) => `<div class="card" style="gap:6px">
      <div style="display:flex;gap:8px;align-items:flex-start">${c.best_crop_url ? `<img src="${esc(withTok(c.best_crop_url))}" alt="" style="height:96px;border-radius:6px">` : ""}<div>
        <b>Person ${c.rank}</b> <span class="muted small">seen ${c.count}× · ${c.first_t}s–${c.last_t}s · face ${c.face_px}px</span>
        ${c.match ? `<div><span class="bad-chip">matches enrolled: ${esc(c.match.name)} (${esc(c.match.category)}, ${c.match.score})</span></div>` : '<div class="muted small">not in the persons of interest</div>'}
        ${c.enrolled_person_id ? '<div><span class="ok-chip">enrolled from this video</span></div>' : ""}</div></div>
      <div style="display:flex;gap:4px">${(c.crop_urls || []).slice(1).map((u) => `<img src="${esc(withTok(u))}" alt="" style="height:44px;border-radius:4px">`).join("")}</div>
      ${has("watchlist") && !c.enrolled_person_id ? `<form class="search-form enrol-from" data-job="${esc(a.id)}" data-cluster="${c.cluster}"><label>Name <input name="name" required placeholder="name / alias"></label>
        <label>Category <select name="category"><option value="suspect">suspect</option><option value="wanted">wanted</option><option value="missing">missing</option><option value="other">other</option></select></label>
        <button class="btn small primary">Enrol &amp; watch on cameras</button></form>` : ""}
    </div>`).join("");
  const plates = a.plates.map((p) => `<span class="tick">${p.crop_url ? `<img src="${esc(withTok(p.crop_url))}" alt="">` : ""}<span class="platebox plate" data-plate="${esc(p.plate)}">${esc(p.plate)}</span> <span class="muted">${p.count}× · ${p.best_conf}</span></span>`).join("");
  out.innerHTML = `${persons ? `<div class="cards" style="margin-top:12px">${persons}</div>` : '<p class="muted small" style="margin-top:10px">No faces large enough (≥ 32 px) were found.</p>'}
    ${a.plates.length ? `<div class="panel-head" style="margin-top:8px"><h3>Plates in the footage</h3></div><div style="display:flex;flex-wrap:wrap;gap:8px">${plates}</div>` : ""}`;
  bindPlates(out);
  $$(".enrol-from", out).forEach((f) => f.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api(`/api/analyses/${f.dataset.job}/enrol`, { method: "POST", body: JSON.stringify({ cluster: +f.dataset.cluster, name: f.name.value, category: f.category.value }) });
      toast(`${r.name} enrolled from the video (${r.embeddings} face samples). Face-enabled cameras start watching within 30 s.`, "ok");
      renderAnalysis(await api(`/api/analyses/${f.dataset.job}`)); loadPersons();
    } catch (e) { toast(e.message, "err"); }
  });
}

// ------------------------------------------------------------------ theme (dark command centre / light portal) + sidebar
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("uvp-theme", t); } catch (_) {}
  $$(".theme-toggle").forEach((b) => b.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if (S.map) setTimeout(() => S.map.invalidateSize && S.map.invalidateSize(), 50);
}
function toggleTheme() { applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"); }
function setRail(on) { $("#app").classList.toggle("rail", on); try { localStorage.setItem("uvp-rail", on ? "1" : "0"); } catch (_) {} }

// ------------------------------------------------------------------ overview dashboard
async function loadOverview() {
  const [st, lic, sources] = await Promise.all([api("/api/stats?hours=24"), S.license || api("/api/license"), has("sources") ? api("/api/sources").catch(() => []) : Promise.resolve([])]);
  S.license = lic;
  const online = st.cameras_online, total = st.cameras;
  const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  $("#ov-kpis").innerHTML = [
    kpi("Cameras online", `${online} / ${total}`, online === total ? "ok" : online ? "warn" : "bad"),
    kpi("ANPR reads (24 h)", st.events), kpi("Unique plates (24 h)", st.unique_plates),
    kpi("Open alerts", st.alerts_open, st.alerts_open ? "bad" : "ok"), kpi("Watchlist plates", st.watchlist), kpi("ANPR cameras", st.anpr_cameras),
  ].join("");
  drawRate(st.per_minute, "#ov-chart");
  $("#ov-note").textContent = `search backend: ${S.cfg.search_backend} · bus: ${S.cfg.bus}`;
  // cameras by department
  const byDept = {};
  (S.cameras || []).forEach((c) => { const d = byDept[c.department] ||= { total: 0, online: 0, anpr: 0 }; d.total++; if (["online", "live"].includes(c.status)) d.online++; if (c.anpr_enabled) d.anpr++; });
  $("#ov-cam-sub").textContent = `${(S.cameras || []).length} registered`;
  loadCounts();
  $("#ov-cams").innerHTML = Object.entries(byDept).map(([d, x]) => `<div class="item"><span class="dot ${x.online === x.total ? "ok" : x.online ? "online" : "off"}"></span><span class="name dept-${esc(d)}">${esc(d)}</span><span class="muted">${x.online}/${x.total} online · ${x.anpr} ANPR</span></div>`).join("") || '<p class="muted small">No cameras yet — add a source in config/sources.yaml.</p>';
  $("#ov-sources").innerHTML = sources.map((s) => `<div class="item"><span class="dot ${s.status === "ok" ? "ok" : "off"}"></span><span class="name">${esc(s.name)}</span><span class="muted small">${esc(s.adapter)} · ${s.cameras} cams · ${s.active_pulls}/${s.max_concurrent_pulls} pulls</span></div>`).join("") || '<p class="muted small">No sources visible to your role.</p>';
  const over = Object.entries(lic.over_limit || {}).filter(([, v]) => v).map(([k]) => k);
  $("#ov-health").innerHTML = `<span>Licence</span><span class="${lic.mode === "licensed" ? "ok-chip" : "warn-chip"}">${esc(lic.status)}</span>
    <span>Cameras / ANPR / analytics</span><span>${lic.usage.cameras_total} / ${lic.usage.anpr_channels} / ${lic.usage.analytics_channels}${over.length ? ` <span class="bad-chip">over: ${esc(over.join(", "))}</span>` : ""}</span>
    <span>Version</span><span>v${esc(lic.version)}</span><span>Live channel</span><span class="${$("#ws-dot").classList.contains("ok") ? "ok-chip" : "bad-chip"}">${$("#ws-dot").classList.contains("ok") ? "connected" : "reconnecting"}</span>`;
  try {
    const r = await api("/api/events?limit=8");
    $("#ov-recent").innerHTML = r.events.map((e) => `<div class="r">${e.crop_url ? `<img src="${esc(withTok(e.crop_url))}" alt="">` : "<span></span>"}<span><span class="platebox plate ${e.plate_masked ? "masked" : ""}">${esc(e.plate)}</span> <span class="muted small">${esc(S.camById[e.camera_id]?.name || e.camera_id)}</span></span><span class="muted small">${esc(fmtTime(e.ts))}</span></div>`).join("") || '<p class="muted small">No plate reads yet.</p>';
  } catch (_) { $("#ov-recent").innerHTML = ""; }
}

// ------------------------------------------------------------------ cameras
async function loadCameras() {
  const all = await api("/api/cameras");
  S.camById = Object.fromEntries(all.map((c) => [c.id, c]));
  S.cameras = all.filter((c) => !c.registry_only);        // the wall / search only list cameras with a feed; the registry tab lists all
  renderCamTree();
  const sel = $("#search-form select[name=camera]");
  if (sel.options.length <= 1) S.cameras.forEach((c) => sel.add(new Option(`${c.name} (${c.department})`, c.id)));
}
function renderCamTree() {
  const q = $("#cam-filter").value.toLowerCase();
  const byDept = {};
  S.cameras.filter((c) => !q || `${c.name} ${c.id} ${c.department}`.toLowerCase().includes(q))
    .forEach((c) => (byDept[c.department] ||= []).push(c));
  $("#cam-tree").innerHTML = Object.entries(byDept).map(([d, cams]) => `
    <div class="dept"><h4><span class="dept-${esc(d)}">${esc(d)}</span><span class="muted">${cams.length}</span></h4>
    ${cams.map((c) => `<div class="cam" draggable="true" data-cam="${esc(c.id)}" title="${esc(c.id)} · ${esc(c.status)}">
      <span class="dot ${esc(c.status)}"></span><span class="name">${esc(c.name)}</span>
      ${c.anpr_enabled ? '<span class="tagchip anpr">ANPR</span>' : ""}</div>`).join("")}</div>`).join("")
    || '<p class="muted">No cameras visible for your role yet.</p>';
  $$(".cam").forEach((el) => {
    el.onclick = () => addToWall(el.dataset.cam);
    el.ondragstart = (e) => e.dataTransfer.setData("text/cam", el.dataset.cam);
  });
}

// ------------------------------------------------------------------ video wall
const GRID_N = { "1x1": 1, "2x2": 4, "3x3": 9, "4x4": 16, "1+5": 6 };
function buildWall(grid) {
  const keep = S.tiles.map((t) => t.cam);
  S.tiles.forEach(stopTile);
  S.grid = grid;
  const wall = $("#wall");
  wall.className = `wall g-${grid.replace("+", "p")}`;
  wall.innerHTML = "";
  S.tiles = [];
  for (let i = 0; i < GRID_N[grid]; i++) {
    const el = document.createElement("div");
    el.className = "tile";
    el.innerHTML = '<div class="empty">Drop a camera here</div>';
    const tile = { el, cam: null, pc: null, hls: null, profile: "sub" };
    el.ondragover = (e) => { e.preventDefault(); el.classList.add("drop"); };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = (e) => { e.preventDefault(); el.classList.remove("drop"); const id = e.dataTransfer.getData("text/cam"); if (id) setTile(tile, id); };
    wall.appendChild(el);
    S.tiles.push(tile);
  }
  keep.slice(0, S.tiles.length).forEach((id, i) => id && setTile(S.tiles[i], id));
  $$("#grid-select button").forEach((b) => b.classList.toggle("active", b.dataset.grid === grid));
  updateWallInfo();
}
function addToWall(id) {
  if (S.tiles.some((t) => t.cam === id)) return toast(`${S.camById[id]?.name || id} is already on the wall`);
  const free = S.tiles.find((t) => !t.cam) || S.tiles[S.tiles.length - 1];
  setTile(free, id);
}
function relayHost() { return S.cfg.relay.host || location.hostname; }
// Behind the TLS proxy (RELAY_PUBLIC_BASE=https://host/relay) both protocols go through one origin
// In a relay cluster each camera lives on one relay; /api/cameras carries that relay's public host.
function camRelay(path) { const c = S.camById[path.split("/")[0]] || {}; return { host: c.relay_host || relayHost(), whep: c.relay_webrtc_port || S.cfg.relay.webrtc_port, hls: c.relay_hls_port || S.cfg.relay.hls_port }; }
function whepUrl(path) { const r = camRelay(path); return S.cfg.relay.base ? `${S.cfg.relay.base}/webrtc/${path}/whep` : `${location.protocol}//${r.host}:${r.whep}/${path}/whep`; }
function hlsUrl(path) { const r = camRelay(path); return S.cfg.relay.base ? `${S.cfg.relay.base}/hls/${path}/index.m3u8` : `${location.protocol}//${r.host}:${r.hls}/${path}/index.m3u8`; }
function setTile(tile, camId, profile = "sub") {
  stopTile(tile);
  setTimeout(() => applyDetection(DET_STATE), 50);
  const c = S.camById[camId];
  if (!c) return;
  tile.cam = camId; tile.profile = profile;
  tile.el.innerHTML = `<video muted autoplay playsinline></video><canvas class="dets"></canvas><span class="detcount"></span>
    <div class="ov"><span class="dot live"></span><span class="t"><b>${esc(c.name)}</b></span>
      <span class="tagchip dept-${esc(c.department)}">${esc(c.department)}</span>${c.anpr_enabled ? '<span class="tagchip anpr">ANPR</span>' : ""}</div>
    <div class="state">connecting…</div>
    <div class="acts"><button data-a="max" title="${profile === "main" ? "Back to the grid" : "Fill the screen (switches to the HD stream)"}">${profile === "main" ? "Exit full screen" : "Full screen"}</button><button data-a="snap">Snapshot</button>
      ${has("playback") && camAllows(camId, "playback") ? '<button data-a="bookmark" title="Keep the last 10 s and next 10 s as a clip">Bookmark</button>' : ""}
      ${can("analyst") ? '<button data-a="tag">Tag event</button><button data-a="hist">ANPR history</button>' : ""}${can("supervisor") && !DET_STATE.locked ? '<button data-a="detect" title="AI detection on this camera">Detect</button>' : ""}<button data-a="close">✕</button></div>`;
  tile.el.querySelector(".acts").onclick = (e) => tileAction(tile, e.target.dataset.a);
  playTile(tile);
  saveWall();
  updateWallInfo();
}
function stopTile(tile) {
  clearTimeout(tile.hlsCheck);
  try { tile.pc && tile.pc.close(); } catch (_) {}
  try { tile.hls && tile.hls.destroy(); } catch (_) {}
  clearTimeout(tile.retry);
  tile.pc = tile.hls = null;
}
function clearTile(tile) {
  stopTile(tile); tile.cam = null; tile.el.classList.remove("max");
  tile.el.innerHTML = '<div class="empty">Drop a camera here</div>';
  saveWall(); updateWallInfo();
}
function setState(tile, txt) { const s = tile.el.querySelector(".state"); if (s) s.textContent = txt; }

// Browsers without H.264 (some Linux Chromium builds) get an on-demand VP8 transcode from the relay.
const H264 = (() => { try { return RTCRtpReceiver.getCapabilities("video").codecs.some((c) => /h264/i.test(c.mimeType)); } catch (_) { return true; } })();
// Sources the browser cannot decode (H.265 / HEVC cameras) are rejected by the relay with "codecs not
// supported" (HTTP 400): the tile then switches to the relay's on-demand H.264 transcode ("<cam>/<profile>-h264").
// Remembered per camera so the next play goes straight to the working variant.
const COMPAT = JSON.parse((() => { try { return localStorage.getItem("uvp.compat") || "{}"; } catch (_) { return "{}"; } })());
// a remembered transcode is re-checked against the direct stream after 6 h (the vendor may switch back to H.264)
function compatSuffix(cam) { return !H264 ? "-vp8" : (Date.now() - (COMPAT[cam] || 0) < 6 * 3600e3) ? "-h264" : ""; }
function rememberCompat(cam, on = true) {
  if (on) COMPAT[cam] = Date.now(); else delete COMPAT[cam];
  try { localStorage.setItem("uvp.compat", JSON.stringify(COMPAT)); } catch (_) {}
}
async function playTile(tile) {
  const video = tile.el.querySelector("video");
  const suffix = compatSuffix(tile.cam);
  const path = `${tile.cam}/${tile.profile}${suffix}`;
  const cam = tile.cam;
  const label = tile.profile === "main" ? "main stream" : "sub-stream";
  try {
    await playWhep(tile, video, withTok(whepUrl(path)));
    tile.compatFails = 0;
    if (!suffix && COMPAT[cam]) rememberCompat(cam, false);   // direct stream works again (camera back to H.264)
    setState(tile, `WebRTC · ${label}${suffix === "-vp8" ? " · VP8 compat" : suffix === "-h264" ? " · H.264 transcode (HEVC source)" : ""}`);
  } catch (e) {
    if (tile.cam !== cam) return;
    const msg = String(e.message || e);
    if (msg.includes("403")) { setState(tile, "refused: source at its stream cap or no permission"); return; }
    if (msg.includes("400") && !suffix) {      // relay: codecs not supported by client -> H.265 camera, use the transcode
      console.warn(`${cam}: browser cannot decode this source, switching to the H.264 transcode`);
      rememberCompat(cam);
      setState(tile, "starting H.264 transcode…");
      tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 1500);
      return;
    }
    console.warn("WebRTC failed, trying HLS", e);
    if (suffix === "-h264") { // the transcode did not come up: after two tries go back to the direct stream and re-detect
      tile.compatFails = (tile.compatFails || 0) + 1;
      if (tile.compatFails >= 2) { rememberCompat(cam, false); tile.compatFails = 0; setState(tile, "retrying direct stream…"); }
      else setState(tile, "starting H.264 transcode…");
      tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 2000);
      return;
    }
    if (suffix) { // VP8 compat stream cannot go over HLS: keep retrying WebRTC while ffmpeg starts
      setState(tile, "starting compatibility stream…");
      tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 3000);
      return;
    }
    try { playHls(tile, video, hlsUrl(path)); setState(tile, "HLS fallback"); }
    catch (e2) { setState(tile, "offline, retrying"); tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 5000); }
  }
}
async function playWhep(tile, video, url) {
  const pc = new RTCPeerConnection();
  tile.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (ev) => { video.srcObject = ev.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected"].includes(pc.connectionState) && tile.pc === pc) {
      setState(tile, "reconnecting…");
      tile.retry = setTimeout(() => tile.pc === pc && playTile(tile), 3000);
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((res) => { if (pc.iceGatheringState === "complete") return res();
    const t = setTimeout(res, 1500); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && (clearTimeout(t), res()); });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp });
  if (!r.ok) throw new Error(`WHEP ${r.status}`);
  await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
}
function playHls(tile, video, url) {
  const cam = tile.cam;
  if (window.Hls && Hls.isSupported()) {
    const h = new Hls({ lowLatencyMode: true, xhrSetup: (xhr, u) => xhr.open("GET", withTok(u), true) });
    tile.hls = h; h.loadSource(url); h.attachMedia(video);
    h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) { setState(tile, "offline, retrying"); tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 5000); } });
  } else { video.src = withTok(url); }
  // "HLS fallback" must mean pictures, not a black tile: if no frame arrives within 12 s, start over (WebRTC first)
  const started = Date.now();
  const check = () => {
    if (tile.cam !== cam) return;
    if (video.readyState >= 2 && !video.paused && video.currentTime > 0) { setState(tile, "HLS fallback · playing"); return; }
    if (Date.now() - started > 12000) { setState(tile, "no video over HLS, retrying…"); tile.retry = setTimeout(() => tile.cam === cam && playTile(tile), 1500); return; }
    tile.hlsCheck = setTimeout(check, 1000);
  };
  clearTimeout(tile.hlsCheck); tile.hlsCheck = setTimeout(check, 1000);
}
function tileAction(tile, a) {
  const c = S.camById[tile.cam];
  if (a === "close") return clearTile(tile);
  if (a === "detect") {
    const cur = detAllows(tile.cam), ov = tile.cam in DET_STATE.cameras;
    modal(`<h3>AI detection · ${esc(c?.name || tile.cam)}</h3><p class="muted small">Global switch is <b>${DET_STATE.enabled ? "ON" : "OFF"}</b>. This camera is currently <b>${cur ? "detecting" : "not detecting"}</b>${ov ? " (own setting)" : " (following the global switch)"}.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="det-on">Detect on this camera</button><button class="btn danger" id="det-off">Stop on this camera</button><button class="btn ghost" id="det-follow">Follow global switch</button></div>`);
    $("#det-on").onclick = () => { closeModal(); setDetection({ camera_id: tile.cam, on: true }); };
    $("#det-off").onclick = () => { closeModal(); setDetection({ camera_id: tile.cam, on: false }); };
    $("#det-follow").onclick = () => { closeModal(); setDetection({ camera_id: tile.cam, on: null }); };
    return;
  }
  if (a === "max") {
    const toMain = tile.profile === "sub";
    tile.el.classList.toggle("max", toMain);
    return setTile(tile, tile.cam, toMain ? "main" : "sub");
  }
  if (a === "snap") {
    const v = tile.el.querySelector("video"); const cv = document.createElement("canvas");
    cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext("2d").drawImage(v, 0, 0);
    const link = document.createElement("a"); link.download = `${tile.cam}_${Date.now()}.jpg`; link.href = cv.toDataURL("image/jpeg", 0.9); link.click();
    return;
  }
  if (a === "tag") return tagDialog(c);
  if (a === "bookmark") return quickBookmark(c);
  if (a === "hist") { show("search"); const f = $("#search-form"); [...f.camera.options].forEach((o) => { o.selected = o.value === c.id; }); f.plate.value = ""; runSearch(); }
}
function tagDialog(c) {
  modal(`<h3>Tag event on ${esc(c.name)}</h3><form id="tag-form" class="search-form">
    <label>Tag <select name="tag"><option>accident</option><option>crowd</option><option>traffic_jam</option><option>suspicious_vehicle</option><option>fire</option><option>other</option></select></label>
    <label>Note <input name="note" size="40"></label><button class="btn primary">Save tag</button></form>`);
  $("#tag-form").onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    await api("/api/tags", { method: "POST", body: JSON.stringify({ camera_id: c.id, tag: f.get("tag"), note: f.get("note") }) });
    closeModal(); toast(`Tagged "${f.get("tag")}" on ${c.name}`, "ok");
  };
}
function updateWallInfo() {
  const n = S.tiles.filter((t) => t.cam).length;
  const depts = new Set(S.tiles.filter((t) => t.cam).map((t) => S.camById[t.cam]?.department));
  $("#wall-info").textContent = n ? `${n} feeds from ${depts.size} department${depts.size > 1 ? "s" : ""}` : "";
}
function saveWall() { try { localStorage.setItem("uvp-wall", JSON.stringify({ grid: S.grid, cams: S.tiles.map((t) => t.cam) })); } catch (_) {} }
function restoreWall() {
  let w = null; try { w = JSON.parse(localStorage.getItem("uvp-wall")); } catch (_) {}
  if (w && w.cams?.some(Boolean)) { buildWall(w.grid || "2x2"); w.cams.forEach((id, i) => id && S.tiles[i] && S.camById[id] && setTile(S.tiles[i], id)); }
  else { // first run: one camera from each department side by side
    const pick = [...new Set(S.cameras.map((c) => c.department))].flatMap((d) => S.cameras.filter((c) => c.department === d).slice(0, 2));
    pick.slice(0, 4).forEach((c, i) => setTile(S.tiles[i], c.id));
  }
}
async function loadLayouts() {
  const L = await api("/api/layouts"); const sel = $("#layout-select");
  sel.innerHTML = '<option value="">Saved layouts…</option>' + Object.keys(L).map((k) => `<option>${esc(k)}</option>`).join("");
  sel.onchange = () => { const l = L[sel.value]; if (!l) return; buildWall(l.grid); l.cameras.forEach((id, i) => id && S.tiles[i] && setTile(S.tiles[i], id)); };
}

// ------------------------------------------------------------------ live events + alerts
function connectWs() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/alerts?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = () => $("#ws-dot").className = "dot ok";
  ws.onclose = () => { $("#ws-dot").className = "dot off"; setTimeout(connectWs, 3000); };
  S.ws = ws;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "event") addTick(msg, false);
    if (msg.type === "alert") onAlert(msg);
    if (msg.type === "break_glass") onBreakGlass(msg);
    if (msg.type === "incident") onIncident(msg);
    if (msg.type === "dets") onDets(msg);
    if (msg.type === "detection") applyDetection(msg);
    if (msg.type === "inbox") onInbox(msg);
    if (msg.type === "camera_health") toast(`Camera ${S.camById[msg.camera_id]?.name || msg.camera_id}: ${msg.status}${msg.detail ? " · " + msg.detail : ""}`, msg.status === "offline" ? "err" : "warn");
  };
  setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
}
function addTick(ev, hit) {
  const box = $("#ticker-items");
  const el = document.createElement("div");
  el.className = `tick${hit ? " hit" : ""}`;
  el.innerHTML = `${ev.crop_url ? `<img src="${esc(withTok(ev.crop_url))}" alt="">` : ""}<span><span class="plate">${esc(ev.plate)}</span><br><span class="muted">${esc(S.camById[ev.camera_id]?.name || ev.camera_id)}</span></span>`;
  el.onclick = () => traceVehicle(ev.plate);
  box.prepend(el);
  while (box.children.length > 25) box.lastChild.remove();
}
function onBreakGlass(m) {
  if (!has("admin")) return;
  toast(`Break-glass used by ${m.user}: ${m.reason}`, "err");
  modal(`<h3>⚠ Break-glass access activated</h3><p><b>${esc(m.user)}</b> elevated their access until ${esc(fmtTime(m.until))}.</p><p>Justification: ${esc(m.reason)}</p><p class="muted small">Recorded in the audit log. Review under Admin → Active grants.</p>`);
}
function onAlert(a) {
  addTick(a, true);
  try { speakAlert(a); } catch (_) {}
  S.alertsOpen++; setBadge();
  const t = document.createElement("div"); t.className = "toast";
  t.innerHTML = `${a.crop_url ? `<img src="${esc(withTok(a.crop_url))}" alt="">` : "<span></span>"}<div><b>${a.match === "rule" ? "Challan suggested" : "Watchlist hit"}: <span class="plate">${esc(a.plate)}</span></b>
    <div class="small muted">${esc(S.camById[a.camera_id]?.name || a.camera_id)} · ${esc(a.department)}${a.match === "fuzzy" ? ` · fuzzy match of ${esc(a.watchlist_plate)}` : ""}</div>
    <div class="small">${esc(a.reason || "")}</div></div>`;
  t.onclick = () => { t.remove(); traceVehicle(a.plate); };
  $("#toasts").prepend(t); setTimeout(() => t.remove(), 12000);
  const tile = S.tiles.find((x) => x.cam === a.camera_id);
  if (tile) { const f = document.createElement("div"); f.className = "flash"; tile.el.appendChild(f); setTimeout(() => f.remove(), 3200); }
}
async function refreshAlertBadge() { try { S.alertsOpen = (await api("/api/alerts?open_only=true")).length; setBadge(); } catch (_) {} }
function setBadge() { const b = $("#alert-badge"); b.textContent = S.alertsOpen; b.classList.toggle("hidden", !S.alertsOpen); }

// ------------------------------------------------------------------ search dashboard
async function loadSearch() {
  const st = await api("/api/stats?hours=24");
  $("#kpis").innerHTML = [["ANPR reads (24 h)", st.events], ["Unique plates", st.unique_plates], ["Open alerts", st.alerts_open],
    ["Watchlist", st.watchlist], ["Cameras online", `${st.cameras_online}/${st.cameras}`], ["ANPR cameras", st.anpr_cameras]]
    .map(([l, v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join("");
  drawRate(st.per_minute);
  $("#backend-note").textContent = `search backend: ${S.cfg.search_backend} · bus: ${S.cfg.bus}`;
  if (!S.lastResults.length) runSearch();
}
function drawRate(pm, target = "#rate-chart") {
  const keys = Object.keys(pm); const el = $(target);
  if (!keys.length) { el.innerHTML = '<p class="muted">No reads in the last hour.</p>'; return; }
  const W = 900, H = 150, P = 24, max = Math.max(...Object.values(pm), 1), bw = (W - P) / keys.length;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${keys.map((k, i) => { const h = (pm[k] / max) * (H - P - 6); return `<rect x="${P + i * bw + 1}" y="${H - P - h}" width="${Math.max(bw - 2, 1)}" height="${h}" fill="#3b82f6" rx="2"><title>${k} IST: ${pm[k]} reads</title></rect>`; }).join("")}
    <text x="${P}" y="${H - 6}" fill="#8b98a8" font-size="11">${esc(keys[0])}</text><text x="${W - 4}" y="${H - 6}" fill="#8b98a8" font-size="11" text-anchor="end">${esc(keys[keys.length - 1])}</text>
    <text x="2" y="12" fill="#8b98a8" font-size="11">${max}</text></svg>`;
}
function toIso(v) { return v ? new Date(v).toISOString() : ""; }
async function runSearch(ev) {
  ev && ev.preventDefault();
  const f = $("#search-form");
  const camSel = [...f.camera.selectedOptions].map((o) => o.value).filter(Boolean);     // several cameras at once; "All cameras" / nothing = all
  const p = new URLSearchParams({ plate: f.plate.value.trim(), fuzzy: f.fuzzy.checked, camera: camSel.join(","), tag: f.tag.value, vehicle_type: f.vehicle_type.value, colour: f.colour.value, limit: 1000 });
  if (f.since.value) p.set("since", toIso(f.since.value));
  if (f.until.value) p.set("until", toIso(f.until.value));
  const r = await api(`/api/events?${p}`);
  S.lastResults = r.events;
  $("#result-title").textContent = f.plate.value || camSel.length || f.tag.value ? `${r.count} matching vehicle records${camSel.length > 1 ? ` on ${camSel.length} cameras` : ""}` : "Latest vehicle records";
  $("#results tbody").innerHTML = r.events.map((e) => `<tr>
    <td>${esc(fmtTime(e.ts))}</td><td><span class="platebox plate ${e.plate_masked ? "masked" : ""}" ${e.plate_masked ? 'title="Plate masked: your role has no plate_search"' : `data-plate="${esc(e.plate)}"`}>${esc(e.plate)}</span></td>
    <td>${e.crop_url ? `<img class="crop" src="${esc(withTok(e.crop_url))}" data-frame="${esc(e.frame_url)}" alt="">` : ""}</td>
    <td>${esc(S.camById[e.camera_id]?.name || e.camera_id)}</td><td><span class="dept-${esc(e.department)}">${esc(e.department)}</span></td>
    <td>${Math.round(e.confidence * 100)}%</td><td>${e.reads}</td><td>${esc(e.direction)}</td>
    <td class="small">${[e.vehicle_colour, (e.vehicle_type || "").replace("_", " "), e.plate_colour && e.plate_colour !== "white" ? `${e.plate_colour} plate` : "", e.make_model].filter(Boolean).map(esc).join(" · ")}</td>
    <td>${(e.tags || []).filter((t) => !/^(type|colour|plate):/.test(t)).map((t) => `<span class="tagchip ${["watchlist", "challan_suggested", "over_speed", "wrong_way", "red_light", "triple_riding", "no_helmet"].includes(t) ? "watchlist" : ""}">${esc(t)}</span>`).join(" ")}</td>
    <td><button type="button" class="btn ghost small" data-clip="${esc(e.id)}">Clip</button>${has("export") && camAllows(e.camera_id, "export") ? ` <a class="btn ghost small" href="${esc(withTok(`/api/events/${e.id}/export`))}" title="Signed, watermarked evidence bundle (zip)">Evidence</a>` : ""}${has("cases") ? ` <button type="button" class="btn ghost small" data-case-add="${esc(e.id)}" title="File this sighting into a case">${t("btn.case", "+ Case")}</button>` : ""}${has("plate_search") && !e.plate_masked ? ` <button type="button" class="btn ghost small" data-fix="${esc(e.id)}" data-plate="${esc(e.plate)}" title="Confirm or correct this read">${t("btn.fix", "Fix plate")}</button>` : ""}</td></tr>`).join("")
    || '<tr><td colspan="11" class="muted">No records.</td></tr>';
  bindPlates($("#results"));
  $$("[data-clip]", $("#results")).forEach((b) => b.onclick = () => openClip(b.dataset.clip));
  $$("[data-case-add]", $("#results")).forEach((b) => b.onclick = () => addToCaseDialog("event", b.dataset.caseAdd));
  $$("[data-fix]", $("#results")).forEach((b) => { b.onclick = (ev) => { ev.stopPropagation(); reviewDialog(b.dataset.fix, b.dataset.plate); }; });
}
function reviewDialog(eid, plate, after) {
  modal(`<h3>Review read <span class="platebox plate">${esc(plate)}</span></h3>
    <form id="rv-form" class="search-form"><label>Verdict <select name="verdict"><option value="confirmed">${t("review.confirm", "Confirm")}: read correctly</option><option value="corrected">${t("review.correct", "Correct")} to…</option><option value="unreadable">${t("review.unreadable", "Unreadable")}</option></select></label>
    <label>Correct plate <input name="true_plate" placeholder="MP04ZR7493" autocapitalize="characters"></label>
    <label>Reason <select name="reason"><option value="">–</option><option>two_line</option><option>night</option><option>dirty</option><option>decorative_font</option><option>occluded</option><option>angle</option><option>motion_blur</option><option>other</option></select></label>
    <button class="btn primary">Save</button></form>`);
  $("#rv-form").onsubmit = async (ev) => { ev.preventDefault(); const f = ev.target;
    try { const r = await api(`/api/events/${eid}/review`, { method: "POST", body: JSON.stringify({ verdict: f.verdict.value, true_plate: f.true_plate.value, reason: f.reason.value }) }); closeModal(); toast(`Saved: ${r.verdict}${r.verdict === "corrected" ? " → " + r.plate : ""}`, "ok"); (after || runSearch)(); }
    catch (e) { toast(e.message, "err"); } };
}
async function loadReviewQueue() {
  if (!has("plate_search")) return;
  const rows = await api("/api/reports/anpr/review-queue?limit=200");
  $("#review-table tbody").innerHTML = rows.map((e) => `<tr><td>${esc(fmtTime(e.ts))}</td><td><span class="platebox plate">${esc(e.plate)}</span> <span class="small muted">${Math.round(e.confidence * 100)}%</span></td>
    <td>${e.crop_url ? `<img class="crop" src="${esc(withTok(e.crop_url))}" data-frame="${esc(e.frame_url)}" alt="">` : ""}</td><td>${esc(S.camById[e.camera_id]?.name || e.camera_id)}</td>
    <td>${(e.tags || []).filter((x) => !/^(type|colour|plate):/.test(x)).map((x) => `<span class="tagchip">${esc(x)}</span>`).join(" ")}</td>
    <td><button class="btn ghost small" data-rv-ok="${esc(e.id)}">${t("review.confirm", "Confirm")}</button> <button class="btn ghost small" data-rv-fix="${esc(e.id)}" data-plate="${esc(e.plate)}">${t("review.correct", "Correct")}</button></td></tr>`).join("")
    || '<tr><td colspan="6" class="muted">Nothing waiting for review.</td></tr>';
  bindPlates($("#review-table"));
  $$("[data-rv-ok]").forEach((b) => b.onclick = () => api(`/api/events/${b.dataset.rvOk}/review`, { method: "POST", body: JSON.stringify({ verdict: "confirmed" }) }).then(() => { loadReviewQueue(); loadReport(); }));
  $$("[data-rv-fix]").forEach((b) => b.onclick = () => reviewDialog(b.dataset.rvFix, b.dataset.plate, () => { loadReviewQueue(); loadReport(); }));
}
async function loadTraffic() {
  try {
    const r = await api(`/api/traffic?hours=${$("#tr-hours").value}`);
    $("#tr-sub").textContent = `${r.rows.length} one-minute windows`;
    $("#tr-table tbody").innerHTML = r.summary.map((c) => `<tr><td>${esc(c.camera_name)}</td><td>${c.windows}</td><td><b>${c.avg_vehicles}</b></td><td>${c.peak_vehicles}</td><td><b>${c.avg_persons ?? 0}</b></td>
      <td class="small">${esc(Object.entries(c.by_class).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "))}</td><td>${c.flow.a_to_b || "–"}</td><td>${c.flow.b_to_a || "–"}</td><td class="small">${esc(fmtTime(c.last))}</td></tr>`).join("")
      || '<tr><td colspan="9" class="muted">No traffic counts yet: add <code>traffic:</code> to a camera in config/analytics.yaml.</td></tr>';
  } catch (_) {}
}
async function loadReport() {
  const r = await api(`/api/reports/anpr?weeks_ago=${$("#rep-week").value}`);
  $("#rep-sub").textContent = `${r.week_start} → ${r.week_end}: ${r.reads} reads, ${r.reviewed} reviewed, accuracy ${r.accuracy_pct ?? "–"}% on reviewed reads. ${r.note}`;
  $("#rep-table tbody").innerHTML = r.cameras.map((c) => `<tr><td>${esc(c.camera_name)}</td><td>${c.reads}</td><td>${c.reviewed}</td><td><b>${c.accuracy_pct ?? "–"}${c.accuracy_pct != null ? "%" : ""}</b></td><td>${c.mean_confidence}</td><td>${c.low_confidence_pct}%</td><td>${c.invalid_format_pct}%</td><td>${c.night_pct}%</td><td class="small">${esc(c.top_reasons.map(([k, n]) => `${k} ×${n}`).join(", "))}</td></tr>`).join("") || '<tr><td colspan="9" class="muted">No reads this week.</td></tr>';
  $("#rep-train").href = withTok("/api/reports/anpr/training-set.zip");
}
async function licenseBanner() {
  try {
    const l = await api("/api/license");
    S.license = l;
    let b = $("#lic-banner");
    if (!b) { b = document.createElement("div"); b.id = "lic-banner"; b.className = "lic-banner hidden"; $("#bg-banner").after(b); }
    const over = Object.entries(l.over_limit).filter(([, v]) => v).map(([k]) => k);
    const show = l.mode !== "licensed" || over.length;
    b.classList.toggle("hidden", !show);
    if (show) b.textContent = `${t("license.title", "Licence")}: ${l.status}${over.length ? " · over limit: " + over.join(", ") + " (extra cameras stay unlicensed)" : ""}`;
  } catch (_) {}
}
async function openClip(eid) {
  let c;
  try { c = await api(`/api/events/${eid}/clip`); } catch (e) { toast(e.message, "err"); return; }
  if (c.status === "pending") return toast(t("toast.clip_pending", "Clip is still being archived; try again in a few seconds"), "warn");
  if (c.status === "none") return toast("No recording for this camera at that time (camera not in RECORD_MODE or analysed from a file)", "warn");
  playArchive(c.url, `${c.plate} · ${S.camById[c.camera_id]?.name || c.camera_id} · ${fmtTime(c.ts)}`);
}
function playArchive(url, title, download) {
  const src = url.startsWith("http") ? url : withTok(url);
  const dl = download ? ` <a class="btn ghost small" href="${esc(withTok(download.url))}" download="${esc(download.filename)}">Download this video</a>` : "";
  modal(`<h3>${esc(title)}</h3><video controls autoplay playsinline style="width:min(90vw,960px);max-height:70vh;background:#000" src="${esc(src)}"></video>
    <p class="small muted">Streamed from the video archive (object storage). This access is written to the audit log.${dl}</p>`);
}

// ------------------------------------------------------------------ playback (archived recordings)
async function loadPlayback() {
  const sel = $("#pb-camera");
  if (!sel.options.length) {
    const opts = S.cameras.map((c) => `<option value="${esc(c.id)}">${esc(c.department)} · ${esc(c.name)}</option>`).join("");
    sel.innerHTML = opts; $("#bm-camera").innerHTML = opts;
    const f = $("#pb-form"), t = new Date();
    f.to.value = pbLocal(t); f.from.value = pbLocal(new Date(t.getTime() - 15 * 60000));
    $$("#pb-quick [data-min]").forEach((b) => b.onclick = () => {
      const n = new Date();
      f.to.value = pbLocal(n); f.from.value = pbLocal(new Date(n.getTime() - +b.dataset.min * 60000));
      runPlayback();
    });
    $("#pb-play-all").onclick = () => pbCombined("play");
    $("#pb-download-all").onclick = () => pbCombined("download");
    $("#pb-download-all").classList.toggle("hidden", !has("export"));
  }
  loadBookmarks();
}
async function loadBookmarks() {
  const rows = await api("/api/bookmarks");
  $("#bm-table tbody").innerHTML = rows.map((b) => `<tr><td>${esc(fmtTime(b.ts))}</td><td>${esc(b.camera_name)}</td><td>${esc(b.label)}</td><td>-${b.before_s}s / +${b.after_s}s</td><td>${esc(b.created_by)}</td>
    <td>${b.clip === "ready" ? `<button type="button" class="btn ghost small" data-url="${esc(b.play_url)}" data-start="${esc(b.ts)}" data-name="${esc(b.camera_name)}">Play</button>` : b.clip === "none" ? '<span class="muted">not recorded</span>' : `<button type="button" class="btn ghost small" data-cut="${esc(b.id)}">Cut clip</button>`}</td>
    <td>${has("cases") ? `<button type="button" class="btn ghost small" data-bm-case="${esc(b.id)}">+ Case</button> ` : ""}<button type="button" class="btn ghost small" data-bm-del="${esc(b.id)}">✕</button></td></tr>`).join("")
    || '<tr><td colspan="7" class="muted">No bookmarks yet. Use "Bookmark" on a wall tile, or the form above for a past moment.</td></tr>';
  $$("[data-url]", $("#bm-table")).forEach((b) => b.onclick = () => playArchive(b.dataset.url, `${b.dataset.name} · ${fmtTime(b.dataset.start)}`));
  $$("[data-cut]").forEach((b) => b.onclick = async () => { try { const r = await api(`/api/bookmarks/${b.dataset.cut}/cut`, { method: "POST" }); toast(r.clip === "ready" ? "Clip ready" : "No recording covers that window", r.clip === "ready" ? "ok" : "warn"); loadBookmarks(); } catch (e) { toast(e.message, "err"); } });
  $$("[data-bm-del]").forEach((b) => b.onclick = () => api(`/api/bookmarks/${b.dataset.bmDel}`, { method: "DELETE" }).then(loadBookmarks));
  $$("[data-bm-case]").forEach((b) => b.onclick = () => addToCaseDialog("bookmark", b.dataset.bmCase));
}
async function addBookmark(ev) {
  ev.preventDefault(); const f = ev.target;
  try {
    const b = await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ camera_id: f.camera.value, ts: f.ts.value ? toIso(f.ts.value) : null, label: f.label.value, before_s: +f.before_s.value, after_s: +f.after_s.value }) });
    toast("Bookmark added; cutting clip…", "ok"); f.label.value = "";
    setTimeout(async () => { try { await api(`/api/bookmarks/${b.id}/cut`, { method: "POST" }); } catch (_) {} loadBookmarks(); }, 500);
    loadBookmarks();
  } catch (e) { toast(e.message, "err"); }
}
async function quickBookmark(c) {
  try {
    const b = await api("/api/bookmarks", { method: "POST", body: JSON.stringify({ camera_id: c.id, label: "Marked from the wall", before_s: 10, after_s: 10 }) });
    toast(`Bookmarked ${c.name}; the clip is cut in ~20 s (Playback → Bookmarks)`, "ok");
    setTimeout(() => api(`/api/bookmarks/${b.id}/cut`, { method: "POST" }).catch(() => {}), 20000);
  } catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------------ cases
async function loadMovementCases() {
  if (!has("cases")) return;
  try { const cases = await api("/api/cases?status=open"); $("#move-case").innerHTML = '<option value="">— none —</option>' + cases.map((c) => `<option value="${esc(c.id)}">${esc(c.number)} · ${esc(c.title)}</option>`).join(""); } catch (_) {}
}
function stitchClips() {
  const f = $("#move-form"); const p = f.plate.value.trim(); if (!p) return toast("Enter a plate first", "warn");
  const q = new URLSearchParams(); if (f.since.value) q.set("since", toIso(f.since.value)); if (f.until.value) q.set("until", toIso(f.until.value)); if (f.case_id && f.case_id.value) q.set("case_id", f.case_id.value);
  toast("Stitching clips… the download starts when ready", "ok");
  location.href = withTok(`/api/vehicles/${encodeURIComponent(p)}/stitch?${q}`);
}
async function loadCases() {
  const mine = $("#cases-mine").checked;
  const rows = await api(`/api/cases?mine=${mine}`);
  $("#cases-table tbody").innerHTML = rows.map((c) => `<tr data-case="${esc(c.id)}" class="${S.caseSel === c.id ? "sel" : ""}"><td><b>${esc(c.number)}</b></td><td>${esc(c.title)}</td><td>${esc(c.reference)}</td><td>${esc(c.priority)}</td><td>${esc(c.owner)}</td><td>${c.items}</td><td>${esc(c.status)}</td><td>${esc(fmtTime(c.updated_at))}</td></tr>`).join("")
    || '<tr><td colspan="8" class="muted">No cases yet.</td></tr>';
  $$("#cases-table tbody tr[data-case]").forEach((tr) => tr.onclick = () => openCase(tr.dataset.case));
  if (S.caseSel) openCase(S.caseSel);
}
async function openCase(id) {
  S.caseSel = id;
  $$("#cases-table tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.case === id));
  const c = await api(`/api/cases/${id}`);
  const item = (it) => {
    const m = it.meta || {};
    if (it.kind === "event") return `<li><img src="${esc(withTok(m.crop_url))}" alt=""><div><b>${esc(m.plate)}</b> · ${esc(m.camera_name)} · ${esc(fmtTime(m.ts))}${it.note ? `<br><span class="small muted">${esc(it.note)}</span>` : ""}</div><span>${m.play_url ? `<button class="btn ghost small" data-play="${esc(m.play_url)}" data-title="${esc(m.plate)}">Clip</button> ` : ""}<button class="btn ghost small" data-rm="${esc(it.id)}">✕</button></span></li>`;
    if (it.kind === "note") return `<li><span class="tagchip">note</span><div>${esc(it.note)}<br><span class="small muted">${esc(it.added_by)} · ${esc(fmtTime(it.added_at))}</span></div><button class="btn ghost small" data-rm="${esc(it.id)}">✕</button></li>`;
    const label = it.kind === "stitch" ? `Stitched timeline ${esc(m.plate)} (${m.segments} clips)` : it.kind === "bookmark" ? `Bookmark: ${esc(m.label)} · ${esc(m.camera_id)} · ${esc(fmtTime(m.ts))}` : `Recording ${esc(m.camera_id)} · ${esc(fmtTime(m.start))}`;
    return `<li><span class="tagchip">${esc(it.kind)}</span><div>${label}${it.note ? `<br><span class="small muted">${esc(it.note)}</span>` : ""}</div><span>${m.play_url ? `<button class="btn ghost small" data-play="${esc(m.play_url)}" data-title="${esc(label)}">Play</button> ` : ""}<button class="btn ghost small" data-rm="${esc(it.id)}">✕</button></span></li>`;
  };
  $("#case-detail").innerHTML = `<div class="panel-head"><h3>${esc(c.number)} · ${esc(c.title)}</h3><span>
      ${has("export") ? `<a class="btn ghost small" href="${esc(withTok(`/api/cases/${c.id}/export`))}" title="report.pdf + watermarked media + signed manifest">Export bundle</a> ` : ""}
      <button class="btn ghost small" id="case-toggle">${c.status === "open" ? "Close case" : "Reopen"}</button></span></div>
    <p class="small muted">Ref ${esc(c.reference || "-")} · ${esc(c.priority)} · ${esc(c.department || "-")} · owner <b>${esc(c.owner)}</b> · opened by ${esc(c.created_by)} ${esc(fmtTime(c.created_at))} · ${esc(c.status)}</p>
    <form id="case-assign" class="search-form"><label>Assign to <input name="owner" value="${esc(c.owner)}"></label><label>Priority <select name="priority">${["high", "medium", "low"].map((p) => `<option ${p === c.priority ? "selected" : ""}>${p}</option>`).join("")}</select></label><button class="btn ghost small">Save</button></form>
    <h4>Evidence (${c.items.length})</h4><ul class="case-items">${c.items.map(item).join("") || '<li class="muted">Nothing filed yet. Use "+ Case" on search results and bookmarks, or "Stitch clips" in Vehicle movement.</li>'}</ul>
    <form id="case-note" class="search-form"><label style="flex:1">Note <input name="note" required placeholder="investigation note"></label><button class="btn ghost small">Add note</button></form>
    <h4>Chain of custody <span class="${c.custody_chain.ok ? "ok-chip" : "bad-chip"} small">${c.custody_chain.ok ? "✓ intact" : "✗ broken"}</span></h4>
    <div class="custody">${c.custody.map((x) => `${esc(fmtTime(x.ts))} · <b>${esc(x.action)}</b> · ${esc(x.user)} · ${esc(x.detail)}${x.sha256 ? ` · sha256 ${esc(x.sha256.slice(0, 12))}…` : ""}`).join("<br>")}</div>`;
  $("#case-toggle").onclick = async () => { await api(`/api/cases/${c.id}`, { method: "PATCH", body: JSON.stringify({ status: c.status === "open" ? "closed" : "open" }) }); loadCases(); };
  $("#case-assign").onsubmit = async (ev) => { ev.preventDefault(); await api(`/api/cases/${c.id}`, { method: "PATCH", body: JSON.stringify({ owner: ev.target.owner.value.trim(), priority: ev.target.priority.value }) }); loadCases(); };
  $("#case-note").onsubmit = async (ev) => { ev.preventDefault(); try { await api(`/api/cases/${c.id}/items`, { method: "POST", body: JSON.stringify({ kind: "note", note: ev.target.note.value }) }); openCase(c.id); } catch (e) { toast(e.message, "err"); } };
  $$("[data-rm]", $("#case-detail")).forEach((b) => b.onclick = async () => { await api(`/api/cases/${c.id}/items/${b.dataset.rm}`, { method: "DELETE" }); openCase(c.id); });
  $$("[data-play]", $("#case-detail")).forEach((b) => b.onclick = () => playArchive(b.dataset.play, b.dataset.title));
}
async function createCase(ev) {
  ev.preventDefault(); const f = ev.target;
  try { const c = await api("/api/cases", { method: "POST", body: JSON.stringify({ title: f.title.value, reference: f.reference.value, priority: f.priority.value, owner: f.owner.value.trim() }) }); f.reset(); S.caseSel = c.id; loadCases(); toast(`${c.number} opened`, "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function addToCaseDialog(kind, refId) {
  const cases = await api("/api/cases?status=open");
  if (!cases.length) return toast("No open cases: open one in the Cases tab first", "warn");
  modal(`<h3>File into case</h3><form id="atc-form" class="search-form"><label>Case <select name="case_id">${cases.map((c) => `<option value="${esc(c.id)}">${esc(c.number)} · ${esc(c.title)}</option>`).join("")}</select></label>
    <label>Note <input name="note" placeholder="why this matters"></label><button class="btn primary">Add</button></form>`);
  $("#atc-form").onsubmit = async (ev) => { ev.preventDefault();
    try { await api(`/api/cases/${ev.target.case_id.value}/items`, { method: "POST", body: JSON.stringify({ kind, ref_id: refId, note: ev.target.note.value }) }); closeModal(); toast("Filed into case", "ok"); }
    catch (e) { toast(e.message, "err"); } };
}

// ------------------------------------------------------------------ violations: challans + incidents
async function loadViolations() {
  const [st, offs] = await Promise.all([api("/api/incidents/stats?hours=24"), api("/api/offences")]);
  const inc = Object.entries(st.incidents).map(([k, n]) => `<span>${esc(k.replace(/_/g, " "))}</span><b>${n}</b>`).join("") || "<span class='muted'>none in 24 h</span><span></span>";
  const ch = Object.entries(st.challans).map(([k, n]) => `<span>${esc(k)}</span><b>${n}</b>`).join("") || "<span class='muted'>none</span><span></span>";
  $("#viol-cards").innerHTML = `<div class="card"><b>Incidents, last 24 h</b><div class="kv">${inc}</div></div><div class="card"><b>Challans</b><div class="kv">${ch}</div></div>
    <div class="card"><b>Offence schedule</b><div class="kv">${Object.entries(offs).map(([k, o]) => `<span>${esc(o.label)}</span><b>Rs ${o.fine_inr} / ${o.repeat_inr}</b>`).join("")}</div></div>`;
  await Promise.all([loadChallans(), loadIncidents(), loadReviewQueue(), loadReport(), loadTraffic()]);
}
async function loadChallans() {
  const rows = await api(`/api/challans?status=${$("#ch-status").value}`);
  const canReview = has("alerts_ack");
  $("#ch-table tbody").innerHTML = rows.map((c) => `<tr><td><b>${esc(c.number)}</b>${c.repeat ? ' <span class="tagchip watchlist">repeat</span>' : ""}</td><td>${esc(fmtTime(c.ts))}</td>
    <td><span class="platebox plate ${c.plate_masked ? "masked" : ""}" ${c.plate_masked ? "" : `data-plate="${esc(c.plate)}"`}>${esc(c.plate)}</span></td><td>${esc(c.label)}</td><td class="small">${esc(c.section)}</td><td>Rs ${c.fine_inr}</td>
    <td>${esc(S.camById[c.camera_id]?.name || c.camera_id)}</td><td>${c.crop_url ? `<img class="crop" src="${esc(withTok(c.crop_url))}" data-frame="${esc(c.frame_url)}" alt="">` : c.frame_url ? `<img class="crop" src="${esc(withTok(c.frame_url))}" data-frame="${esc(c.frame_url)}" alt="">` : ""}</td>
    <td>${esc(c.status)}${c.external_ref ? `<br><span class="small muted">${esc(c.external_ref)}</span>` : ""}${c.remarks ? `<br><span class="small muted">${esc(c.remarks)}</span>` : ""}</td>
    <td>${canReview && (c.status === "draft" || c.status === "failed") ? `<button class="btn ghost small" data-ch-ok="${esc(c.id)}">Approve</button> <button class="btn ghost small" data-ch-no="${esc(c.id)}">Reject</button> ` : ""}${has("export") ? `<a class="btn ghost small" href="${esc(withTok(`/api/challans/${c.id}/export`))}">Pack</a>` : ""}</td></tr>`).join("")
    || '<tr><td colspan="10" class="muted">Nothing here.</td></tr>';
  bindPlates($("#ch-table"));
  $$("[data-ch-ok]").forEach((b) => b.onclick = () => reviewChallan(b.dataset.chOk, "approve"));
  $$("[data-ch-no]").forEach((b) => b.onclick = () => reviewChallan(b.dataset.chNo, "reject"));
}
async function reviewChallan(id, action) {
  const remarks = prompt(action === "approve" ? "Approve and send to e-challan. Remarks (optional):" : "Reject. Reason:") ;
  if (remarks === null) return;
  try { const r = await api(`/api/challans/${id}/review`, { method: "POST", body: JSON.stringify({ action, remarks }) }); toast(`${r.number}: ${r.status}${r.external_ref ? " · " + r.external_ref : ""}`, r.status === "failed" ? "err" : "ok"); loadViolations(); }
  catch (e) { toast(e.message, "err"); }
}
async function loadIncidents() {
  const rows = await api(`/api/incidents?open_only=${$("#inc-open").checked}&limit=1000`);
  $("#inc-table tbody").innerHTML = rows.map((i) => `<tr><td>${esc(fmtTime(i.ts))}</td><td><span class="tagchip ${i.priority === "high" ? "watchlist" : ""}">${esc(i.label)}</span></td><td>${esc(i.zone)}</td>
    <td>${esc(S.camById[i.camera_id]?.name || i.camera_id)}</td><td>${i.plate ? `<span class="platebox plate">${esc(i.plate)}</span>` : '<span class="muted">–</span>'}</td>
    <td class="small">${esc(Object.entries(i.detail || {}).filter(([k]) => k !== "bbox").map(([k, v]) => `${k}: ${v}`).join(", "))}</td>
    <td>${i.snapshot_url ? `<img class="crop" src="${esc(withTok(i.snapshot_url))}" data-frame="${esc(i.snapshot_url)}" alt="">` : ""}</td>
    <td>${i.ack_by ? `seen by ${esc(i.ack_by)}` : has("alerts_ack") ? `<button class="btn ghost small" data-inc-ack="${esc(i.id)}">Acknowledge</button>` : "open"}</td></tr>`).join("")
    || '<tr><td colspan="8" class="muted">No incidents. Zone analytics run on cameras configured in config/analytics.yaml.</td></tr>';
  bindPlates($("#inc-table"));
  $$("[data-inc-ack]").forEach((b) => b.onclick = () => api(`/api/incidents/${b.dataset.incAck}/ack`, { method: "POST" }).then(loadIncidents));
}
// ------------------------------------------------------------------ live detection overlay on the wall
const DETS = { show: true, last: {} };
function onDets(m) {
  DETS.last[m.camera_id] = { ...m, at: Date.now() };
  if (!DETS.show) return;
  S.tiles.filter((t) => t.cam === m.camera_id).forEach((t) => drawDets(t, m));
}
function drawDets(tile, m) {
  const cv = tile.el.querySelector("canvas.dets"), video = tile.el.querySelector("video"), badge = tile.el.querySelector(".detcount");
  if (!cv || !video) return;
  const W = tile.el.clientWidth, H = tile.el.clientHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  // the video is letterboxed with object-fit: contain; map frame coordinates into the displayed area
  const fw = m.w || video.videoWidth || W, fh = m.h || video.videoHeight || H;
  const sc = Math.min(W / fw, H / fh), ox = (W - fw * sc) / 2, oy = (H - fh * sc) / 2;
  let vehicles = 0, people = 0, plates = 0, faces = 0;
  ctx.lineWidth = 2; ctx.font = "12px system-ui, sans-serif";
  for (const b of m.boxes || []) {
    const [cls, conf, x1, y1, x2, y2] = b;
    const isPlate = String(cls).startsWith("plate"), isFace = String(cls).startsWith("face");
    const known = isFace && String(cls).startsWith("face:");
    if (isPlate) plates++; else if (isFace) { if (known) faces++; } else if (cls === "person") people++; else vehicles++;
    ctx.strokeStyle = isPlate ? "#ffd166" : known ? "#ff5fd2" : isFace ? "#9aa5b1" : cls === "person" ? "#ef476f" : "#06d6a0";
    ctx.lineWidth = known ? 3 : 2;
    ctx.strokeRect(ox + x1 * sc, oy + y1 * sc, (x2 - x1) * sc, (y2 - y1) * sc);
    const label = isPlate ? String(cls).replace("plate:", "") || "plate" : known ? String(cls).slice(5) : isFace ? "" : `${cls} ${Math.round(conf * 100)}%`;
    if (!label) continue;
    const tw = ctx.measureText(label).width + 6;
    ctx.fillStyle = "rgba(0,0,0,.65)"; ctx.fillRect(ox + x1 * sc, Math.max(0, oy + y1 * sc - 14), tw, 14);
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(label, ox + x1 * sc + 3, Math.max(11, oy + y1 * sc - 3));
  }
  if (badge) {
    const parts = [];
    if (vehicles) parts.push(`${vehicles} vehicle${vehicles > 1 ? "s" : ""}`);
    if (people) parts.push(`${people} person${people > 1 ? "s" : ""}`);
    if (plates) parts.push(`${plates} plate${plates > 1 ? "s" : ""}`);
    if (faces) parts.push(`${faces} person${faces > 1 ? "s" : ""} of interest`);
    if (m.lag_ms > 1500) parts.push(`overlay ${(m.lag_ms / 1000).toFixed(1)}s behind`);   // capture -> inference -> console
    badge.textContent = parts.join(" · ") || (["plate", "face"].includes(m.kind) ? "" : "no objects");
    badge.classList.toggle("hidden", !parts.length && ["plate", "face"].includes(m.kind));
  }
  clearTimeout(tile.detTimer);
  tile.detTimer = setTimeout(() => { ctx.clearRect(0, 0, W, H); if (badge) badge.textContent = ""; }, 2500);
}
function onIncident(m) {
  toast(`${m.label} on ${S.camById[m.camera_id]?.name || m.camera_id}${m.zone ? " (" + m.zone + ")" : ""}`, "err");
  if (m.kind === "crowd") speak(`${t("speak.crowd", "crowd alert")}. ${S.camById[m.camera_id]?.name || m.camera_id}.`);
}
async function loadHotlists() {
  if (!has("watchlist")) return;
  try {
    const h = await api("/api/hotlists");
    $("#hl-list").innerHTML = h.sources.map((s) => `<div>${esc(s.name)} · ${esc(s.kind)} · every ${s.interval_minutes} min · ${s.last ? (s.last.ok ? `<span class="ok-chip">✓ ${s.last.entries} entries, ${s.last.added} added, ${s.last.removed} removed at ${esc(fmtTime(s.last.at))}</span>` : `<span class="bad-chip">✗ ${esc(s.last.error)}</span>`) : "not synced yet"}</div>`).join("") || "No hotlist sources configured (config/hotlists.yaml).";
  } catch (_) {}
}

// ------------------------------------------------------------------ GIS map
let MAP = null;
const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#64748b", "#84cc16", "#06b6d4"];
const STATUS_COLOUR = { online: "#22c55e", live: "#22c55e", offline: "#ef4444", "not-integrated": "#64748b", registered: "#64748b", unknown: "#f59e0b", unlicensed: "#94a3b8" };
function mapColourer(key, cams) {
  if (key === "status") return { colour: (c) => STATUS_COLOUR[c.registry_only ? "not-integrated" : c.status] || "#f59e0b", legend: Object.entries(STATUS_COLOUR).filter(([k]) => k !== "live" && k !== "registered") };
  const vals = [...new Set(cams.map((c) => c[key] || "unspecified"))].sort();
  const fixed = { Police: "#3b82f6", Municipal: "#22c55e", Transport: "#f59e0b", Corp8: "#a855f7" };
  const m = Object.fromEntries(vals.map((v, i) => [v, fixed[v] || PALETTE[i % PALETTE.length]]));
  return { colour: (c) => m[c[key] || "unspecified"], legend: Object.entries(m) };
}
async function loadMap() {
  const data = await api("/api/map");
  if (!MAP) {
    MAP = L.map("gis-map", { zoomControl: true });
    MAP.tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    if ($("#map-tiles").checked) MAP.tiles.addTo(MAP);
    $("#map-tiles").onchange = (e) => e.target.checked ? MAP.tiles.addTo(MAP) : MAP.removeLayer(MAP.tiles);
    MAP.layer = L.layerGroup().addTo(MAP);
    MAP.gaps = L.layerGroup().addTo(MAP);
    MAP.marks = L.layerGroup().addTo(MAP);
    MAP.on("click", (e) => { if (!FENCE_PICK) nearestAt(e.latlng.lat, e.latlng.lng); });
    ["#map-colour", "#map-cones", "#map-registry-only"].forEach((s) => $(s).onchange = () => drawMap());
    $("#map-gaps").onchange = () => drawGaps();
  }
  MAP.data = data;
  drawMap(true);
  if ($("#map-gaps").checked) drawGaps();
  await loadRoutes();
  if ($("#map-route").value) showRoute($("#map-route").value);
  await loadFences();
}
function drawMap(fit = false) {
  const data = MAP.data;
  MAP.layer.clearLayers();
  const key = $("#map-colour").value, cones = $("#map-cones").checked, showReg = $("#map-registry-only").checked;
  const cams = data.cameras.filter((c) => showReg || !c.registry_only);
  const { colour, legend } = mapColourer(key, cams);
  $("#map-legend").innerHTML = legend.map(([k, v]) => `<span class="tagchip"><span class="cam-pin" style="background:${v};display:inline-block;width:10px;height:10px;margin-right:4px"></span>${esc(k)}</span>`).join(" ");
  const pts = [];
  cams.forEach((c) => {
    pts.push([c.lat, c.lon]);
    if (cones) L.polygon(c.coverage, { color: colour(c), weight: 1, fillOpacity: c.registry_only ? 0.08 : 0.18, dashArray: c.registry_only ? "4 3" : null }).addTo(MAP.layer);
    const meta = [c.camera_type, c.ownership, c.connectivity].filter(Boolean).join(" · ");
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<div class="cam-pin" style="background:${colour(c)};${c.registry_only ? "border-style:dashed" : ""}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
      .bindPopup(`<b>${esc(c.name)}</b><br>${esc(c.department)} · ${c.registry_only ? "registry only (no feed)" : esc(c.status)}${c.anpr_enabled ? " · ANPR" : ""}${meta ? `<br>${esc(meta)}` : ""}${c.install_date ? `<br>installed ${esc(c.install_date)}` : ""}${c.maintenance_status && c.maintenance_status !== "ok" ? `<br>maintenance: <b>${esc(c.maintenance_status)}</b>` : ""}<br>heading ${c.heading ?? "–"}° · fov ${c.fov ?? "–"}° · ${c.range_m ?? "–"} m<br>${c.registry_only ? `<button onclick="regEdit('${esc(c.id)}')" class="btn ghost small">Edit in registry</button>` : `<button onclick="mapWatch('${esc(c.id)}')" class="btn ghost small">Add to wall</button> <button onclick="regEdit('${esc(c.id)}')" class="btn ghost small">Registry</button>`}`).addTo(MAP.layer);
  });
  if (fit && pts.length) MAP.fitBounds(pts, { padding: [40, 40] });
  else if (!MAP._loaded) MAP.setView([23.03, 72.58], 11);          // Ahmedabad until cameras have coordinates
  $("#map-nearest").innerHTML = pts.length ? "" : '<span class="bad-chip">No camera has coordinates yet — open <a href="#" data-goto="registry">Registry</a>, Edit a camera and set latitude / longitude (or import a CSV with lat, lon).</span>';
  $$("#map-nearest [data-goto]").forEach((a) => a.onclick = (ev) => { ev.preventDefault(); show(a.dataset.goto); });
  setTimeout(() => MAP.invalidateSize(), 50);
}
async function drawGaps() {
  MAP.gaps.clearLayers();
  if (!$("#map-gaps").checked) return;
  const rep = await api("/api/registry/gaps?cell_m=100");
  const dlat = rep.cell_m / 111320, dlon = rep.cell_m / (111320 * Math.cos(((rep.bbox?.[0] ?? 23) * Math.PI) / 180));
  const cell = (g, colour, op, label) => L.rectangle([[g.lat - dlat / 2, g.lon - dlon / 2], [g.lat + dlat / 2, g.lon + dlon / 2]], { color: colour, weight: 0, fillOpacity: op })
    .bindTooltip(`${label} · nearest camera ${g.nearest_m ?? "?"} m (${esc(g.nearest_camera || "none")})`).addTo(MAP.gaps);
  (rep.blind_spots || []).forEach((g) => cell(g, "#ef4444", 0.45, "blind spot next to cameras"));
  rep.gaps.slice(0, 200).forEach((g) => cell(g, "#f59e0b", 0.25, "large uncovered zone"));
  toast(`${rep.near_coverage_pct}% covered within 300 m of cameras · ${rep.near_uncovered} blind spots (red) · ${rep.uncovered} uncovered ${rep.cell_m} m cells in all (largest 200 in amber)`, "ok");
}
window.mapWatch = (id) => { show("wall"); addToWall(id); };
async function nearestAt(lat, lon) {
  const r = await api(`/api/map/nearest?lat=${lat}&lon=${lon}&n=5`);
  MAP.marks.clearLayers();
  L.circleMarker([lat, lon], { radius: 7, color: "#ef4444", fillOpacity: 0.9 }).addTo(MAP.marks);
  $("#map-nearest").innerHTML = `Incident at ${lat.toFixed(5)}, ${lon.toFixed(5)}: ` + r.cameras.map((c) => `<span class="tagchip ${c.covers_point ? "watchlist" : ""}" title="${c.covers_point ? "point is inside this camera's coverage" : "nearby but not covering the point"}">${esc(c.name)} ${c.distance_m} m${c.covers_point ? " ✓" : ""}</span>`).join(" ");
}
// custom time range: list the segments between two times; play / download them as ONE combined video
const PB = { rec: null, busy: false };
const pb2 = (n) => String(n).padStart(2, "0");
const pbLocal = (d) => `${d.getFullYear()}-${pb2(d.getMonth() + 1)}-${pb2(d.getDate())}T${pb2(d.getHours())}:${pb2(d.getMinutes())}:${pb2(d.getSeconds())}`;
const pbUnix = (v) => Math.floor(new Date(v).getTime() / 1000);
const pbMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
function pbDur(sec) {
  sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return [h && `${h} h`, m && `${m} min`, (x || (!h && !m)) && `${x} s`].filter(Boolean).join(" ");
}
async function runPlayback(ev) {
  ev && ev.preventDefault();
  const f = $("#pb-form");
  if (!f.from.value || !f.to.value) return toast("Choose both a From and a To time");
  const a = pbUnix(f.from.value), b = pbUnix(f.to.value);
  if (!(b > a)) return toast("'To' must be later than 'From'");
  let r;
  try { r = await api(`/api/cameras/${encodeURIComponent(f.camera.value)}/recordings/range?from=${a}&to=${b}`); }
  catch (e) { return toast(e.message); }
  PB.rec = r;
  const cam = S.camById[r.camera_id]?.name || r.camera_id;
  $("#pb-title").textContent = `${r.count} recorded segments`;
  $("#pb-sub").textContent = `${cam} · ${fmtTime(r.from)} → ${fmtTime(r.to)}`;
  $("#pb-combined").classList.toggle("hidden", !r.count);
  $("#pb-summary").innerHTML = `<b>Recorded ${esc(pbDur(r.recorded_s))}</b> of the ${esc(pbDur(r.requested_s))} requested · about ${esc(pbMB(r.bytes))}`;
  $("#pb-gaps").textContent = r.gaps.length ? `Not recorded: ${r.gaps.slice(0, 4).map((g) => `${fmtTime(g.from)} for ${pbDur(g.seconds)}`).join("; ")}${r.gaps.length > 4 ? `; and ${r.gaps.length - 4} more` : ""}. The combined video joins the recorded parts back to back.` : "";
  $("#pb-table tbody").innerHTML = r.segments.map((x) => `<tr><td>${esc(fmtTime(x.start))}</td><td>${Math.round(x.duration_s)} s</td>
    <td>${(x.bytes / 1048576).toFixed(1)} MB</td><td><button type="button" class="btn ghost small" data-url="${esc(x.url)}" data-start="${esc(x.start)}">Play</button></td></tr>`).join("")
    || '<tr><td colspan="4" class="muted">No recording for this camera in that time range. Recording only runs for cameras selected by RECORD_MODE (default: ANPR cameras), and the latest minute or two may not be archived yet.</td></tr>';
  $$("[data-url]", $("#pb-table")).forEach((b) => b.onclick = () => playArchive(b.dataset.url, `${cam} · ${fmtTime(b.dataset.start)}`));
}
async function pbCombined(mode) {
  const r = PB.rec;
  if (!r || PB.busy) return;
  const base = `/api/cameras/${encodeURIComponent(r.camera_id)}/recordings`;
  const btns = [$("#pb-play-all"), $("#pb-download-all")], prog = $("#pb-progress");
  PB.busy = true; btns.forEach((b) => b.disabled = true); prog.textContent = "Preparing video… queued";
  try {
    let j = await api(`${base}/combine`, { method: "POST", body: JSON.stringify({ from: r.from_unix, to: r.to_unix }) });
    const name = j.name;
    while (j.status === "queued" || j.status === "building") {
      prog.textContent = `Preparing video… ${j.status === "queued" ? "queued" : (j.progress || 0) + "%"}`;
      await new Promise((ok) => setTimeout(ok, 1500));
      j = await api(`${base}/combined/${name}/status`);
    }
    if (j.status !== "ready") throw new Error(j.error || "Could not prepare the combined video");
    if (mode === "download") {
      const a = document.createElement("a");
      a.href = withTok(j.download_url); a.download = j.filename; document.body.appendChild(a); a.click(); a.remove();
      toast(`Downloading ${j.filename} (${pbMB(j.bytes)})`, "ok");
    } else {
      playArchive(j.url, `${S.camById[r.camera_id]?.name || r.camera_id} · ${fmtTime(r.from)} → ${fmtTime(r.to)} · ${pbDur(j.duration_s)}`,
        has("export") ? { url: j.download_url, filename: j.filename } : null);
    }
  } catch (e) { toast(e.message); }
  finally { PB.busy = false; btns.forEach((b) => b.disabled = false); prog.textContent = ""; }
}
function bindPlates(root) {
  $$("[data-plate]", root).forEach((el) => el.onclick = () => traceVehicle(el.dataset.plate));
  $$("img[data-frame]", root).forEach((el) => el.onclick = () => modal(`<img src="${esc(withTok(el.dataset.frame))}" alt="Evidence frame">`));
}
function exportCsv() {
  // server-side export: signed manifest + Ed25519 signature travel with the CSV, and the export is audited
  const f = $("#search-form");
  const p = new URLSearchParams({ plate: f.plate.value.trim(), camera: [...f.camera.selectedOptions].map((o) => o.value).filter(Boolean).join(","), tag: f.tag.value });
  if (f.since.value) p.set("since", toIso(f.since.value));
  if (f.until.value) p.set("until", toIso(f.until.value));
  location.href = withTok(`/api/events/export.csv?${p}`);
}

// ------------------------------------------------------------------ vehicle movement
function traceVehicle(plate) { show("movement"); $("#move-form").plate.value = plate; runMovement(); window.scrollTo({ top: 0, behavior: "smooth" }); }

// ------------------------------------------------------------------ vehicles seen on several cameras
let MULTI = { items: [], bound: false };
const fmtDay = (iso) => new Date(iso).toLocaleString("en-IN", { ...IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
async function loadMulti() {
  const f = $("#multi-form"); if (!f) return;
  const loc = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const applyPreset = () => {
    const v = f.preset.value, now = new Date(); let lo, hi = now;
    $("#multi-year-l").classList.toggle("hidden", v !== "year");
    if (v === "custom") return;
    if (v.endsWith("h")) lo = new Date(now.getTime() - parseInt(v) * 3600 * 1000);
    else if (v.endsWith("d")) lo = new Date(now.getTime() - parseInt(v) * 86400 * 1000);
    else if (v === "ytd") lo = new Date(now.getFullYear(), 0, 1);
    else if (v === "lastyear") { lo = new Date(now.getFullYear() - 1, 0, 1); hi = new Date(now.getFullYear(), 0, 1); }
    else if (v === "year") { const y = +f.year.value || now.getFullYear(); lo = new Date(y, 0, 1); hi = y === now.getFullYear() ? now : new Date(y + 1, 0, 1); }
    f.since.value = loc(lo); f.until.value = loc(hi);
  };
  if (!MULTI.bound) {
    MULTI.bound = true;
    const y0 = new Date().getFullYear();
    f.year.innerHTML = [0, 1, 2, 3, 4, 5].map((i) => `<option value="${y0 - i}">${y0 - i}</option>`).join("");
    f.preset.onchange = () => { applyPreset(); loadMulti(); };
    f.year.onchange = () => { applyPreset(); loadMulti(); };
    f.since.onchange = f.until.onchange = () => { f.preset.value = "custom"; $("#multi-year-l").classList.add("hidden"); };
    applyPreset();
    $("#multi-run").onclick = () => loadMulti();
    $("#multi-csv").onclick = () => {
      const rows = [["plate", "cameras", "seen_at", "first_seen", "last_seen", "span_min", "sightings"], ...MULTI.items.map((x) => [x.plate, x.camera_count, x.cameras.map((c) => c.name).join(" > "), x.first_seen, x.last_seen, x.span_min, x.sightings])];
      const blob = new Blob([rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `multi-camera-vehicles-${f.since.value}.csv`; a.click();
    };
  }
  const sel = f.cameras; const keep = [...sel.selectedOptions].map((o) => o.value);
  sel.innerHTML = (await allCameras()).map((c) => `<option value="${esc(c.id)}" ${keep.includes(c.id) ? "selected" : ""}>${esc(c.name)} (${esc(c.department)})</option>`).join("");
  const q = new URLSearchParams({ min_cameras: f.min_cameras.value, limit: 500 });
  if (f.since.value) q.set("since", toIso(f.since.value)); if (f.until.value) q.set("until", toIso(f.until.value));
  if (keep.length) q.set("cameras", keep.join(",")); if (f.vehicle_type.value) q.set("vehicle_type", f.vehicle_type.value); if (f.plate.value.trim()) q.set("plate", f.plate.value.trim());
  const tb = $("#multi-table tbody"); tb.innerHTML = '<tr><td colspan="8" class="muted">searching…</td></tr>';
  let r; try { r = await api(`/api/vehicles/multi-camera?${q}`); } catch (e) { tb.innerHTML = `<tr><td colspan="8" class="bad-chip">${esc(e.message)}</td></tr>`; return; }
  MULTI.items = r.items;
  $("#multi-sub").textContent = `${r.total} vehicle${r.total === 1 ? "" : "s"} on ${keep.length ? "all " + keep.length + " selected cameras" : "≥ " + r.min_cameras + " cameras"} · ${fmtDay(r.since)} → ${fmtDay(r.until)}`;
  const span = (m) => m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  tb.innerHTML = r.items.map((x) => `<tr><td><span class="platebox plate" data-plate="${esc(x.plate)}">${esc(x.plate)}</span></td><td><b>${x.camera_count}</b></td>
    <td class="route-cams">${x.cameras.map((c, i) => `<span class="rc" title="${esc(c.department)} · ${c.sightings} sighting${c.sightings === 1 ? "" : "s"} · ${esc(fmtTime(c.first))}"><span class="n">${i + 1}</span>${esc(c.name)}</span>`).join(" ")}</td>
    <td class="small">${esc(fmtTime(x.first_seen))}</td><td class="small">${esc(fmtTime(x.last_seen))}</td><td>${span(x.span_min)}</td><td>${x.sightings}</td>
    <td>${x.plate_masked ? "" : `<button class="btn ghost small" data-trace="${esc(x.plate)}">Trace</button>`}</td></tr>`).join("")
    || '<tr><td colspan="8" class="muted">No vehicle was read on that many cameras in this window. Widen the time range, or lower "At least".</td></tr>';
  $("#multi-more").textContent = r.truncated ? `Showing the first ${r.items.length} of ${r.total} vehicles (most cameras first). Narrow the period, raise "At least", or tick cameras to see the rest; CSV exports what is shown.` : "";
  $$("[data-trace]", tb).forEach((b) => b.onclick = () => traceVehicle(b.dataset.trace));
  bindPlates(tb);
}
async function runMovement(ev) {
  ev && ev.preventDefault();
  const f = $("#move-form");
  const q = new URLSearchParams({ fuzzy: f.fuzzy.checked });
  if (f.since.value) q.set("since", toIso(f.since.value));
  const r = await api(`/api/vehicles/${encodeURIComponent(f.plate.value.trim())}/movements?${q}`);
  const pts = r.sightings;
  $("#move-title").innerHTML = `Route of <span class="platebox plate">${esc(r.plate)}</span>`;
  $("#move-sub").textContent = `${pts.length} sightings · ${r.cameras.length} cameras · ${r.departments.join(" + ") || "no departments"}`;
  $("#move-list").innerHTML = pts.map((p, i) => `<li><span class="n">${i + 1}</span>
    <div><b>${esc(p.camera_name)}</b> <span class="dept-${esc(p.department)} small">${esc(p.department)}</span><br>
    <span class="small muted">${esc(fmtTime(p.ts))} · ${esc(p.direction)} · ${Math.round(p.confidence * 100)}%${p.plate !== r.plate ? ` · read as ${esc(p.plate)}` : ""}</span></div>
    ${p.crop_url ? `<img src="${esc(withTok(p.crop_url))}" data-frame="${esc(p.frame_url)}" alt="">` : ""}</li>`).join("")
    || '<li class="muted">No sightings.</li>';
  bindPlates($("#move-list"));
  drawRoute(pts);
}
function drawRoute(pts) {
  const el = $("#move-map");
  const cams = S.cameras.filter((c) => c.lat != null);
  if (!cams.length) { el.innerHTML = '<p class="muted" style="padding:12px">Camera locations are not configured.</p>'; return; }
  const W = 800, H = 460, P = 50;
  const lats = cams.map((c) => c.lat), lons = cams.map((c) => c.lon);
  const [a0, a1, o0, o1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const x = (lon) => P + ((lon - o0) / (o1 - o0 || 1)) * (W - 2 * P);
  const y = (lat) => H - P - ((lat - a0) / (a1 - a0 || 1)) * (H - 2 * P);
  const route = pts.filter((p) => p.lat != null);
  const seg = route.slice(1).map((p, i) => `<line x1="${x(route[i].lon)}" y1="${y(route[i].lat)}" x2="${x(p.lon)}" y2="${y(p.lat)}" stroke="#f59e0b" stroke-width="3" marker-end="url(#arr)" opacity=".9"/>`).join("");
  const nums = route.map((p, i) => `<g><circle cx="${x(p.lon) + 16 + (i % 3) * 4}" cy="${y(p.lat) - 16 - (i % 3) * 4}" r="10" fill="#3b82f6"/><text x="${x(p.lon) + 16 + (i % 3) * 4}" y="${y(p.lat) - 12 - (i % 3) * 4}" text-anchor="middle" font-size="11" fill="#fff" font-weight="700">${i + 1}</text></g>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f59e0b"/></marker></defs>
    ${cams.map((c) => `<g><circle cx="${x(c.lon)}" cy="${y(c.lat)}" r="7" fill="${c.department === "Police" ? "#60a5fa" : "#a78bfa"}" stroke="#0d1117" stroke-width="2"/>
      <text x="${x(c.lon)}" y="${y(c.lat) + 22}" text-anchor="middle" font-size="11" fill="#8b98a8">${esc(c.name)}</text></g>`).join("")}
    ${seg}${nums}
    <g font-size="11" fill="#8b98a8"><circle cx="16" cy="16" r="6" fill="#60a5fa"/><text x="28" y="20">Police camera</text><circle cx="130" cy="16" r="6" fill="#a78bfa"/><text x="142" y="20">Municipal camera</text></g></svg>`;
}

// ------------------------------------------------------------------ alerts / watchlist / sources / audit
async function loadAlerts() {
  const rows = await api(`/api/alerts?open_only=${$("#alerts-open").checked}&limit=1000`);
  $("#alerts-table tbody").innerHTML = rows.map((a) => `<tr>
    <td>${esc(fmtTime(a.ts))}</td><td><span class="platebox plate" data-plate="${esc(a.plate)}">${esc(a.plate)}</span></td>
    <td>${a.crop_url ? `<img class="crop" src="${esc(withTok(a.crop_url))}" alt="">` : ""}</td><td class="plate">${esc(a.watchlist_plate)}</td>
    <td>${esc(a.match)}</td><td>${esc(S.camById[a.camera_id]?.name || a.camera_id)}</td><td>${esc(a.reason)}</td>
    <td>${a.ack_by ? `acknowledged by ${esc(a.ack_by)}` : can("supervisor") ? `<button class="btn small" data-ack="${esc(a.id)}">Acknowledge</button>` : "open"}</td></tr>`).join("")
    || '<tr><td colspan="8" class="muted">No alerts.</td></tr>';
  bindPlates($("#alerts-table"));
  $$("[data-ack]").forEach((b) => b.onclick = async () => { await api(`/api/alerts/${b.dataset.ack}/ack`, { method: "POST" }); refreshAlertBadge(); loadAlerts(); });
}
async function loadWatchlist() {
  loadHotlists();
  loadPersons();
  const rows = await api("/api/watchlist");
  $("#watch-table tbody").innerHTML = rows.map((w) => `<tr><td><span class="platebox plate" data-plate="${esc(w.plate)}">${esc(w.plate)}</span></td>
    <td>${esc(w.reason)}</td><td>${esc(w.priority)}</td><td>${esc(w.added_by)}</td><td>${w.expires_at ? esc(fmtTime(w.expires_at)) : "never"}</td>
    <td>${can("supervisor") ? `<button class="btn small danger" data-del="${esc(w.plate)}">Remove</button>` : ""}</td></tr>`).join("")
    || '<tr><td colspan="6" class="muted">Watchlist is empty.</td></tr>';
  bindPlates($("#watch-table"));
  $$("[data-del]").forEach((b) => b.onclick = async () => { await api(`/api/watchlist/${b.dataset.del}`, { method: "DELETE" }); loadWatchlist(); });
}
async function addWatch(ev) {
  ev.preventDefault(); const f = new FormData(ev.target);
  try {
    const r = await api("/api/watchlist", { method: "POST", body: JSON.stringify({ plate: f.get("plate"), reason: f.get("reason"), priority: f.get("priority"), days: +f.get("days") }) });
    toast(`${r.plate} added to watchlist`, "ok"); ev.target.reset(); loadWatchlist();
  } catch (e) { toast(e.message); }
}
async function loadSources() {
  loadDevices();
  const rows = await api("/api/sources");
  $("#source-cards").innerHTML = rows.map((s) => `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center"><b class="dept-${esc(s.department)}">${esc(s.department)}</b><span><span class="dot ${s.status === "ok" ? "ok" : "off"}"></span> ${esc(s.status)}</span></div>
    <div><b>${esc(s.name)}</b></div>
    <div class="row"><span>Integration</span><b>${esc(s.adapter)}</b></div>
    <div class="row"><span>Cameras</span><b>${s.cameras}</b></div>
    <div class="row"><span>Streams pulled now / cap</span><b>${s.active_pulls} / ${s.max_concurrent_pulls}</b></div>
    <div class="meter"><i style="width:${Math.min(100, (100 * s.active_pulls) / s.max_concurrent_pulls)}%"></i></div>
    <div class="row"><span>Viewers served by relay</span><b>${s.viewers}</b></div>
    <div class="small muted">${esc(s.detail)}${s.checked_at ? ` · checked ${esc(fmtTime(s.checked_at))}` : ""}</div>
    ${s.adapter === "rtsp_template" && has("admin") ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost small" data-scan="${esc(s.id)}" title="Probe the next channel numbers on this gateway / NVR and add the cameras that answer">Find new cameras</button><button class="btn ghost small" data-autoscan="${esc(s.id)}" title="Check for new channels every hour and add them automatically">Auto-add: …</button></div>` : ""}</div>`).join("")
    || '<p class="muted">No sources yet. The adapter service registers them on start.</p>';
  $$("[data-scan]").forEach((b) => b.onclick = () => scanSource(b.dataset.scan));
  $$("[data-autoscan]").forEach(async (b) => {
    try { const d = await api(`/api/sources/${b.dataset.autoscan}/channels`); b.textContent = `Auto-add new cameras: ${d.auto_scan ? "ON" : "OFF"}`; b.dataset.on = d.auto_scan ? "1" : "0"; } catch (_) {}
    b.onclick = async () => { try { const d = await api(`/api/sources/${b.dataset.autoscan}/auto-scan`, { method: "PUT", body: JSON.stringify({ channels: 1, auto_scan: b.dataset.on !== "1" }) }); b.textContent = `Auto-add new cameras: ${d.auto_scan ? "ON" : "OFF"}`; b.dataset.on = d.auto_scan ? "1" : "0"; toast(d.auto_scan ? "New channels will be added automatically (checked hourly, one probe at a time)" : "Automatic channel discovery off", "ok"); } catch (e) { toast(e.message, "err"); } };
  });
  loadSla();
  try {
    const cap = await api("/api/capacity");
    $("#cap-sub").textContent = `relays: ${Object.entries(cap.relays).map(([n, r]) => `${n} ${r.healthy ? "✓" : "✗"}`).join(", ")} · record mode ${cap.record_mode}`;
    $("#cap-table tbody").innerHTML = cap.departments.map((d) => `<tr><td><span class="dept-${esc(d.department)}">${esc(d.department)}</span></td><td>${d.online}/${d.cameras}</td><td>${d.anpr_channels}</td><td>${d.recorded}</td>
      <td>${d.pulls}/${d.pull_cap}</td><td>${d.viewers}</td><td>${d.events_24h}</td><td>${d.archive_gb} GB (+${d.archive_gb_per_day}/day, est. ${d.storage_estimate_gb_per_day}/day)</td><td class="small">${esc(Object.entries(d.relays).map(([r, n]) => `${r}: ${n}`).join(", "))}</td></tr>`).join("") || '<tr><td colspan="9" class="muted">No cameras.</td></tr>';
  } catch (_) {}
  try {
    const a = await api("/api/archive/stats");
    $("#archive-sub").textContent = `${a.storage} · record mode: ${a.record_mode}`;
    $("#archive-table tbody").innerHTML = a.departments.map((d) => `<tr><td><span class="dept-${esc(d.department)}">${esc(d.department)}</span></td>
      <td>${d.segments}</td><td>${(d.bytes / 1073741824).toFixed(2)} GB</td><td>${d.clips}</td><td>${d.from ? esc(fmtTime(d.from)) : "–"}</td><td>${d.to ? esc(fmtTime(d.to)) : "–"}</td></tr>`).join("")
      || '<tr><td colspan="6" class="muted">Nothing archived yet.</td></tr>';
  } catch (_) {}
}
async function loadSla() {
  try {
    const r = await api(`/api/health/sla?days=${$("#sla-days").value}`);
    $("#sla-sub").textContent = `fleet uptime ${r.fleet_uptime_pct}% over ${r.days} day(s)`;
    $("#sla-table tbody").innerHTML = r.cameras.map((c) => `<tr><td>${esc(c.name)}</td><td><span class="dept-${esc(c.department)}">${esc(c.department)}</span></td><td><span class="dot ${c.status === "offline" ? "off" : "ok"}"></span> ${esc(c.status)}</td>
      <td><b>${c.uptime_pct}%</b></td><td>${c.outages}</td><td>${c.downtime_min} min</td><td>${c.longest_outage_min} min</td>
      <td>${c.quality ? `<span class="${c.quality.verdict === "ok" ? "ok-chip" : "bad-chip"}">${esc(c.quality.verdict)}</span> <span class="muted small">sharp ${c.quality.sharpness} · bright ${c.quality.brightness}</span>` : '<span class="muted">no sample yet</span>'}</td>
      <td>${c.sla_met ? '<span class="ok-chip">✓</span>' : '<span class="bad-chip">✗</span>'}</td></tr>`).join("") || '<tr><td colspan="9" class="muted">No cameras.</td></tr>';
  } catch (_) {}
}
async function verifyAudit() {
  const v = await api("/api/audit/verify");
  $("#audit-chain").innerHTML = v.ok ? `<span class="ok-chip">✓ chain intact (${v.rows} rows)</span>` : `<span class="bad-chip">✗ chain broken at row ${v.first_bad_id}</span>`;
  toast(v.ok ? "Audit chain verified" : "Audit chain broken: possible tampering", v.ok ? "ok" : "err");
}

// ------------------------------------------------------------------ break-glass
function renderBreakGlassBanner() {
  const b = $("#bg-banner");
  if (!S.user.break_glass) return b.classList.add("hidden");
  b.classList.remove("hidden");
  b.innerHTML = `<span>⚠ Break-glass access active for ${esc(S.user.username)}: every action is audited and admins have been notified.</span><button class="btn ghost small" id="bg-end">End now</button>`;
  $("#bg-end").onclick = async () => { const j = await api("/api/auth/break-glass/end", { method: "POST" }); setSession(j); location.reload(); };
}
function breakGlassDialog() {
  modal(`<h3>Break-glass access</h3><p class="muted">Grants all departments and playback/export for a limited time. Your justification is recorded in the tamper-evident audit log and administrators are alerted immediately.</p>
    <form id="bg-form" class="search-form"><label style="flex:1">Justification <input name="reason" required minlength="10" placeholder="e.g. hit-and-run pursuit, FIR 123/2026"></label><button class="btn danger">Activate</button></form>`);
  $("#bg-form").onsubmit = async (ev) => { ev.preventDefault();
    try { const j = await api("/api/auth/break-glass", { method: "POST", body: JSON.stringify({ reason: ev.target.reason.value }) }); setSession(j); closeModal(); location.reload(); }
    catch (e) { toast(e.message, "err"); } };
}

// ------------------------------------------------------------------ admin
async function loadAdmin() {
  const [c, users, grants, holds] = await Promise.all([api("/api/compliance/status"), api("/api/admin/users"), api("/api/admin/grants"), api("/api/admin/holds")]);
  const chip = (ok, txt) => `<span class="${ok ? "ok-chip" : "bad-chip"}">${ok ? "✓" : "✗"} ${esc(txt)}</span>`;
  const lic = S.license || await api("/api/license");
  $("#compliance-cards").innerHTML = `
    <div class="card"><b>${t("license.title", "Licence")} · v${esc(lic.version)}</b><div class="kv"><span>Customer</span><span>${esc(lic.customer)}</span><span>Mode</span>${chip(lic.mode === "licensed", lic.status)}<span>Cameras</span>${chip(!lic.over_limit.cameras, `${lic.usage.cameras_total} / ${lic.limits.cameras ?? "∞"}`)}<span>ANPR channels</span>${chip(!lic.over_limit.anpr_channels, `${lic.usage.anpr_channels} / ${lic.limits.anpr_channels ?? "∞"}`)}<span>Analytics channels</span>${chip(!lic.over_limit.analytics_channels, `${lic.usage.analytics_channels} / ${lic.limits.analytics_channels ?? "∞"}`)}<span>Expires</span><span>${esc(lic.expires || "–")}</span></div></div>` + `
    <div class="card"><b>Identity</b><div class="kv"><span>Local users</span>${chip(true, c.identity.local ? "on" : "off")}<span>LDAP / AD</span>${chip(c.identity.ldap, c.identity.ldap ? "on" : "off")}<span>SSO (OIDC)</span>${chip(c.identity.oidc, c.identity.oidc ? "on" : "off")}<span>2FA required</span><span>${esc(c.identity.mfa_required_roles.join(", ") || "none (set mfa.required_roles)")}</span><span>Lockout</span><span>${c.identity.lockout.failures} failures / ${c.identity.lockout.seconds}s</span></div></div>
    <div class="card"><b>Audit & retention</b><div class="kv"><span>Hash chain</span>${chip(c.audit.hash_chain.ok, c.audit.hash_chain.ok ? `intact, ${c.audit.hash_chain.rows} rows` : "BROKEN")}<span>Audit retention</span>${chip(c.audit.certin_180_days, `${c.audit.retention_days} days (CERT-In ≥180)`)}<span>Events</span><span>${c.retention.default.events_days} d</span><span>Clips / crops</span><span>${c.retention.default.clips_days} / ${c.retention.default.crops_days} d</span><span>Recordings</span><span>${c.retention.default.recordings_days} d</span><span>Legal holds</span><span>${c.legal_holds_active}</span></div></div>
    <div class="card"><b>Data protection</b><div class="kv"><span>Plate masking</span>${chip(c.pii.mask_plates, c.pii.mask_plates ? "on" : "off")}<span>Face blur in frames</span>${chip(c.pii.blur_faces, c.pii.blur_faces ? "on" : "off")}<span>Object storage encryption</span>${chip(!String(c.encryption.object_storage_sse).startsWith("none"), c.encryption.object_storage_sse)}<span>TLS proxy</span>${chip(c.encryption.tls_proxy, c.encryption.tls_proxy ? "on" : "off (see deploy/tls)")}<span>Secrets</span><span>${esc(c.encryption.secrets)}</span><span>Exports</span>${chip(true, "signed + watermarked")}</div></div>`;
  const su = !!S.user.is_super;
  $("#user-form").classList.toggle("hidden", !su);
  $("#users-sub").textContent = su ? "You are a super admin: create users here; deactivate keeps the account for audit, remove deletes it with its 2FA state"
                                   : "Accounts are created by a super admin; directory (LDAP/SSO) users appear after first login";
  $("#users-table tbody").innerHTML = users.map((u) => `<tr class="${u.is_active === false ? "muted" : ""}"><td>${esc(u.username)}${u.is_super ? ' <span class="ok-chip">super</span>' : ""}${u.is_active === false ? ' <span class="bad-chip">inactive</span>' : ""}</td><td>${esc(u.provider)}</td><td>${esc(u.role)}</td><td>${(u.departments || []).length ? esc(u.departments.join(", ")) : '<span class="muted">no department</span>'}${(u.cameras || []).length ? `<div class="small muted">${u.cameras.length} camera${u.cameras.length === 1 ? "" : "s"}: ${esc(u.cameras.map((id) => S.camById[id]?.name || id).slice(0, 4).join(", "))}${u.cameras.length > 4 ? "…" : ""}</div>` : ""}</td>
    <td>${u.mfa_enrolled ? '<span class="ok-chip">enrolled</span>' : (u.mfa_required ? '<span class="bad-chip">required</span>' : "–")}</td><td>${u.last_login ? esc(fmtTime(u.last_login)) : "–"}${u.locked_until ? ' <span class="bad-chip">locked</span>' : ""}</td><td>${u.active_grants}</td>
    <td>${u.locked_until ? `<button class="btn ghost small" data-unlock="${esc(u.username)}">Unlock</button> ` : ""}${u.mfa_enrolled ? `<button class="btn ghost small" data-mfareset="${esc(u.username)}">Reset 2FA</button> ` : ""}${su && u.provider === "db" ? `<button class="btn ghost small" data-user-access="${esc(u.username)}" title="Departments, cameras and role this account may use">Access</button> ` : ""}${su && u.provider === "db" && u.username !== S.user.username ? `<button class="btn ghost small" data-user-active="${esc(u.username)}" data-active="${u.is_active !== false}">${u.is_active === false ? "Activate" : "Deactivate"}</button> <button class="btn ghost small" data-user-pw="${esc(u.username)}">Set password</button> <button class="btn ghost small" data-user-del="${esc(u.username)}">Remove</button>` : ""}</td></tr>`).join("");
  $("#grants-table tbody").innerHTML = grants.map((g) => `<tr class="${g.kind === "break_glass" ? "row-bg" : ""}"><td>${esc(g.username)}</td><td>${esc(g.kind)}</td><td>${esc(g.value)}</td><td>${esc(g.reason)}</td><td>${esc(g.granted_by)}</td><td>${g.expires_at ? esc(fmtTime(g.expires_at)) : "never"}</td><td><button class="btn ghost small" data-revoke="${esc(g.id)}">Revoke</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No active grants.</td></tr>';
  $("#holds-table tbody").innerHTML = holds.map((h) => `<tr><td>${esc(h.kind)}</td><td>${esc(h.value)}</td><td>${esc(h.reference)}</td><td>${esc(h.reason)}</td><td>${esc(h.created_by)}</td><td>${esc(fmtTime(h.created_at))}</td><td><button class="btn ghost small" data-release="${esc(h.id)}">Release</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No legal holds.</td></tr>';
  loadIntegrations();
  loadRoles();
  loadArchival();
  loadIntegrationsCfg();
  loadPerms();
  adminSection(ADMIN_SEC);
  $$("[data-unlock]").forEach((b) => b.onclick = () => api(`/api/admin/users/${b.dataset.unlock}/unlock`, { method: "POST" }).then(loadAdmin));
  $$("[data-mfareset]").forEach((b) => b.onclick = () => api(`/api/auth/mfa/reset/${b.dataset.mfareset}`, { method: "POST" }).then(loadAdmin));
  $$("[data-user-active]").forEach((b) => b.onclick = () => api(`/api/users/${b.dataset.userActive}`, { method: "PATCH", body: JSON.stringify({ is_active: b.dataset.active !== "true" }) }).then(loadAdmin).catch((e) => toast(e.message, "err")));
  $$("[data-user-access]").forEach((b) => b.onclick = () => userAccessDialog(users.find((x) => x.username === b.dataset.userAccess)));
  const camSel = $("#user-cameras");
  if (camSel && !camSel.options.length) allCameras().then((cams) => cams.forEach((c) => camSel.add(new Option(`${c.name} (${c.department})`, c.id))));
  $$("[data-user-pw]").forEach((b) => b.onclick = () => { const pw = prompt(`New password for ${b.dataset.userPw} (min 10 chars, 1 uppercase, 1 digit):`); if (pw) api(`/api/users/${b.dataset.userPw}`, { method: "PATCH", body: JSON.stringify({ password: pw }) }).then(() => toast("Password set", "ok")).catch((e) => toast(e.message, "err")); });
  $$("[data-user-del]").forEach((b) => b.onclick = () => { if (confirm(`Remove account ${b.dataset.userDel}? Its 2FA enrolment and grants are deleted too.`)) api(`/api/users/${b.dataset.userDel}`, { method: "DELETE" }).then(loadAdmin).catch((e) => toast(e.message, "err")); });
  $$("[data-revoke]").forEach((b) => b.onclick = () => api(`/api/admin/grants/${b.dataset.revoke}`, { method: "DELETE" }).then(loadAdmin));
  $$("[data-release]").forEach((b) => b.onclick = () => api(`/api/admin/holds/${b.dataset.release}`, { method: "DELETE" }).then(loadAdmin));
}
async function createUser(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const departments = String(f.get("departments") || "*").split(",").map((x) => x.trim()).filter(Boolean);
  try {
    const cameras = [...ev.target.cameras.selectedOptions].map((o) => o.value);
    const deptRaw = String(f.get("departments") || "").trim().toLowerCase();
    const u = await api("/api/users", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password"), role: f.get("role"),
      departments: ["none", "-", ""].includes(deptRaw) ? [] : departments, cameras, is_super: !!f.get("is_super") }) });
    toast(`User ${u.username} created (${u.role}). They can enable 2FA with the 2FA button after signing in.`, "ok");
    ev.target.reset(); ev.target.departments.value = "*";
    loadAdmin();
  } catch (e) { toast(e.message, "err"); }
}
let NOTIFY = null;
const ROUTE_LABELS = { alert: "Watchlist / challan alert", incident: "Analytics incident", "camera.health": "Camera offline / online", break_glass: "Break-glass access", challan: "Challan approved", report: "Scheduled report", "*": "Every event" };
function renderRoutes(routes) {
  const tb = $("#routes-table tbody"); if (!tb) return;
  const chans = (NOTIFY?.channels || []);
  const kinds = NOTIFY?.kinds || Object.keys(ROUTE_LABELS);
  tb.innerHTML = routes.map((r, i) => `<tr data-i="${i}" class="${r.enabled === false ? "muted" : ""}">
    <td><select data-f="kind">${kinds.map((k) => `<option value="${esc(k)}" ${r.kind === k ? "selected" : ""}>${esc(ROUTE_LABELS[k] || k)}</option>`).join("")}</select></td>
    <td><select data-f="priority" title="priority"><option value="">any priority</option>${["critical", "high", "medium", "low"].map((p) => `<option ${(Array.isArray(r.priority) ? r.priority.includes(p) : r.priority === p) ? "selected" : ""}>${p}</option>`).join("")}</select>
        <select data-f="subkind" title="alert type"><option value="">any type</option>${["exact", "fuzzy", "rule"].map((x) => `<option ${r.subkind === x ? "selected" : ""}>${x}</option>`).join("")}</select>
        <input data-f="departments" placeholder="all departments" value="${esc((r.departments || []).join(", "))}" style="width:130px" title="departments, comma separated"></td>
    <td><select data-f="channel">${chans.map((c) => `<option value="${esc(c.name)}" ${r.channel === c.name ? "selected" : ""}>${esc(c.name)} (${esc(c.type)}${c.enabled ? "" : ", off"})</option>`).join("")}</select></td>
    <td><input data-f="to" value="${esc((r.to || []).join(", "))}" placeholder="98XXXXXXXX, 97XXXXXXXX" style="min-width:260px"></td>
    <td><input type="checkbox" data-f="enabled" ${r.enabled === false ? "" : "checked"}></td>
    <td><button class="btn ghost small" data-route-del="${i}" title="Remove this route">✕</button></td></tr>`).join("") || '<tr><td colspan="6" class="muted">No routes — nobody is notified. Add one.</td></tr>';
  $$("[data-route-del]", tb).forEach((b) => b.onclick = () => { const rs = collectRoutes(); rs.splice(+b.dataset.routeDel, 1); renderRoutes(rs); });
}
function collectRoutes() {
  return $$("#routes-table tbody tr[data-i]").map((tr) => {
    const v = (f) => $(`[data-f="${f}"]`, tr);
    const split = (s) => String(s || "").split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    return { kind: v("kind").value, priority: v("priority").value, subkind: v("subkind").value, departments: split(v("departments").value), channel: v("channel").value, to: split(v("to").value), enabled: v("enabled").checked };
  });
}
async function saveRoutes() {
  try { const r = await api("/api/admin/notifications/routes", { method: "PUT", body: JSON.stringify({ routes: collectRoutes() }) }); toast(`${r.routes.length} route${r.routes.length === 1 ? "" : "s"} saved — applies to the next event`, "ok"); loadIntegrations(); }
  catch (e) { toast(e.message, "err"); }
}
async function loadIntegrations() {
  const [keys, hooks, notif, tenants, vendors] = await Promise.all([api("/api/admin/api-keys"), api("/api/admin/webhooks"), api("/api/admin/notifications?limit=500"), api("/api/tenants"), api("/api/admin/vendors")]);
  $("#keys-table tbody").innerHTML = keys.map((k) => `<tr class="${k.revoked ? "muted" : ""}"><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc((k.features || []).join(", "))}</td><td>${esc((k.departments || []).join(", "))}</td><td>${k.expires_at ? esc(fmtTime(k.expires_at)) : "never"}</td><td>${k.last_used ? esc(fmtTime(k.last_used)) : "–"}</td><td>${k.revoked ? "revoked" : `<button class="btn ghost small" data-key-rev="${esc(k.id)}">Revoke</button>`}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No API keys.</td></tr>';
  $("#hooks-table tbody").innerHTML = hooks.webhooks.map((w) => `<tr class="${w.active ? "" : "muted"}"><td>${esc(w.name)}</td><td class="small">${esc(w.url)}</td><td>${esc((w.kinds || []).join(", "))}</td><td>${esc((w.departments || []).join(", "))}</td><td class="small">${esc(w.last_status || "–")}${w.last_delivery ? `<br>${esc(fmtTime(w.last_delivery))}` : ""}</td><td>${w.failures}</td>
    <td><button class="btn ghost small" data-hook-test="${esc(w.id)}">Test</button> <button class="btn ghost small" data-hook-toggle="${esc(w.id)}" data-active="${w.active}">${w.active ? "Disable" : "Enable"}</button> <button class="btn ghost small" data-hook-del="${esc(w.id)}">✕</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No webhooks.</td></tr>';
  NOTIFY = notif;
  $("#notif-sub").innerHTML = `${notif.channels.map((c) => `<span class="tagchip ${c.enabled ? "" : "muted"}" title="${esc(c.type)}">${esc(c.name)} · ${esc(c.type)}${c.configured ? "" : " · not configured"}</span> <button class="btn ghost small" data-chan-toggle="${esc(c.name)}" data-on="${c.enabled ? 1 : 0}">${c.enabled ? "Turn off" : "Turn on"}</button> <button class="btn ghost small" data-notif-test="${esc(c.name)}" data-type="${esc(c.type)}" title="Send a test ${esc(c.type === "voice" ? "call" : "message")} through this channel">Test</button>`).join(" &nbsp; ") || "no channels in config/notify.yaml"}`;
  $$("[data-chan-toggle]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/admin/notifications/channels/${encodeURIComponent(b.dataset.chanToggle)}`, { method: "PATCH", body: JSON.stringify({ enabled: b.dataset.on !== "1" }) }); toast(`${b.dataset.chanToggle} ${b.dataset.on === "1" ? "switched off" : "switched on"}`, "ok"); loadIntegrations(); }
    catch (e) { toast(e.message, "err"); }
  });
  $$("[data-notif-test]").forEach((b) => b.onclick = async () => {
    const needTo = ["email", "sms", "whatsapp", "voice"].includes(b.dataset.type);
    const to = needTo ? prompt(b.dataset.type === "voice" ? "Phone number to call (10 digits or +91…):" : `Send the test ${b.dataset.type} to:`) : "";
    if (needTo && !to) return;
    try { const r = await api(`/api/admin/notifications/test?channel=${encodeURIComponent(b.dataset.notifTest)}&to=${encodeURIComponent(to || "")}`, { method: "POST" }); toast(`${b.dataset.notifTest}: ${r.status} · ${r.detail || ""}`, r.status === "sent" ? "ok" : "err"); loadIntegrations(); }
    catch (e) { toast(e.message, "err"); }
  });
  renderRoutes(notif.routes);
  $("#routes-src").textContent = notif.routes_source === "console" ? "edited in the console (overrides config/notify.yaml)" : "from config/notify.yaml — edit and save to manage here";
  $("#notif-table tbody").innerHTML = notif.log.map((n) => `<tr><td>${esc(fmtTime(n.ts))}</td><td>${esc(n.channel)}</td><td class="small">${esc(n.recipient)}</td><td>${esc(n.kind)}</td><td class="small">${esc(n.subject)}</td><td><span class="${["sent", "answered"].includes(n.status) ? "ok-chip" : n.status === "queued" ? "tagchip" : "bad-chip"}">${esc(n.status)}</span></td><td class="small muted">${esc(n.detail)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Nothing sent yet.</td></tr>';
  $("#tenants-list").innerHTML = "Tenants: " + tenants.tenants.map((t) => `<span class="tagchip">${esc(t.id)} · ${esc(t.name)}</span>`).join(" ");
  $("#vendors-list").innerHTML = "Vendor presets (config/vendors.yaml): " + Object.entries(vendors).map(([k, v]) => `${esc(k)} (${esc(v.adapter)})`).join(", ");
  $$("[data-key-rev]").forEach((b) => b.onclick = () => api(`/api/admin/api-keys/${b.dataset.keyRev}`, { method: "DELETE" }).then(loadIntegrations));
  $$("[data-hook-test]").forEach((b) => b.onclick = async () => { const r = await api(`/api/admin/webhooks/${b.dataset.hookTest}/test`, { method: "POST" }); toast(`Test delivery: ${r.last_status}`, r.last_status.startsWith("HTTP 2") ? "ok" : "err"); loadIntegrations(); });
  $$("[data-hook-toggle]").forEach((b) => b.onclick = () => api(`/api/admin/webhooks/${b.dataset.hookToggle}?active=${b.dataset.active !== "true"}`, { method: "PATCH" }).then(loadIntegrations));
  $$("[data-hook-del]").forEach((b) => b.onclick = () => api(`/api/admin/webhooks/${b.dataset.hookDel}`, { method: "DELETE" }).then(loadIntegrations));
}
async function createKey(ev) {
  ev.preventDefault(); const f = ev.target;
  try {
    const k = await api("/api/admin/api-keys", { method: "POST", body: JSON.stringify({ name: f.name.value, features: f.features.value.split(",").map((x) => x.trim()).filter(Boolean), departments: f.departments.value.split(",").map((x) => x.trim()).filter(Boolean), days: +f.days.value }) });
    modal(`<h3>API key created</h3><p>Copy it now; it is shown once.</p><pre>${esc(k.key)}</pre><p class="small muted">curl -H "X-API-Key: ${esc(k.key)}" ${location.origin}/api/events</p>`); f.reset(); f.features.value = "search,playback"; f.departments.value = "*"; f.days.value = 365; loadIntegrations();
  } catch (e) { toast(e.message, "err"); }
}
async function createHook(ev) {
  ev.preventDefault(); const f = ev.target;
  try {
    const w = await api("/api/admin/webhooks", { method: "POST", body: JSON.stringify({ name: f.name.value, url: f.url.value, kinds: f.kinds.value.split(",").map((x) => x.trim()).filter(Boolean), departments: f.departments.value.split(",").map((x) => x.trim()).filter(Boolean) }) });
    modal(`<h3>Webhook added</h3><p>Shared secret for signature verification (shown once):</p><pre>${esc(w.secret)}</pre>`); f.reset(); f.kinds.value = "alert,incident"; f.departments.value = "*"; loadIntegrations();
  } catch (e) { toast(e.message, "err"); }
}
async function addGrant(ev) {
  ev.preventDefault(); const f = ev.target;
  try { await api("/api/admin/grants", { method: "POST", body: JSON.stringify({ username: f.username.value.trim(), kind: f.kind.value, value: f.value.value.trim(), hours: +f.hours.value, reason: f.reason.value }) }); f.reset(); f.hours.value = 24; loadAdmin(); toast("Grant added; takes effect at the user's next sign-in or refresh", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function addHold(ev) {
  ev.preventDefault(); const f = ev.target;
  try { await api("/api/admin/holds", { method: "POST", body: JSON.stringify({ kind: f.kind.value, value: f.value.value.trim(), reference: f.reference.value, reason: f.reason.value }) }); f.reset(); loadAdmin(); toast("Legal hold placed", "ok"); }
  catch (e) { toast(e.message, "err"); }
}
async function dpdpAccess() {
  const p = $("#dpdp-form").plate.value.trim(); if (!p) return;
  const r = await api(`/api/dpdp/subject-access?plate=${encodeURIComponent(p)}`);
  modal(`<h3>Subject access report · ${esc(r.plate)}</h3><p class="muted small">${r.events.length} sightings · ${r.alerts.length} alerts · watchlist: ${r.watchlist} · legal holds: ${esc(r.legal_holds.join(", ") || "none")} · retention: events ${r.retention_days.events_days} d</p>
    <pre style="max-height:50vh;overflow:auto">${esc(JSON.stringify(r, null, 1))}</pre>`);
}
async function dpdpErase() {
  const p = $("#dpdp-form").plate.value.trim(); if (!p) return;
  if (!confirm(`Erase every record, clip and crop for ${p}? This is irreversible and audited.`)) return;
  try { const r = await api(`/api/dpdp/erase?plate=${encodeURIComponent(p)}&reason=data principal request`, { method: "POST" }); toast(`Erased ${r.events_erased} events, ${r.alerts_erased} alerts, ${r.objects_erased} objects`, "ok"); }
  catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------------ ui helpers
function modal(html) { $("#modal-body").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); $("#modal-body").innerHTML = ""; }
function toast(msg, kind) {
  const t = document.createElement("div"); t.className = "toast"; if (kind === "ok") t.style.borderColor = "var(--ok)";
  t.style.gridTemplateColumns = "1fr"; t.textContent = msg; $("#toasts").prepend(t); setTimeout(() => t.remove(), 4000);
}


// ------------------------------------------------------------------ audit log: filters, sorting, paging, export
const AUDIT = { page: 1, sort: "ts", order: "desc", facets: null };
function auditQuery() {
  const f = $("#audit-filter"), qs = new URLSearchParams();
  ["q", "user", "action", "from", "to"].forEach((k) => { if (f[k].value) qs.set(k, k === "from" || k === "to" ? new Date(f[k].value).toISOString() : f[k].value); });
  qs.set("sort", AUDIT.sort); qs.set("order", AUDIT.order);
  return qs;
}
function pager(el, page, pages, total, onPage) {
  if (!el) return;
  if (pages <= 1) { el.innerHTML = total ? `<span>${total} row${total === 1 ? "" : "s"}</span>` : ""; return; }
  const btn = (p, label, cls = "") => `<button class="btn ghost small ${cls}" data-page="${p}" ${p < 1 || p > pages ? "disabled" : ""}>${label}</button>`;
  const around = []; for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) around.push(p);
  el.innerHTML = `<span>${total} rows · page ${page} of ${pages}</span>${btn(1, "«")}${btn(page - 1, "‹")}${around[0] > 1 ? "<span>…</span>" : ""}${around.map((p) => btn(p, p, p === page ? "active" : "")).join("")}${around.at(-1) < pages ? "<span>…</span>" : ""}${btn(page + 1, "›")}${btn(pages, "»")}`;
  $$("[data-page]", el).forEach((b) => b.onclick = () => onPage(+b.dataset.page));
}
async function loadAudit() {
  const f = $("#audit-filter");
  if (!AUDIT.facets) {
    try {
      AUDIT.facets = await api("/api/audit/facets");
      const keep = (sel) => sel.value;
      const su = f.user, sa = f.action, vu = keep(su), va = keep(sa);
      su.innerHTML = '<option value="">all</option>' + AUDIT.facets.users.map((u) => `<option value="${esc(u.user)}">${esc(u.user)} (${u.count})</option>`).join("");
      sa.innerHTML = '<option value="">all</option>' + AUDIT.facets.actions.map((a) => `<option value="${esc(a.action)}">${esc(a.action)} (${a.count})</option>`).join("");
      su.value = vu; sa.value = va;
    } catch (_) { AUDIT.facets = { users: [], actions: [] }; }
  }
  const qs = auditQuery(); qs.set("page", AUDIT.page); qs.set("page_size", f.page_size.value);
  const r = await api(`/api/audit?${qs}`);
  $$("#audit-table th[data-sort]").forEach((th) => { th.classList.toggle("asc", th.dataset.sort === AUDIT.sort && AUDIT.order === "asc"); th.classList.toggle("desc", th.dataset.sort === AUDIT.sort && AUDIT.order === "desc"); });
  $("#audit-table tbody").innerHTML = r.items.map((x) => `<tr class="${x.action.startsWith("break_glass") ? "row-bg" : ""}"><td>${esc(fmtTime(x.ts))}</td><td>${esc(x.user)}</td><td><span class="tagchip">${esc(x.action)}</span></td><td>${esc(x.target)}</td><td>${esc(x.detail)}</td><td>${esc(x.ip)} <span class="muted small" title="row hash">${esc(x.hash)}</span></td></tr>`).join("")
    || '<tr><td colspan="6" class="muted">No audit rows match.</td></tr>';
  $("#audit-count").textContent = `${r.total} row${r.total === 1 ? "" : "s"}${AUDIT.facets.total && r.total !== AUDIT.facets.total ? ` of ${AUDIT.facets.total}` : ""}`;
  pager($("#audit-pager"), r.page, r.pages, r.total, (p) => { AUDIT.page = p; loadAudit(); });
}

// ------------------------------------------------------------------ notifications: bell, menu badge, page
const NOTIF = { page: 1, unread: 0, bellOpen: false };
const SEV_LABEL = { critical: "critical", warn: "warning", info: "info" };
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : fmtDate(iso); };
function setInboxCount(n) {
  NOTIF.unread = n;
  [$("#bell-count"), $("#notif-badge")].forEach((b) => { if (!b) return; b.textContent = n > 99 ? "99+" : n; b.classList.toggle("hidden", !n); });
  if (n) document.title = `(${n}) ${document.title.replace(/^\(\d+\+?\) /, "")}`; else document.title = document.title.replace(/^\(\d+\+?\) /, "");
}
async function refreshInbox() { try { setInboxCount((await api("/api/notifications/unread")).unread); if (NOTIF.bellOpen) renderBell(); } catch (_) {} }
function onInbox(m) {
  setInboxCount(NOTIF.unread + 1);
  if (m.kind === "security" && /^Camera permission/.test(m.title || "") && S.view === "admin" && typeof loadPerms === "function") loadPerms();
  if (m.severity === "critical" && m.kind !== "alert") toast(m.title, "err");   // alerts already toast on their own
  if (NOTIF.bellOpen) renderBell();
  if (S.view === "notifications") loadNotifications();
  const b = $("#bell"); if (b) { b.classList.add("ring"); setTimeout(() => b.classList.remove("ring"), 1200); }
}
function notifItem(n, compact) {
  return `<div class="notif-item ${n.read ? "" : "unread"}" data-nid="${esc(n.id)}" data-link="${esc(n.link || "")}" role="menuitem" tabindex="0">
    <span class="sev ${esc(n.severity)}" title="${esc(SEV_LABEL[n.severity] || n.severity)}"></span>
    <div><div class="t"><span class="kind">${esc(n.kind)}</span>${esc(n.title)}</div>${n.body && !compact ? `<div class="b">${esc(n.body)}</div>` : n.body ? `<div class="b">${esc(n.body.slice(0, 90))}${n.body.length > 90 ? "…" : ""}</div>` : ""}</div>
    <div class="when">${esc(ago(n.ts))}${compact ? "" : `<br><button class="btn ghost small" data-toggle-read="${esc(n.id)}" data-read="${n.read ? 1 : 0}">${n.read ? "Mark unread" : "Mark read"}</button>`}</div></div>`;
}
async function openNotif(id, link, read) {
  if (!read) { try { const r = await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }); setInboxCount(r.unread); } catch (_) {} }
  closeBell();
  if (link && $(`#tabs button[data-view="${link}"]`) && !$(`#tabs button[data-view="${link}"]`).classList.contains("hidden")) show(link);
  else if (S.view === "notifications") loadNotifications();
}
function wireNotifItems(root) {
  $$(".notif-item", root).forEach((el) => {
    el.onclick = (e) => { if (e.target.closest("[data-toggle-read]")) return; openNotif(el.dataset.nid, el.dataset.link, !el.classList.contains("unread")); };
    el.onkeydown = (e) => { if (e.key === "Enter") el.click(); };
  });
  $$("[data-toggle-read]", root).forEach((b) => b.onclick = async () => {
    const r = await api(`/api/notifications/${b.dataset.read === "1" ? "unread" : "read"}`, { method: "POST", body: JSON.stringify({ ids: [b.dataset.toggleRead] }) });
    setInboxCount(r.unread); loadNotifications();
  });
}
async function renderBell() {
  const box = $("#bell-list"); if (!box) return;
  try {
    const r = await api("/api/notifications?page=1&page_size=8");
    box.innerHTML = r.items.length ? r.items.map((n) => notifItem(n, true)).join("") : '<div class="empty">No notifications yet.</div>';
    wireNotifItems(box);
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function toggleBell() { NOTIF.bellOpen ? closeBell() : openBell(); }
function openBell() { NOTIF.bellOpen = true; $("#bell-panel").classList.remove("hidden"); $("#bell").setAttribute("aria-expanded", "true"); renderBell(); }
function closeBell() { if (!NOTIF.bellOpen) return; NOTIF.bellOpen = false; $("#bell-panel").classList.add("hidden"); $("#bell").setAttribute("aria-expanded", "false"); }
async function markAllRead() {
  try { const r = await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }); setInboxCount(r.unread); toast(`${r.marked} notification${r.marked === 1 ? "" : "s"} marked read`, "ok"); }
  catch (e) { toast(e.message, "err"); }
  if (NOTIF.bellOpen) renderBell();
  if (S.view === "notifications") loadNotifications();
}
function barChart(el, rows, series, opts = {}) {
  // rows: [{label, values:[...]}], series: [{key, cls, name}] ; stacked bars, one column per row
  if (!el) return;
  const max = Math.max(1, ...rows.map((r) => series.reduce((a, s) => a + (+r.values[s.key] || 0), 0)));
  const fmt = opts.fmt || ((v) => v);
  const showLbl = opts.labels !== false && rows.length <= 16;
  el.innerHTML = `<div class="bars">${rows.map((r) => {
    const tot = series.reduce((a, s) => a + (+r.values[s.key] || 0), 0);
    const parts = series.map((s) => { const v = +r.values[s.key] || 0; return v ? `<div class="bar ${s.cls}" style="height:${Math.max(2, (v / max) * 100)}%;flex:none;width:100%;position:static;border-radius:0" title="${esc(s.name)}: ${esc(fmt(v))}"></div>` : ""; }).join("");
    return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;position:relative;min-width:4px" title="${esc(r.label)}: ${esc(fmt(tot))}">${tot && showLbl ? `<span class="lbl" style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--muted)">${esc(fmt(tot))}</span>` : ""}${parts}</div>`;
  }).join("")}</div><div class="bars-x">${rows.map((r) => `<span>${rows.length <= 16 || rows.indexOf(r) % Math.ceil(rows.length / 10) === 0 ? esc(r.short || r.label) : ""}</span>`).join("")}</div>
  ${series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i class="${s.cls}"></i>${esc(s.name)}</span>`).join("")}</div>` : ""}`;
}
const dayShort = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
async function loadNotifications() {
  const f = $("#notif-filter"); if (!f) return;
  const sel = f.kind;
  const [sm, r] = await Promise.all([api("/api/notifications/summary?days=7"),
    api(`/api/notifications?page=${NOTIF.page}&page_size=${f.page_size.value}&kind=${encodeURIComponent(f.kind.value)}&severity=${f.severity.value}&unread=${f.unread.checked ? 1 : 0}&q=${encodeURIComponent(f.q.value)}`)]);
  if (sel.options.length <= 1) sm.kinds.forEach((k) => sel.add(new Option(k, k)));
  setInboxCount(sm.unread);
  const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  $("#notif-kpis").innerHTML = [kpi("Unread", sm.unread, sm.unread ? "warn" : "ok"), kpi("Today", sm.today), kpi("Last 7 days", sm.total),
    kpi("Critical (7 d)", sm.by_severity.critical || 0, sm.by_severity.critical ? "bad" : "ok"), kpi("Warnings (7 d)", sm.by_severity.warn || 0, sm.by_severity.warn ? "warn" : ""),
    kpi("Alerts (7 d)", sm.by_kind.alert || 0), kpi("Camera events (7 d)", sm.by_kind.camera || 0), kpi("Security (7 d)", sm.by_kind.security || 0)].join("");
  barChart($("#notif-chart"), sm.per_day.map((d) => ({ label: d.day, short: dayShort(d.day), values: d })), [{ key: "info", cls: "", name: "info" }, { key: "warn", cls: "b2", name: "warning" }, { key: "critical", cls: "b3", name: "critical" }]);
  $("#notif-kinds").innerHTML = Object.entries(sm.by_kind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join("") || '<span class="muted">none yet</span><span></span>';
  $("#notif-sev").innerHTML = ["critical", "warn", "info"].map((k) => `<span>${esc(SEV_LABEL[k])}</span><span class="${k === "critical" && sm.by_severity[k] ? "bad-chip" : k === "warn" && sm.by_severity[k] ? "tagchip" : ""}">${sm.by_severity[k] || 0}</span>`).join("");
  $("#notif-count").textContent = `${r.total} notification${r.total === 1 ? "" : "s"}`;
  $("#notif-list").innerHTML = r.items.length ? r.items.map((n) => notifItem(n, false)).join("") : '<div class="muted small" style="padding:12px">Nothing here. Alerts, camera health, device, detection, security and archival events appear as they happen.</div>';
  wireNotifItems($("#notif-list"));
  pager($("#notif-pager"), r.page, r.pages, r.total, (p) => { NOTIF.page = p; loadNotifications(); });
}
async function refreshAccess() {
  // roles can change while signed in: pick up new permissions and re-apply the menu
  try {
    const me = await api("/api/auth/me");
    const before = JSON.stringify(S.user.features || []);
    S.user = { ...S.user, ...me }; sessionStorage.setItem("uvp", JSON.stringify({ token: S.token, user: S.user }));
    if (before !== JSON.stringify(me.features || [])) { $$("[data-feature]").forEach((el) => el.classList.toggle("hidden", !has(el.dataset.feature))); toast("Your permissions were updated by an administrator", "warn"); }
  } catch (_) {}
}

// ------------------------------------------------------------------ daily reports
function reportQuery() {
  const f = $("#rep-filter"), qs = new URLSearchParams();
  qs.set("days", f.days.value); if (f.end.value) qs.set("end", f.end.value); if (f.department.value) qs.set("department", f.department.value); if (f.camera_id.value) qs.set("camera_id", f.camera_id.value);
  return qs;
}
let REP = null;
async function loadReports() {
  const f = $("#rep-filter"); if (!f) return;
  if (f.department.options.length <= 1) {
    const depts = [...new Set(S.cameras.map((c) => c.department))].sort();
    depts.forEach((d) => f.department.add(new Option(d, d)));
    S.cameras.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => f.camera_id.add(new Option(`${c.name} (${c.department})`, c.id)));
  }
  const rep = REP = await api(`/api/reports/daily?${reportQuery()}`);
  const T = rep.totals, rows = rep.rows;
  const trend = (k, invert = false) => { const t = T.trend && T.trend[k]; if (!t || !t.previous) return ""; const d = Math.round(100 * (t.current - t.previous) / t.previous); if (Math.abs(d) < 3) return `<span class="trend flat">≈</span>`; const bad = invert ? d < 0 : d > 0; return `<span class="trend ${bad ? "up" : "down"}" title="vs previous ${Math.floor(rows.length / 2)} days">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%</span>`; };
  const kpi = (l, v, cls = "", extra = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}${extra}</div><div class="l">${esc(l)}</div></div>`;
  $("#rep-kpis").innerHTML = [
    kpi("Plate reads", T.reads.toLocaleString("en-IN"), "", trend("reads")), kpi("Busiest day · unique plates", T.unique_plates_max_day.toLocaleString("en-IN")),
    kpi("Alerts", T.alerts, T.alerts ? "warn" : "ok", trend("alerts")), kpi("Alerts acknowledged", T.alerts ? `${Math.round(100 * T.alerts_acked / T.alerts)}%` : "–"),
    kpi("Incidents", T.incidents, T.incidents_high ? "warn" : "", trend("incidents")), kpi("Challans · approved", `${T.challans} · ${T.challans_approved}`),
    kpi("Camera uptime", T.uptime_pct == null ? "–" : `${T.uptime_pct}%`, T.uptime_pct == null ? "" : T.uptime_pct >= 98 ? "ok" : T.uptime_pct >= 90 ? "warn" : "bad"),
    kpi("Offline minutes", T.offline_minutes.toLocaleString("en-IN"), "", trend("offline_minutes")), kpi("Peak vehicles / people", `${T.peak_vehicles} / ${T.peak_persons}`),
    kpi("Uploads analysed", T.uploads), kpi("Sign-ins · failed", `${T.logins} · ${T.failed_logins}`, T.failed_logins > T.logins ? "warn" : ""), kpi("Notifications · critical", `${T.notifications} · ${T.notifications_critical}`)].join("");
  const R = rows.map((r) => ({ label: r.day, short: dayShort(r.day), values: r }));
  barChart($("#rep-chart-reads"), R, [{ key: "reads", cls: "", name: "reads" }]);
  barChart($("#rep-chart-alerts"), R, [{ key: "alerts", cls: "b2", name: "alerts" }, { key: "incidents", cls: "b3", name: "incidents" }]);
  barChart($("#rep-chart-uptime"), rows.map((r) => ({ label: r.day, short: dayShort(r.day), values: { up: r.uptime_pct == null ? 0 : r.uptime_pct } })), [{ key: "up", cls: "ok", name: "uptime %" }], { fmt: (v) => `${v}%`, labels: false });
  barChart($("#rep-chart-traffic"), R, [{ key: "peak_vehicles", cls: "", name: "peak vehicles" }, { key: "peak_persons", cls: "b2", name: "peak people" }]);
  $("#rep-range").textContent = `${dayShort(rep.from)} – ${dayShort(rep.to)} · ${rep.departments.join(", ")}${rep.camera_id ? " · " + (S.camById[rep.camera_id]?.name || rep.camera_id) : ""}`;
  const up = (v) => v == null ? "–" : `<span class="${v >= 98 ? "ok-chip" : v >= 90 ? "tagchip" : "bad-chip"}">${v}%</span>`;
  $("#rep-table tbody").innerHTML = rows.slice().reverse().map((r) => `<tr><td><b>${esc(dayShort(r.day))}</b><div class="muted small">${esc(new Date(r.day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short" }))}</div></td>
    <td>${r.reads}</td><td>${r.unique_plates}</td><td>${r.busiest_camera ? `${esc(S.camById[r.busiest_camera]?.name || r.busiest_camera)} <span class="muted small">${r.busiest_camera_reads}</span>` : "–"}</td><td>${r.peak_hour == null ? "–" : `${String(r.peak_hour).padStart(2, "0")}:00`}</td>
    <td>${r.alerts}${r.alerts_by_priority.critical || r.alerts_by_priority.high ? ` <span class="bad-chip">${(r.alerts_by_priority.critical || 0) + (r.alerts_by_priority.high || 0)} high</span>` : ""}</td><td>${r.alerts_acked}</td>
    <td>${r.incidents}${r.incidents_high ? ` <span class="bad-chip">${r.incidents_high}</span>` : ""}</td><td class="small">${Object.entries(r.incidents_by_kind).map(([k, v]) => `${esc(k)} ${v}`).join(", ") || "–"}</td>
    <td>${r.challans}${r.challans_approved ? ` <span class="ok-chip">${r.challans_approved} ✓</span>` : ""}${r.challan_fines_inr ? `<div class="muted small">₹${r.challan_fines_inr.toLocaleString("en-IN")}</div>` : ""}</td>
    <td>${r.avg_vehicles}</td><td>${r.peak_vehicles}${r.peak_traffic_hour != null ? `<div class="muted small">${String(r.peak_traffic_hour).padStart(2, "0")}:00</div>` : ""}</td><td>${r.peak_persons}</td>
    <td>${up(r.uptime_pct)}</td><td>${r.offline_minutes}${r.offline_events ? `<div class="muted small">${r.offline_events} drop${r.offline_events > 1 ? "s" : ""}</div>` : ""}</td>
    <td>${r.uploads}</td><td>${r.exports}</td><td>${r.logins}</td><td>${r.failed_logins ? `<span class="bad-chip">${r.failed_logins}</span>` : 0}</td><td>${r.audit_actions}</td><td>${r.notifications}${r.notifications_critical ? ` <span class="bad-chip">${r.notifications_critical}</span>` : ""}</td></tr>`).join("");
}

// ------------------------------------------------------------------ roles & permissions (dynamic)
let ROLES = null;
async function loadRoles() {
  const tb = $("#roles-table"); if (!tb) return;
  try { ROLES = await api("/api/roles"); } catch (e) { tb.querySelector("tbody").innerHTML = `<tr><td class="muted">${esc(e.message)}</td></tr>`; return; }
  const roles = ROLES.roles, feats = ROLES.features;
  tb.querySelector("thead").innerHTML = `<tr><th>Permission</th>${roles.map((r) => `<th data-role-col="${esc(r.name)}"><b>${esc(r.name)}</b>${r.builtin ? "" : ' <span class="tagchip">custom</span>'}<span class="rdesc">${esc(r.description || "")}</span><span class="rdesc">${r.users} user${r.users === 1 ? "" : "s"}</span></th>`).join("")}</tr>`;
  tb.querySelector("tbody").innerHTML = feats.map((f) => `<tr><td><b>${esc(f.label)}</b><div class="muted small">${esc(f.id)}</div></td>${roles.map((r) => `<td><input type="checkbox" data-role="${esc(r.name)}" data-feat="${esc(f.id)}" ${r.features.includes(f.id) ? "checked" : ""} ${r.name === "admin" && f.id === "admin" ? "disabled" : ""} aria-label="${esc(r.name)}: ${esc(f.label)}"></td>`).join("")}</tr>`).join("")
    + `<tr><td class="muted small">Save / remove</td>${roles.map((r) => `<td><button class="btn primary small" data-role-save="${esc(r.name)}" disabled>Save</button>${r.builtin ? "" : ` <button class="btn ghost small" data-role-del="${esc(r.name)}" title="Remove this role (no accounts may still use it)">Remove</button>`}</td>`).join("")}</tr>`;
  $$("input[data-role]", tb).forEach((cb) => cb.onchange = () => {
    const r = roles.find((x) => x.name === cb.dataset.role);
    const now = $$(`input[data-role="${cb.dataset.role}"]`, tb).filter((c) => c.checked).map((c) => c.dataset.feat).sort();
    const dirty = JSON.stringify(now) !== JSON.stringify(r.features.slice().sort());
    $(`[data-role-save="${cb.dataset.role}"]`, tb).disabled = !dirty;
    $(`th[data-role-col="${cb.dataset.role}"]`, tb).classList.toggle("dirty", dirty);
  });
  $$("[data-role-save]", tb).forEach((b) => b.onclick = async () => {
    const name = b.dataset.roleSave;
    const features = $$(`input[data-role="${name}"]`, tb).filter((c) => c.checked).map((c) => c.dataset.feat);
    try { await api(`/api/roles/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ features }) }); toast(`Role ${name} saved · ${features.length} permission${features.length === 1 ? "" : "s"}; signed-in users follow at once`, "ok"); loadRoles(); refreshAccess(); }
    catch (e) { toast(e.message, "err"); }
  });
  $$("[data-role-del]", tb).forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove role ${b.dataset.roleDel}?`)) return;
    try { await api(`/api/roles/${encodeURIComponent(b.dataset.roleDel)}`, { method: "DELETE" }); toast("Role removed", "ok"); loadRoles(); } catch (e) { toast(e.message, "err"); }
  });
  const sel = $("#user-role-select");
  if (sel) { const v = sel.value; sel.innerHTML = roles.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}${r.builtin ? "" : " (custom)"}</option>`).join(""); sel.value = roles.some((r) => r.name === v) ? v : "viewer"; }
  $("#roles-sub").textContent = `${roles.length} roles · ${feats.length} permissions · changes apply to signed-in users within a minute` + (S.user.is_super ? "" : " · creating or changing roles needs a super admin once database accounts exist");
}
async function createRole() {
  const f = $("#role-form");
  const name = f.name.value.trim();
  if (!name) return toast("Give the role a name (lowercase, e.g. traffic_analyst)", "err");
  try {
    await api("/api/roles", { method: "POST", body: JSON.stringify({ name, description: f.description.value.trim(), features: ["live"] }) });
    toast(`Role ${name} created with "Live video wall" only — tick its permissions and press Save`, "ok"); f.reset(); loadRoles();
  } catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------------ archival policy
let ARCH = null;
const fmtBytes = (b) => !b ? "–" : b > 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`;
async function loadArchival() {
  const tb = $("#arch-table"); if (!tb) return;
  try { ARCH = await api("/api/archival"); } catch (e) { tb.querySelector("tbody").innerHTML = `<tr><td colspan="8" class="muted">${esc(e.message)}</td></tr>`; return; }
  const a = ARCH, u = a.usage, pv = a.preview;
  const due = Object.values(pv).reduce((n, x) => n + (x.due || 0), 0);
  const last = a.runs[0];
  const kpi = (l, v, cls = "") => `<div class="kpi ${cls}"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
  $("#arch-kpis").innerHTML = [kpi("Records due now", due.toLocaleString("en-IN"), due ? "warn" : "ok"), kpi("Plate events held", (u.events.rows || 0).toLocaleString("en-IN")),
    kpi("Recordings", `${u.recordings.rows} · ${fmtBytes(u.recordings.bytes)}`), kpi("Uploads", `${u.uploads.rows} · ${fmtBytes(u.uploads.bytes)}`),
    kpi("Audit rows", (u.audit.rows || 0).toLocaleString("en-IN")), kpi("Last run", last ? `${last.removed_total} removed` : "never", last ? (last.status === "ok" ? "ok" : "bad") : "warn"),
    kpi("Next run", a.schedule.enabled ? `${String(a.schedule.hour_ist).padStart(2, "0")}:00 IST` : "paused", a.schedule.enabled ? "" : "warn")].join("");
  const sf = $("#arch-schedule");
  if (!sf.hour_ist.options.length) for (let h = 0; h < 24; h++) sf.hour_ist.add(new Option(`${String(h).padStart(2, "0")}:00`, h));
  sf.hour_ist.value = a.schedule.hour_ist; sf.enabled.checked = a.schedule.enabled;
  $("#arch-cold").textContent = `archived copies go to object storage under ${a.schedule.cold_prefix}/ (${a.schedule.cold_class} class)`;
  $("#arch-sub").textContent = a.running ? "a run is in progress…" : `${a.policies.filter((p) => p.source === "console").length} console override${a.policies.filter((p) => p.source === "console").length === 1 ? "" : "s"}`;
  const label = (p) => `<b>${esc(p.label)}</b>${p.department !== "*" ? ` <span class="tagchip">${esc(p.department)}</span>` : ""}<div class="muted small">${esc(p.detail)}</div>`;
  const held = (p) => { const x = u[p.data_class] || {}; return p.department !== "*" ? "" : `${(x.rows ?? 0).toLocaleString("en-IN")}${x.bytes ? ` · ${fmtBytes(x.bytes)}` : ""}${x.oldest ? `<div class="muted small">oldest ${esc(fmtDate(x.oldest))}</div>` : ""}`; };
  tb.querySelector("tbody").innerHTML = a.policies.map((p, i) => `<tr data-i="${i}" class="${p.enabled ? "" : "muted"}">
    <td>${label(p)}</td><td>${held(p)}</td>
    <td><input type="number" min="${p.min_days}" max="3650" value="${p.keep_days}" data-f="keep_days" aria-label="keep days"></td>
    <td><select data-f="action" aria-label="action"><option value="delete" ${p.action === "delete" ? "selected" : ""}>delete</option>${p.can_archive ? `<option value="archive" ${p.action === "archive" ? "selected" : ""}>archive to cold, then delete</option>` : ""}</select></td>
    <td><input type="checkbox" data-f="enabled" ${p.enabled ? "checked" : ""} aria-label="enabled"></td>
    <td>${p.department === "*" ? `${(pv[p.data_class]?.due ?? 0).toLocaleString("en-IN")}` : ""}</td>
    <td><span class="tagchip">${esc(p.source)}</span></td>
    <td><button class="btn primary small" data-save="${i}">Save</button> ${p.source === "console" ? `<button class="btn ghost small" data-reset="${i}" title="Back to the default">Reset</button>` : ""} ${p.department === "*" ? `<button class="btn ghost small" data-override="${i}" title="A different rule for one department">+ Dept</button>` : ""}</td></tr>`).join("");
  $$("[data-save]", tb).forEach((b) => b.onclick = async () => {
    const p = a.policies[+b.dataset.save], tr = b.closest("tr");
    const body = { keep_days: +$('[data-f="keep_days"]', tr).value, action: $('[data-f="action"]', tr).value, enabled: $('[data-f="enabled"]', tr).checked, department: p.department };
    try { await api(`/api/archival/policies/${p.data_class}`, { method: "PUT", body: JSON.stringify(body) }); toast(`${p.label}: keep ${body.keep_days} days, then ${body.action}`, "ok"); loadArchival(); } catch (e) { toast(e.message, "err"); }
  });
  $$("[data-reset]", tb).forEach((b) => b.onclick = async () => { const p = a.policies[+b.dataset.reset]; try { await api(`/api/archival/policies/${p.data_class}?department=${encodeURIComponent(p.department)}`, { method: "DELETE" }); loadArchival(); } catch (e) { toast(e.message, "err"); } });
  $$("[data-override]", tb).forEach((b) => b.onclick = async () => {
    const p = a.policies[+b.dataset.override];
    const dept = prompt(`Department for a separate ${p.label} rule (e.g. Police):`); if (!dept) return;
    const days = prompt(`Keep ${p.label} for how many days in ${dept}?`, p.keep_days); if (!days) return;
    try { await api(`/api/archival/policies/${p.data_class}`, { method: "PUT", body: JSON.stringify({ keep_days: +days, action: p.action, enabled: true, department: dept.trim() }) }); loadArchival(); } catch (e) { toast(e.message, "err"); }
  });
  $("#arch-runs tbody").innerHTML = a.runs.map((r) => `<tr><td>${esc(fmtTime(r.started_at))}</td><td>${esc(r.trigger)}</td><td>${esc(r.by)}</td><td>${r.status === "ok" ? '<span class="ok-chip">ok</span>' : r.status === "running" ? '<span class="tagchip">running</span>' : '<span class="bad-chip">error</span>'}</td>
    <td>${r.removed_total}${r.removed_total ? `<div class="muted small">${esc(Object.entries(r.removed).map(([k, v]) => `${k} ${v}`).join(", "))}</div>` : ""}</td><td class="small">${esc(Object.entries(r.archived).map(([k, v]) => `${k} ${v}`).join(", ")) || "–"}</td><td>${r.held}</td><td class="small muted">${esc((r.detail || "").split("\n")[0])}</td></tr>`).join("")
    || '<tr><td colspan="8" class="muted">No runs yet. The archiver runs nightly; press "Run now" to start one.</td></tr>';
  if (a.running) setTimeout(loadArchival, 4000);
}
async function runArchival() {
  if (!confirm("Run the archival policies now? Records older than their keep period are archived / deleted (legal holds are kept).")) return;
  try { await api("/api/archival/run", { method: "POST" }); toast("Archival run started — the table refreshes when it finishes", "ok"); setTimeout(loadArchival, 2500); } catch (e) { toast(e.message, "err"); }
}
async function saveArchivalSchedule() {
  const f = $("#arch-schedule");
  try { await api("/api/archival/schedule", { method: "PUT", body: JSON.stringify({ hour_ist: +f.hour_ist.value, enabled: f.enabled.checked }) }); toast("Schedule saved", "ok"); loadArchival(); } catch (e) { toast(e.message, "err"); }
}


// ------------------------------------------------------------------ VIP routes / corridors
let ROUTES = [];
let ROUTE_SEL = null;
async function loadRoutes() {
  try { ROUTES = await api("/api/routes"); } catch (_) { ROUTES = []; }
  const opt = (r) => `<option value="${esc(r.id)}">${r.priority === "vip" ? "★ " : ""}${esc(r.name)} (${r.camera_count})</option>`;
  const mr = $("#map-route"); if (mr) { const v = mr.value; mr.innerHTML = '<option value="">— none —</option>' + ROUTES.map(opt).join(""); mr.value = ROUTES.some((r) => r.id === v) ? v : ""; }
  const ws = $("#route-select"); if (ws) { ws.innerHTML = '<option value="">VIP routes…</option>' + ROUTES.map(opt).join(""); }
}
function routeOnWall(r) {
  const cams = r.cameras.filter((c) => !c.registry_only);
  if (!cams.length) return toast("No live cameras on this route (registry-only cameras have no feed)", "warn");
  const grid = cams.length <= 1 ? "1x1" : cams.length <= 4 ? "2x2" : cams.length <= 9 ? "3x3" : "4x4";
  show("wall"); buildWall(grid);
  cams.slice(0, GRID_N[grid]).forEach((c, i) => setTile(S.tiles[i], c.id));
  toast(`${r.name}: ${Math.min(cams.length, GRID_N[grid])} of ${cams.length} cameras on the wall, in route order${cams.length > GRID_N[grid] ? " (first " + GRID_N[grid] + ")" : ""}`, "ok");
}
function showRoute(id) {
  ROUTE_SEL = ROUTES.find((r) => r.id === id) || null;
  ["#route-wall", "#route-edit", "#route-del"].forEach((b) => { const el = $(b); if (el) el.disabled = !ROUTE_SEL; });
  if (MAP) { MAP.route = MAP.route || L.layerGroup().addTo(MAP); MAP.route.clearLayers(); }
  if (!ROUTE_SEL) { $("#route-info").textContent = "Define a route between two places (e.g. Amroha → Delhi) or a road inside an area (e.g. NH24 in Delhi); the cameras along it are listed in order and can be opened on the wall with one click."; $("#route-cams").innerHTML = ""; return; }
  const r = ROUTE_SEL;
  const bits = [];
  if (r.waypoints.length) bits.push(`${r.waypoints.map((w) => `<span title="${esc(w.label || "")} (${(+w.lat).toFixed(4)}, ${(+w.lon).toFixed(4)})">${esc(w.name)}</span>`).join(" → ")}${r.length_km ? ` · ${r.length_km} km` : ""} · ±${r.buffer_m} m`);
  if (r.road) bits.push(`road: <b>${esc(r.road)}</b>`); if (r.area) bits.push(`area: <b>${esc(r.area)}</b>`); if (r.department) bits.push(`dept: ${esc(r.department)}`);
  const live = r.cameras.filter((c) => !c.registry_only).length;
  $("#route-info").innerHTML = `${r.priority === "vip" ? '<span class="bad-chip">VIP</span> ' : ""}<b>${esc(r.name)}</b> — ${bits.join(" · ")} · <b>${r.camera_count}</b> camera${r.camera_count === 1 ? "" : "s"} (${live} live)${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}`;
  const none = r.nearest
    ? `<span class="muted small">No camera within ±${r.buffer_m} m of this route. Nearest is <b>${esc(r.nearest.name)}</b>, ${(r.nearest.distance_m / 1000).toFixed(1)} km away${has("registry_edit") ? ` — <button class="btn ghost small" id="route-widen-now">widen to ${r.nearest.suggest_buffer_m} m</button>` : ""}. If the places were located in the wrong city, edit the route and pick them from the list.</span>`
    : '<span class="muted small">No cameras match this route yet — widen the buffer, check the road / area keywords, or give the cameras coordinates in the Registry.</span>';
  $("#route-cams").innerHTML = r.cameras.map((c, i) => `<span class="rc ${c.registry_only ? "reg" : c.status === "offline" ? "off" : ""}" data-cam="${esc(c.id)}" data-lat="${c.lat ?? ""}" data-lon="${c.lon ?? ""}" title="${esc(c.address || "")} · ${esc(c.reason)}"><span class="n">${i + 1}</span>${esc(c.name)}${c.km != null ? `<span class="km">${c.km} km</span>` : ""}</span>`).join("") || none;
  $$("#route-cams .rc").forEach((el) => el.onclick = () => { if (MAP && el.dataset.lat) MAP.setView([+el.dataset.lat, +el.dataset.lon], 15); });
  const widen = $("#route-widen-now");
  if (widen) widen.onclick = async () => { try { await api(`/api/routes/${r.id}`, { method: "PATCH", body: JSON.stringify({ buffer_m: r.nearest.suggest_buffer_m }) }); await loadRoutes(); $("#map-route").value = r.id; showRoute(r.id); } catch (e) { toast(e.message, "err"); } };
  if (MAP) {
    if (r.path.length > 1) L.polyline(r.path, { color: r.priority === "vip" ? "#ef4444" : "#3b82f6", weight: 5, opacity: 0.75 }).addTo(MAP.route);
    r.waypoints.forEach((w, i) => L.circleMarker([w.lat, w.lon], { radius: 7, color: "#111", fillColor: "#fff", fillOpacity: 1, weight: 2 }).bindTooltip(`${i + 1}. ${esc(w.name)}`).addTo(MAP.route));
    r.cameras.forEach((c, i) => { if (c.lat != null) L.circleMarker([c.lat, c.lon], { radius: 9, color: r.priority === "vip" ? "#ef4444" : "#3b82f6", fillColor: "#fff", fillOpacity: 1, weight: 3 }).bindTooltip(`${i + 1}. ${esc(c.name)}${c.km != null ? " · " + c.km + " km" : ""}`).addTo(MAP.route); });
    const pts = [...r.path, ...r.cameras.filter((c) => c.lat != null).map((c) => [c.lat, c.lon])];
    if (pts.length) MAP.fitBounds(pts, { padding: [30, 30] });
  }
}
// Location drop-down for the route editor: camera areas, saved places, geofence centres and camera sites come from
// /api/routes/places (all with coordinates); typing 3+ letters also searches the map (geocoder, biased to the camera area).
let PLACES = { items: null, at: 0 };
async function placeCatalogue() {
  if (PLACES.items && Date.now() - PLACES.at < 60000) return PLACES.items;
  try { PLACES = { items: (await api("/api/routes/places?limit=200")).items, at: Date.now() }; } catch (_) { PLACES = { items: [], at: Date.now() }; }
  return PLACES.items;
}
const PLACE_KINDS = { area: "Areas with cameras", place: "Saved places", geofence: "Geofences", camera: "Camera sites", map: "Map search" };
function placePicker(input, onPick) {
  // wraps <input> in a combo box; the chosen place is kept in input.dataset.lat / lon (cleared when the text is edited)
  const wrap = document.createElement("div"); wrap.className = "combo"; input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const list = document.createElement("div"); list.className = "combo-list hidden"; wrap.appendChild(list);
  input.setAttribute("autocomplete", "off");
  let items = [], active = -1, timer = 0, mapHits = [], lastQ = null;
  const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const pick = (it) => { input.value = it.name; input.dataset.lat = it.lat; input.dataset.lon = it.lon; input.dataset.label = it.label || ""; input.title = `${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}${it.label ? " · " + it.label : ""}`; hide(); if (onPick) onPick(it); };
  const hide = () => { list.classList.add("hidden"); active = -1; };
  const render = () => {
    const q = norm(input.value);
    const base = (PLACES.items || []).filter((p) => !q || norm(p.name).includes(q) || norm(p.label).includes(q));
    items = [...base.slice(0, 40), ...mapHits];
    if (q && !items.length && lastQ !== q) items.push({ kind: "map", name: input.value.trim(), label: "search the map for this name", lat: null, lon: null, _search: true });
    if (!items.length) { list.innerHTML = `<div class="combo-empty muted small">${q ? "No place matches — keep typing (3+ letters searches the map), or enter <code>lat, lon</code>" : "No camera has coordinates yet — type a place name or <code>lat, lon</code>"}</div>`; list.classList.remove("hidden"); return; }
    let html = "", last = "";
    items.forEach((it, i) => {
      if (it.kind !== last) { html += `<div class="combo-group">${PLACE_KINDS[it.kind] || it.kind}</div>`; last = it.kind; }
      html += `<div class="combo-item ${i === active ? "active" : ""}" data-i="${i}"><span class="ci-name">${it.kind === "camera" ? "📷 " : it.kind === "area" ? "▣ " : it.kind === "geofence" ? "◯ " : it.kind === "map" ? "🔍 " : "📍 "}${esc(it.name)}</span><span class="ci-label muted small">${esc(it.label || "")}</span></div>`;
    });
    list.innerHTML = html; list.classList.remove("hidden");
    $$(".combo-item", list).forEach((el) => { el.onmousedown = (ev) => { ev.preventDefault(); const it = items[+el.dataset.i]; if (it._search) return searchMap(true); pick(it); }; });
    const act = $(".combo-item.active", list); if (act) act.scrollIntoView({ block: "nearest" });
  };
  const searchMap = async (force) => {
    const q = input.value.trim(); if (q.length < 3) { mapHits = []; return render(); }
    if (q === lastQ && !force) return render();
    lastQ = q;
    try { const r = await api(`/api/routes/places?q=${encodeURIComponent(q)}&geocode=true&limit=40`); if (input.value.trim() !== q) return; mapHits = r.items.filter((p) => p.kind === "map"); }
    catch (_) { mapHits = []; }
    render();
  };
  input.addEventListener("focus", async () => { await placeCatalogue(); render(); });
  input.addEventListener("input", () => { delete input.dataset.lat; delete input.dataset.lon; input.title = ""; render(); clearTimeout(timer); timer = setTimeout(() => searchMap(false), 600); });
  input.addEventListener("blur", () => setTimeout(hide, 120));
  input.addEventListener("keydown", (ev) => {
    if (list.classList.contains("hidden")) return;
    if (ev.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = Math.max(0, active - 1); render(); ev.preventDefault(); }
    else if (ev.key === "Enter" && active >= 0) { const it = items[active]; ev.preventDefault(); if (it._search) searchMap(true); else pick(it); }
    else if (ev.key === "Escape") hide();
  });
  return { set: (w) => { if (w && w.lat != null) { input.value = w.name; input.dataset.lat = w.lat; input.dataset.lon = w.lon; input.dataset.label = w.label || ""; input.title = `${(+w.lat).toFixed(5)}, ${(+w.lon).toFixed(5)}${w.label ? " · " + w.label : ""}`; } else input.value = w?.name || w || ""; } };
}
function placeValue(input) {
  // what the API gets for one place: {name, lat, lon} when picked from the list (or typed as lat, lon), else the text (geocoded by the server)
  const x = input.value.trim(); if (!x) return null;
  if (input.dataset.lat) return { name: x, lat: +input.dataset.lat, lon: +input.dataset.lon, label: input.dataset.label || "" };
  const m = x.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/); return m ? { name: x, lat: +m[1], lon: +m[2] } : x;
}

async function routeDialog(r) {
  const wps = r?.waypoints || [];
  const src = wps[0] || null, dst = wps.length > 1 ? wps[wps.length - 1] : null;
  let via = wps.slice(1, -1).map((w) => ({ name: w.name, lat: w.lat, lon: w.lon, label: w.label || "" }));
  const camOpts = (await allCameras()).map((c) => `<option value="${esc(c.id)}" ${(r?.camera_ids || []).includes(c.id) ? "selected" : ""}>${esc(c.name)} (${esc(c.department)})</option>`).join("");
  modal(`<h3>${r ? "Edit route" : "New VIP route / corridor"}</h3>
    <p class="muted small">Pick the <b>Source</b> and <b>Destination</b> from the list (areas where cameras are, saved places, camera sites, or search the map by typing), or type <code>lat, lon</code>. <b>Only a source</b> gives every camera within the distance below (a venue, bridge, junction). Leave both empty and use the road / area keywords for "a road inside an area" (they must appear in the cameras' address, zone or tags).</p>
    <form id="route-form" class="search-form" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Name <input name="name" required value="${esc(r?.name || "")}" placeholder="VIP: Amroha → Delhi"></label>
      <label>Priority <select name="priority"><option value="normal" ${r?.priority !== "vip" ? "selected" : ""}>normal</option><option value="vip" ${r?.priority === "vip" ? "selected" : ""}>VIP</option></select></label>
      <label>Source (start) <input name="src" placeholder="choose or type a place…"></label>
      <label>Destination (end) <input name="dst" placeholder="choose or type — empty = around the source only"></label>
      <label style="grid-column:1/3">Via (optional, in order) <div class="via-row"><div id="via-chips" class="route-cams"></div><input name="via_add" placeholder="add a place on the way…"></div></label>
      <label style="grid-column:1/3">Allocate cameras (always on this route, even off the path) <select name="camera_ids" multiple size="5">${camOpts}</select><span class="muted small">Ctrl / Cmd-click to select several</span></label>
      <label>Match cameras within (m) <input name="buffer_m" type="number" min="50" max="20000" value="${r?.buffer_m || 500}"></label>
      <label class="check"><input type="checkbox" name="follow_roads" checked> follow roads (routing service)</label>
      <label>Road keyword(s) — optional, must appear in camera address / tags <input name="road" value="${esc(r?.road || "")}" placeholder="NH24, NH-24"></label>
      <label>Area keyword(s) — optional, must appear in camera zone / ward / address <input name="area" value="${esc(r?.area || "")}" placeholder="Delhi"></label>
      <label>Department (optional) <input name="department" value="${esc(r?.department || "")}" placeholder="Police"></label>
      <label>Description <input name="description" value="${esc(r?.description || "")}"></label>
      <div style="grid-column:1/3;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn ghost" type="button" id="route-preview">Preview cameras</button><button class="btn primary">${r ? "Save" : "Create route"}</button><span class="muted small" id="route-preview-out"></span></div>
    </form>`);
  const f = $("#route-form");
  placePicker(f.src).set(src); placePicker(f.dst).set(dst);
  const drawVia = () => { $("#via-chips").innerHTML = via.map((w, i) => `<span class="rc" title="${w.lat != null ? (+w.lat).toFixed(5) + ", " + (+w.lon).toFixed(5) : "located when saving"}"><span class="n">${i + 1}</span>${esc(w.name)}<button type="button" class="x" data-i="${i}" title="remove">×</button></span>`).join("") || '<span class="muted small">none</span>'; $$("#via-chips .x").forEach((b) => b.onclick = () => { via.splice(+b.dataset.i, 1); drawVia(); }); };
  drawVia();
  placePicker(f.via_add, (it) => { via.push({ name: it.name, lat: it.lat, lon: it.lon, label: it.label || "" }); f.via_add.value = ""; delete f.via_add.dataset.lat; drawVia(); });
  f.via_add.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && f.via_add.value.trim() && !f.via_add.dataset.lat) { ev.preventDefault(); const v = placeValue(f.via_add); via.push(typeof v === "string" ? { name: v } : v); f.via_add.value = ""; drawVia(); } });
  const body = () => ({ name: f.name.value.trim(), priority: f.priority.value, description: f.description.value.trim(), buffer_m: +f.buffer_m.value || 500,
    follow_roads: f.follow_roads.checked, road: f.road.value.trim(), area: f.area.value.trim(), department: f.department.value.trim(),
    camera_ids: [...f.camera_ids.selectedOptions].map((o) => o.value),
    waypoints: [placeValue(f.src), ...via.map((w) => (w.lat != null ? w : w.name)), placeValue(f.dst)].filter(Boolean) });
  const nearestNote = (pv) => pv.nearest ? ` — nearest camera <b>${esc(pv.nearest.name)}</b> is ${(pv.nearest.distance_m / 1000).toFixed(1)} km from the route; <button type="button" class="btn ghost small" id="route-widen">use ${pv.nearest.suggest_buffer_m} m</button>` : "";
  $("#route-preview").onclick = async () => {
    const out = $("#route-preview-out"); out.textContent = "locating places…";
    try {
      const pv = await api("/api/routes/preview", { method: "POST", body: JSON.stringify(body()) });
      const where = pv.waypoints.map((w) => `${esc(w.name)}${w.label ? ` <span class="muted" title="${esc(w.label)}">(${esc(w.label.split(",").slice(0, 2).join(","))})</span>` : ""}`).join(" → ");
      out.innerHTML = `<b>${pv.camera_count}</b> camera(s)${pv.length_km ? ` · ${pv.length_km} km` : ""}${where ? ` · ${where}` : ""}: ${pv.cameras.slice(0, 8).map((c) => esc(c.name)).join(", ")}${pv.camera_count > 8 ? "…" : ""}${nearestNote(pv)}`;
      const w = $("#route-widen"); if (w) w.onclick = () => { f.buffer_m.value = pv.nearest.suggest_buffer_m; $("#route-preview").click(); };
    } catch (e) { out.innerHTML = `<span class="bad-chip">${esc(e.message)}</span>`; }
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const saved = await api(r ? `/api/routes/${r.id}` : "/api/routes", { method: r ? "PATCH" : "POST", body: JSON.stringify(body()) });
      closeModal(); toast(`${saved.name}: ${saved.camera_count} camera(s) on the route`, saved.camera_count ? "ok" : "warn");
      await loadRoutes(); if ($("#map-route")) { $("#map-route").value = saved.id; showRoute(saved.id); }
    } catch (e) { toast(e.message, "err"); }
  };
}

// ------------------------------------------------------------------ external lookups (Vahan / Sarathi)
async function doLookup(kind, value) {
  const out = $("#lookup-result");
  if (!value.trim()) return toast("Enter a value to look up", "warn");
  out.innerHTML = '<span class="muted small">looking up…</span>';
  try {
    const r = await api(`/api/lookup/${kind}/${encodeURIComponent(value.trim())}`);
    out.innerHTML = `<div class="panel-head"><h3>${kind === "vahan" ? "Vehicle" : "Licence"} ${esc(r.value)}</h3><span class="muted small">${r.cached ? "cached · " : ""}${r.ms} ms</span></div>
      <table class="table"><tbody>${r.rows.map(([k, v]) => `<tr><td class="muted" style="width:220px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) { out.innerHTML = `<span class="bad-chip">${esc(e.message)}</span>${/not configured/.test(e.message) && has("admin") ? ' <button class="btn ghost small" data-go="admin">Configure in Admin</button>' : ""}`; $$("#lookup-result [data-go]").forEach((b) => b.onclick = () => show("admin")); }
}

// ------------------------------------------------------------------ external APIs (Admin)
async function loadIntegrationsCfg() {
  const box = $("#integrations"); if (!box) return;
  let st; try { st = await api("/api/integrations"); } catch (e) { box.innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
  box.innerHTML = st.integrations.map((i) => `<div class="card integration" data-name="${esc(i.name)}">
    <b>${esc(i.label)} ${i.enabled ? '<span class="ok-chip">on</span>' : '<span class="tagchip">off</span>'}${i.source === "env" ? ' <span class="tagchip" title="from VAHAN_URL in .env">env</span>' : ""}</b>
    <div class="muted small">${esc(i.help)}</div>
    <label class="check"><input type="checkbox" data-f="enabled" ${i.enabled ? "checked" : ""}> enabled</label>
    <label>URL (with ${esc(i.placeholder)}) <input data-f="url" value="${esc(i.url)}" placeholder="https://api.example.gov.in/vahan/${esc(i.placeholder)}"></label>
    <div class="row"><label>Method <select data-f="method"><option ${i.method === "GET" ? "selected" : ""}>GET</option><option ${i.method === "POST" ? "selected" : ""}>POST</option></select></label>
      <label>Auth <select data-f="auth">${st.auth_types.map((a) => `<option ${i.auth === a ? "selected" : ""}>${a}</option>`).join("")}</select></label></div>
    <div class="row"><label>Header / query name <input data-f="header_name" value="${esc(i.header_name)}"></label><label>Username (basic auth) <input data-f="username" value="${esc(i.username)}"></label></div>
    <label>API key / token / password <input data-f="secret" type="password" autocomplete="new-password" placeholder="${i.has_secret ? "•••••• (saved — leave blank to keep)" : "paste the key"}"></label>
    <label>Extra headers (JSON) <input data-f="extra_headers" value="${esc(JSON.stringify(i.extra_headers || {}))}"></label>
    ${i.method === "POST" || i.name === "custom" ? `<label>POST body template (JSON, with ${esc(i.placeholder)}) <textarea data-f="body" rows="2">${esc(i.body || "")}</textarea></label>` : `<input type="hidden" data-f="body" value="${esc(i.body || "")}">`}
    <div class="row"><label>Timeout (s) <input data-f="timeout_s" type="number" min="3" max="60" value="${i.timeout_s}"></label><label>Cache (s) <input data-f="cache_s" type="number" min="0" max="86400" value="${i.cache_s}"></label></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary small" data-int-save="${esc(i.name)}">Save</button><input data-f="test_value" placeholder="${esc(i.sample || "value to test")}" style="width:170px"><button class="btn ghost small" data-int-test="${esc(i.name)}">Test</button>${i.has_secret ? `<button class="btn ghost small" data-int-clear="${esc(i.name)}">Remove key</button>` : ""}
      <span class="muted small">${i.last_test ? `last test ${i.last_test.ok ? '<span class="ok-chip">ok</span>' : '<span class="bad-chip">failed</span>'} ${esc(fmtTime(i.last_test.at))}: ${esc(i.last_test.detail)}` : ""}${i.updated_by ? ` · saved by ${esc(i.updated_by)}` : ""}</span></div>
    <div class="test-out" data-out="${esc(i.name)}"></div></div>`).join("");
  const read = (card) => { const v = (f) => $(`[data-f="${f}"]`, card); return { enabled: v("enabled").checked, url: v("url").value.trim(), method: v("method").value, auth: v("auth").value, header_name: v("header_name").value.trim(),
    username: v("username").value.trim(), secret: v("secret").value, extra_headers: v("extra_headers").value.trim() || "{}", body: v("body").value, timeout_s: +v("timeout_s").value, cache_s: +v("cache_s").value }; };
  $$("[data-int-save]", box).forEach((b) => b.onclick = async () => { const card = b.closest(".integration"); try { await api(`/api/integrations/${b.dataset.intSave}`, { method: "PUT", body: JSON.stringify(read(card)) }); toast(`${b.dataset.intSave} saved`, "ok"); loadIntegrationsCfg(); } catch (e) { toast(e.message, "err"); } });
  $$("[data-int-clear]", box).forEach((b) => b.onclick = async () => { const card = b.closest(".integration"); try { await api(`/api/integrations/${b.dataset.intClear}`, { method: "PUT", body: JSON.stringify({ ...read(card), enabled: false, clear_secret: true }) }); loadIntegrationsCfg(); } catch (e) { toast(e.message, "err"); } });
  $$("[data-int-test]", box).forEach((b) => b.onclick = async () => {
    const card = b.closest(".integration"), out = $(`[data-out="${b.dataset.intTest}"]`); out.innerHTML = '<span class="muted small">calling…</span>';
    try {
      const r = await api(`/api/integrations/${b.dataset.intTest}/test?value=${encodeURIComponent($('[data-f="test_value"]', card).value.trim())}`, { method: "POST" });
      out.innerHTML = r.ok ? `<span class="ok-chip">ok · ${r.ms} ms</span><table>${r.rows.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>` : `<span class="bad-chip">${esc(r.error)}</span>`;
    } catch (e) { out.innerHTML = `<span class="bad-chip">${esc(e.message)}</span>`; }
  });
}

// ------------------------------------------------------------------ pagination for every table (client side)
// Any <table class="table"> with an id gets a pager under it as soon as it has more rows than one page. Tables that
// page on the server (audit) or are editors (roles, routes, archival) opt out via PAGER.skip or class "no-page".
const PAGER = { size: 25, sizes: [10, 25, 50, 100, 0], skip: new Set(["audit-table", "routes-table", "roles-table", "arch-table"]) };
function autoPage(tbl) {
  if (!tbl.id || PAGER.skip.has(tbl.id) || tbl.classList.contains("no-page")) return;
  const tb = tbl.tBodies[0]; if (!tb) return;
  const rows = [...tb.rows];
  let saved = PAGER.size; try { saved = +(localStorage.getItem(`uvp-pg-${tbl.id}`) ?? PAGER.size); } catch (_) {}
  const st = tbl._pg || (tbl._pg = { page: 1, size: Number.isFinite(saved) ? saved : PAGER.size });
  const n = rows.length, size = st.size, pages = size ? Math.max(1, Math.ceil(n / size)) : 1;
  if (st.page > pages) st.page = pages;
  rows.forEach((r, i) => { r.style.display = !size || (i >= (st.page - 1) * size && i < st.page * size) ? "" : "none"; });
  let pg = tbl.nextElementSibling;
  if (!pg || !pg.classList.contains("autopager")) { pg = document.createElement("div"); pg.className = "pager autopager"; tbl.insertAdjacentElement("afterend", pg); }
  if (n <= Math.min(PAGER.size, size || PAGER.size) && st.size === PAGER.size) { pg.innerHTML = ""; pg.style.display = "none"; return; }
  pg.style.display = "";
  const btn = (p, label, cls = "") => `<button class="btn ghost small ${cls}" data-pg="${p}" ${p < 1 || p > pages ? "disabled" : ""}>${label}</button>`;
  const around = []; for (let p = Math.max(1, st.page - 2); p <= Math.min(pages, st.page + 2); p++) around.push(p);
  const from = size ? (st.page - 1) * size + 1 : 1, to = size ? Math.min(n, st.page * size) : n;
  pg.innerHTML = `<span>${n ? `${from}–${to} of ${n}` : "0 rows"} · <select data-pgsize title="rows per page">${PAGER.sizes.map((x) => `<option value="${x}" ${x === size ? "selected" : ""}>${x ? x + " / page" : "all"}</option>`).join("")}</select></span>
    <span>${pages > 1 ? `${btn(1, "«")}${btn(st.page - 1, "‹")}${around[0] > 1 ? "<span>…</span>" : ""}${around.map((p) => btn(p, p, p === st.page ? "active" : "")).join("")}${around.at(-1) < pages ? "<span>…</span>" : ""}${btn(st.page + 1, "›")}${btn(pages, "»")}` : ""}</span>`;
  $$("[data-pg]", pg).forEach((b) => b.onclick = () => { st.page = +b.dataset.pg; autoPage(tbl); });
  $("[data-pgsize]", pg).onchange = (e) => { st.size = +e.target.value; st.page = 1; try { localStorage.setItem(`uvp-pg-${tbl.id}`, st.size); } catch (_) {} autoPage(tbl); };
}
(function watchTables() {
  let pending = new Set(), raf = 0;
  const flush = () => { raf = 0; pending.forEach(autoPage); pending.clear(); };
  new MutationObserver((muts) => {
    for (const m of muts) { const t = m.target.nodeType === 1 ? m.target.closest("table.table") : null; if (t && !t.closest(".autopager")) pending.add(t); }
    if (pending.size && !raf) raf = requestAnimationFrame(flush);
  }).observe(document.body, { childList: true, subtree: true });
})();

// ------------------------------------------------------------------ new channels on gateways / NVRs without a camera-list API
async function scanSource(sid) {
  let d; try { d = await api(`/api/sources/${sid}/channels`); } catch (e) { return toast(e.message, "err"); }
  modal(`<h3>Find new cameras on ${esc(sid)}</h3>
    <p class="muted small">The gateway has no camera list, so channels are tried one by one (one extra stream at a time, ~8 s each). Currently <b>${d.channels}</b> channels. Template: <code>${esc(d.template)}</code></p>
    <form id="scan-form" class="search-form"><label>From channel <input name="start" type="number" min="1" value="${d.channels + 1}"></label><label>To channel <input name="stop" type="number" min="1" value="${d.channels + 10}"></label><button class="btn primary">Scan</button><span class="muted small" id="scan-note"></span></form>
    <div id="scan-out" style="margin-top:10px"></div>`);
  $("#scan-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target; $("#scan-note").textContent = "scanning… (about 8 s per channel)"; $("#scan-out").innerHTML = "";
    try {
      const r = await api(`/api/sources/${sid}/scan?start=${+f.start.value}&stop=${+f.stop.value}`, { method: "POST" });
      $("#scan-note").textContent = "";
      $("#scan-out").innerHTML = `<table class="table"><thead><tr><th>Channel</th><th>Result</th></tr></thead><tbody>${r.results.map((x) => `<tr><td>cam${String(x.channel).padStart(2, "0")}</td><td>${x.ok ? `<span class="ok-chip">live · ${esc(x.codec)} ${esc(x.size || "")}</span>` : `<span class="muted">${esc(x.error)}</span>`}</td></tr>`).join("")}</tbody></table>
        ${r.stopped_early ? '<p class="bad-chip">Stopped: the gateway answered 401 — session cap or lock-out; try again in 10 minutes.</p>' : ""}
        ${r.found.length ? `<p><b>${r.found.length}</b> new channel(s) answer (${r.found.join(", ")}). <button class="btn primary small" id="scan-add">Add them — set channels to ${r.suggested_channels}</button></p>` : '<p class="muted small">No new channels in this range.</p>'}`;
      const add = $("#scan-add");
      if (add) add.onclick = async () => { try { await api(`/api/sources/${sid}/channels`, { method: "PUT", body: JSON.stringify({ channels: r.suggested_channels }) }); closeModal(); toast(`${sid}: channels set to ${r.suggested_channels} — new cameras appear within a minute`, "ok"); setTimeout(loadSources, 1500); } catch (e) { toast(e.message, "err"); } };
    } catch (e) { $("#scan-note").innerHTML = `<span class="bad-chip">${esc(e.message)}</span>`; }
  };
}

// ------------------------------------------------------------------ per-user access (departments + cameras)
let ALL_CAMS = null;
async function allCameras() {
  // every registered camera (including registry-only ones without a feed yet), for pickers
  if (ALL_CAMS) return ALL_CAMS;
  try { ALL_CAMS = (await api("/api/registry")).map((c) => ({ id: c.id, name: c.name, department: c.department })); }
  catch (_) { ALL_CAMS = S.cameras.map((c) => ({ id: c.id, name: c.name, department: c.department })); }
  if (!ALL_CAMS.length) ALL_CAMS = S.cameras.map((c) => ({ id: c.id, name: c.name, department: c.department }));
  setTimeout(() => { ALL_CAMS = null; }, 60000);
  return ALL_CAMS.sort((a, b) => a.name.localeCompare(b.name));
}
async function userAccessDialog(u) {
  if (!u) return;
  const cams = await allCameras();
  const depts = [...new Set(cams.map((c) => c.department))].sort();
  modal(`<h3>Access for ${esc(u.username)}</h3>
    <p class="muted small">An account sees every camera of its departments plus the cameras ticked below. For a guard who may see only particular cameras: choose <b>no department</b> and tick the cameras.</p>
    <form id="access-form" class="search-form" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Role <select name="role">${(ROLES?.roles || [{ name: "viewer" }, { name: "analyst" }, { name: "supervisor" }, { name: "admin" }]).map((r) => `<option ${u.role === r.name ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      <label>Departments <select name="deptmode"><option value="*" ${u.departments.includes("*") ? "selected" : ""}>all departments</option><option value="pick" ${u.departments.length && !u.departments.includes("*") ? "selected" : ""}>selected departments</option><option value="none" ${!u.departments.length ? "selected" : ""}>no department — only the cameras below</option></select></label>
      <label style="grid-column:1/3" id="dept-pick" class="${u.departments.length && !u.departments.includes("*") ? "" : "hidden"}">Departments <select name="departments" multiple size="4">${depts.map((d) => `<option ${u.departments.includes(d) ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label>
      <label style="grid-column:1/3">Cameras this account may see (in addition to its departments) <input id="cam-filter" placeholder="filter…" style="margin-bottom:4px"><select name="cameras" multiple size="8">${cams.map((c) => `<option value="${esc(c.id)}" ${(u.cameras || []).includes(c.id) ? "selected" : ""}>${esc(c.name)} (${esc(c.department)})</option>`).join("")}</select><span class="muted small">Ctrl / Cmd-click to select several · <span id="cam-count">${(u.cameras || []).length} selected</span></span></label>
      <div style="grid-column:1/3;display:flex;gap:8px"><button class="btn primary">Save access</button><button class="btn ghost" type="button" id="access-cancel">Cancel</button></div>
    </form>`);
  const f = $("#access-form");
  f.deptmode.onchange = () => $("#dept-pick").classList.toggle("hidden", f.deptmode.value !== "pick");
  f.cameras.onchange = () => $("#cam-count").textContent = `${f.cameras.selectedOptions.length} selected`;
  $("#cam-filter").oninput = (e) => { const q = e.target.value.toLowerCase(); [...f.cameras.options].forEach((o) => o.hidden = q && !o.textContent.toLowerCase().includes(q)); };
  $("#access-cancel").onclick = closeModal;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const departments = f.deptmode.value === "*" ? ["*"] : f.deptmode.value === "none" ? [] : [...f.departments.selectedOptions].map((o) => o.value);
    const cameras = [...f.cameras.selectedOptions].map((o) => o.value);
    if (!departments.length && !cameras.length) return toast("Pick at least one department or one camera", "err");
    try { await api(`/api/users/${encodeURIComponent(u.username)}`, { method: "PATCH", body: JSON.stringify({ role: f.role.value, departments, cameras }) }); closeModal(); toast(`${u.username}: access saved (takes effect at the next sign-in)`, "ok"); loadAdmin(); }
    catch (e) { toast(e.message, "err"); }
  };
}

// ------------------------------------------------------------------ admin sub-sidebar
const ADMIN_SECTIONS = [
  ["Overview", [["overview", "Compliance", "#compliance-cards"]]],
  ["Access", [["perms", "Permissions", "#perms-panel"], ["users", "Users", "#user-form", "#users-table"], ["roles", "Roles & permissions", "#roles-panel"], ["grants", "Access grants", "#grant-form", "#grants-table"], ["holds", "Legal holds", "#hold-form", "#holds-table"]]],
  ["Data", [["archival", "Archival policy", "#archival-panel"], ["dpdp", "DPDP requests", "#dpdp-form"]]],
  ["Integrations", [["external", "External APIs", "#integrations-panel"], ["notify", "Notifications", "#notif-table"], ["keys", "API keys", "#key-form", "#keys-table"], ["hooks", "Webhooks", "#hook-form", "#hooks-table"], ["tenants", "Tenants & presets", "#tenants-list"]]],
];
let ADMIN_SEC = "overview";
try { ADMIN_SEC = localStorage.getItem("uvp-admin-sec") || "overview"; } catch (_) {}
function adminSection(id) {
  const all = ADMIN_SECTIONS.flatMap(([, items]) => items);
  if (!all.some((x) => x[0] === id)) id = "overview";
  ADMIN_SEC = id; try { localStorage.setItem("uvp-admin-sec", id); } catch (_) {}
  const nav = $("#admin-nav");
  if (nav && !nav.children.length) nav.innerHTML = ADMIN_SECTIONS.map(([grp, items]) => `<div class="grp">${esc(grp)}</div>` + items.map(([sid, label]) => `<button data-sec="${sid}">${esc(label)}</button>`).join("")).join("");
  $$("#admin-nav button").forEach((b) => { b.classList.toggle("active", b.dataset.sec === id); b.onclick = () => adminSection(b.dataset.sec); });
  const block = (sel) => { const el = $(sel); return el ? (el.closest(".panel") || el) : null; };
  all.forEach(([sid, , ...sels]) => sels.forEach((sel) => block(sel)?.classList.toggle("hidden", sid !== id)));
  const cur = all.find((x) => x[0] === id);
  if ($("#admin-sub")) $("#admin-sub").textContent = cur ? cur[1] : "";
}

// ------------------------------------------------------------------ Admin -> Permissions (camera permission table)
const PERM_COLORS = { live: "live", playback: "playback", export: "export", search: "search", alerts: "alerts", edit: "edit" };
let PERMS_TAB = "active", PERMS_OPTS = null, PERMS_BOUND = false, PERMS_POLL = null;
function bindPerms() {
  // buttons work even when the first load failed (server restarting); the table refreshes itself every 30 s while open
  if (PERMS_BOUND) return; PERMS_BOUND = true;
  const f = $("#perms-filter");
  $("#perms-grant").onclick = () => permDialog(null);
  $("#perms-refresh").onclick = () => { PERMS_OPTS = null; loadPerms(); };
  $("#perms-apply").onclick = () => loadPerms();
  f.q.oninput = () => { clearTimeout(f._t); f._t = setTimeout(loadPerms, 400); };
  f.scope.onchange = f.grantee_kind.onchange = () => loadPerms();
  $$("#perms-tabs button").forEach((b) => b.onclick = () => { PERMS_TAB = b.dataset.ptab; loadPerms(); });
  if (!PERMS_POLL) PERMS_POLL = setInterval(() => { if (S.view === "admin" && ADMIN_SEC === "perms" && document.visibilityState === "visible") loadPerms(); }, 30000);
}
async function loadPerms() {
  const tbl = $("#perms-table"); if (!tbl) return;
  bindPerms();
  const f = $("#perms-filter");
  const qs = new URLSearchParams({ status: PERMS_TAB });
  if (f.scope.value) qs.set("scope", f.scope.value); if (f.grantee_kind.value) qs.set("grantee_kind", f.grantee_kind.value); if (f.q.value.trim()) qs.set("q", f.q.value.trim());
  let r; try { [r, PERMS_OPTS] = await Promise.all([api(`/api/permissions?${qs}`), PERMS_OPTS || api("/api/permissions/options")]); } catch (e) { $("tbody", tbl).innerHTML = `<tr><td colspan="7" class="muted">${esc(e.message)}</td></tr>`; return; }
  $$("#perms-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.ptab === PERMS_TAB));
  $("#perms-count").textContent = `${r.total} row${r.total === 1 ? "" : "s"}`;
  const chips = (row) => r.perms.map((p) => `<span class="pchip ${PERM_COLORS[p]} ${row.perms.includes(p) ? "" : "off"}" title="${esc(r.labels[p])}${row.perms.includes(p) ? "" : " — not granted"}">${esc(r.labels[p])}</span>`).join("");
  const scope = (row) => row.scope_kind === "all" ? '<span class="scope-chip all">All cameras</span>' : row.scope_kind === "department" ? `<span class="scope-chip dept">${esc(row.scope_value)}</span>` : row.scope_kind === "route" ? `<span class="scope-chip route" title="VIP route — follows the route's cameras">★ ${esc(row.scope_label.replace(/^Route: /, ""))}</span>` : `<span class="scope-chip cam" title="${esc(row.scope_value)}">${esc(row.scope_label)}</span>`;
  const status = (row) => row.status === "active" ? "" : ` <span class="${row.status === "revoked" ? "bad-chip" : "warn-chip"}">${row.status}${row.revoked_by ? " by " + esc(row.revoked_by) : ""}</span>`;
  $("tbody", tbl).innerHTML = r.items.map((row) => `<tr class="${row.status === "active" ? "" : "muted"}">
    <td>${scope(row)}</td><td>${row.grantee_kind === "role" ? "👥" : "👤"} <b>${esc(row.grantee)}</b>${status(row)}${row.reason ? `<div class="muted small">${esc(row.reason)}</div>` : ""}</td>
    <td><span class="type-chip ${row.grantee_kind}">${row.grantee_kind === "role" ? "Role" : (PERMS_OPTS?.users?.find((u) => u.username === row.grantee)?.role || "user")}</span></td>
    <td class="pchips">${chips(row)}</td><td class="muted">${row.expires_at ? esc(fmtTime(row.expires_at)) : "Never"}</td><td class="muted small">${esc(row.granted_by)}<div>${esc(fmtTime(row.updated_at || row.created_at))}</div></td>
    <td class="nowrap">${row.status === "active" ? `<button class="btn ghost small" data-perm-edit="${esc(row.id)}" title="Change">✎</button> <button class="btn ghost small danger" data-perm-del="${esc(row.id)}" title="Revoke">🗑</button>` : ""}</td></tr>`).join("")
    || `<tr><td colspan="7" class="muted">${PERMS_TAB === "active" ? "No permissions granted yet — press + Grant permission." : "No past permissions."}</td></tr>`;
  $$("[data-perm-del]", tbl).forEach((b) => b.onclick = async () => { const row = r.items.find((x) => x.id === b.dataset.permDel); if (!confirm(`Revoke ${row.grantee}'s permissions on ${row.scope_label}?`)) return; try { await api(`/api/permissions/${b.dataset.permDel}`, { method: "DELETE" }); toast("Permission revoked — applies to signed-in users at once", "ok"); loadPerms(); } catch (e) { toast(e.message, "err"); } });
  $$("[data-perm-edit]", tbl).forEach((b) => b.onclick = () => permDialog(r.items.find((x) => x.id === b.dataset.permEdit)));
}
async function permDialog(row) {
  try { PERMS_OPTS = await api("/api/permissions/options"); } catch (e) { return toast(e.message, "err"); }
  const o = PERMS_OPTS;
  // the picker's choices: all cameras · departments · VIP routes · cameras (grouped by department); several may be ticked
  const choices = [{ k: "all", v: "*", label: "All cameras", grp: "" },
    ...o.departments.map((d) => ({ k: "department", v: d, label: d, grp: "Departments (every camera in it)", sub: `${o.cameras.filter((c) => c.department === d).length} cameras` })),
    ...(o.routes || []).map((r) => ({ k: "route", v: r.id, label: `${r.priority === "vip" ? "★ " : ""}${r.name}`, grp: "VIP routes (follows the route's cameras)", sub: `${r.camera_count} cameras` })),
    ...o.cameras.map((c) => ({ k: "camera", v: c.id, label: c.name, grp: `Cameras · ${c.department || "—"}`, sub: c.id }))];
  const key = (c) => `${c.k}:${c.v}`;
  let picked = new Set(row ? [`${row.scope_kind}:${row.scope_value}`] : []);
  const kind = row?.grantee_kind || "role";
  const exp = row?.expires_at ? new Date(row.expires_at) : null;
  const local = exp ? new Date(exp.getTime() - exp.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  modal(`<h3>${row ? "Change permission" : "Grant camera permission"}</h3>
    <form id="perm-form" class="search-form perm-form" style="display:grid;gap:12px">
      <div><div class="muted small" style="margin-bottom:5px">Cameras ${row ? "" : '<span class="muted">— tick one or more: cameras, departments or VIP routes</span>'}</div>
        <div class="campick ${row ? "disabled" : ""}" id="perm-pick"><div class="campick-chips" id="perm-chips"></div>${row ? "" : '<input id="perm-pick-q" placeholder="Search cameras, departments, routes…" autocomplete="off">'}<div class="campick-list" id="perm-pick-list"></div></div></div>
      <div><div class="muted small" style="margin-bottom:5px">Grant to</div><div class="seg" id="perm-kind"><button type="button" data-k="role" class="${kind === "role" ? "active" : ""}" ${row ? "disabled" : ""}>👥 Role</button><button type="button" data-k="user" class="${kind === "user" ? "active" : ""}" ${row ? "disabled" : ""}>👤 User</button></div></div>
      <label id="perm-role-l" class="${kind === "role" ? "" : "hidden"}">Role <select name="role" ${row ? "disabled" : ""}><option value="">Select role…</option>${o.roles.map((r) => `<option value="${esc(r.name)}" ${row?.grantee === r.name ? "selected" : ""}>${esc(r.name)}${r.description ? " — " + esc(r.description) : ""}</option>`).join("")}</select></label>
      <label id="perm-user-l" class="${kind === "user" ? "" : "hidden"}">User <select name="user" ${row ? "disabled" : ""}><option value="">Select user…</option>${o.users.map((u) => `<option value="${esc(u.username)}" ${row?.grantee === u.username ? "selected" : ""}>${esc(u.username)} (${esc(u.role)})</option>`).join("")}</select></label>
      <div><div class="muted small" style="margin-bottom:5px">Permissions</div><div class="perm-grid">${o.perms.map((p) => `<button type="button" class="perm-btn ${PERM_COLORS[p.id]} ${(row ? row.perms : ["live"]).includes(p.id) ? "on" : ""}" data-p="${p.id}" title="${esc(p.help)}">${esc(p.label)}</button>`).join("")}</div></div>
      <label>Expires (optional) <input name="expires" type="datetime-local" value="${local}"></label>
      <label>Reason (optional) <input name="reason" value="${esc(row?.reason || "")}" placeholder="shift cover, event duty, court order…"></label>
      <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center"><span class="muted small" id="perm-sum"></span><button class="btn ghost" type="button" id="perm-cancel">Cancel</button><button class="btn primary">${row ? "Save" : "Grant permission"}</button></div>
    </form>`);
  const f = $("#perm-form"), list = $("#perm-pick-list"), q = $("#perm-pick-q");
  const drawChips = () => {
    const cs = [...picked].map((k) => choices.find((c) => key(c) === k)).filter(Boolean);
    $("#perm-chips").innerHTML = cs.map((c) => `<span class="scope-chip ${c.k === "all" ? "all" : c.k === "department" ? "dept" : c.k === "route" ? "route" : "cam"}">${esc(c.label)}${row ? "" : ` <button type="button" class="x" data-k="${esc(key(c))}">×</button>`}</span>`).join("") || (row ? "" : '<span class="muted small">nothing selected yet</span>');
    $$("#perm-chips .x").forEach((b) => b.onclick = () => { picked.delete(b.dataset.k); drawChips(); drawList(); });
    const n = cs.length; $("#perm-sum").textContent = n > 1 ? `${n} scopes → ${n} rows` : "";
  };
  const drawList = () => {
    if (!list) return;
    const ql = (q?.value || "").toLowerCase().trim();
    const vis = choices.filter((c) => !ql || c.label.toLowerCase().includes(ql) || (c.sub || "").toLowerCase().includes(ql) || c.grp.toLowerCase().includes(ql));
    let html = "", last = null;
    vis.forEach((c) => { if (c.grp !== last) { html += c.grp ? `<div class="combo-group">${esc(c.grp)}</div>` : ""; last = c.grp; }
      html += `<label class="campick-item ${picked.has(key(c)) ? "on" : ""}"><input type="checkbox" data-k="${esc(key(c))}" ${picked.has(key(c)) ? "checked" : ""}> <span>${esc(c.label)}</span><span class="muted small">${esc(c.sub || "")}</span></label>`; });
    list.innerHTML = html || '<div class="combo-empty muted small">No match</div>';
    $$("input[type=checkbox]", list).forEach((cb) => cb.onchange = () => {
      const k = cb.dataset.k;
      if (cb.checked) { if (k === "all:*") picked = new Set(["all:*"]); else { picked.delete("all:*"); picked.add(k); } } else picked.delete(k);
      drawChips(); drawList();
    });
  };
  drawChips(); drawList();
  if (q) q.oninput = drawList;
  if (row && list) list.remove();                       // editing: the scope is fixed, only the chip is shown
  $$("#perm-kind button").forEach((b) => b.onclick = () => { $$("#perm-kind button").forEach((x) => x.classList.toggle("active", x === b)); $("#perm-role-l").classList.toggle("hidden", b.dataset.k !== "role"); $("#perm-user-l").classList.toggle("hidden", b.dataset.k !== "user"); });
  $$(".perm-btn", f).forEach((b) => b.onclick = () => b.classList.toggle("on"));
  $("#perm-cancel").onclick = closeModal;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const perms = $$(".perm-btn.on", f).map((b) => b.dataset.p);
    if (!perms.length) return toast("Tick at least one permission", "warn");
    const expires_at = f.expires.value ? new Date(f.expires.value).toISOString() : "";
    try {
      if (row) {
        await api(`/api/permissions/${row.id}`, { method: "PATCH", body: JSON.stringify({ perms, expires_at, reason: f.reason.value.trim() }) });
      } else {
        if (!picked.size) return toast("Choose at least one camera, department or route", "warn");
        const k = $("#perm-kind button.active").dataset.k; const grantee = k === "role" ? f.role.value : f.user.value;
        if (!grantee) return toast(`Choose a ${k}`, "warn");
        const scopes = [...picked].map((x) => { const [scope_kind, scope_value] = x.split(/:(.+)/); return { scope_kind, scope_value }; });
        await api("/api/permissions", { method: "POST", body: JSON.stringify({ scopes, grantee_kind: k, grantee, perms, expires_at: expires_at || null, reason: f.reason.value.trim() }) });
      }
      closeModal(); PERMS_TAB = "active"; toast(row ? "Permission updated" : `Permission granted on ${picked.size} scope${picked.size === 1 ? "" : "s"} — signed-in users get it at once`, "ok"); loadPerms();
    } catch (e) { toast(e.message, "err"); }
  };
}

// ------------------------------------------------------------------ notification preferences
async function notifPrefsDialog() {
  let r; try { r = await api("/api/notifications/preferences"); } catch (e) { return toast(e.message, "err"); }
  const p = r.preferences;
  const label = { alert: "Watchlist / challan alerts", incident: "Analytics incidents", camera: "Camera offline / online", device: "Devices connected / removed", detection: "AI detection switch", security: "Security (accounts, roles, lock-outs)", archival: "Archival runs", report: "Scheduled reports", geofence: "Geofence events", system: "System" };
  modal(`<h3>Notification preferences</h3><p class="muted small">What reaches you — in the bell, the menu badge, as pop-ups and spoken aloud. Permissions still apply: you only ever see events from your departments and cameras.</p>
    <form id="prefs-form" class="search-form" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div style="grid-column:1/3"><b class="small">Notify me about</b><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px">${r.kinds.map((k) => `<label class="check"><input type="checkbox" name="kind" value="${k}" ${p.kinds.includes(k) ? "checked" : ""}> ${esc(label[k] || k)}</label>`).join("")}</div></div>
      <label>Minimum severity <select name="min_severity">${r.severities.map((x) => `<option value="${x}" ${p.min_severity === x ? "selected" : ""}>${x === "warn" ? "warning" : x}</option>`).join("")}</select></label>
      <label>Speak aloud from <select name="speak_min_severity">${r.severities.map((x) => `<option value="${x}" ${p.speak_min_severity === x ? "selected" : ""}>${x === "warn" ? "warning" : x}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="toast" ${p.toast ? "checked" : ""}> pop-up for critical notifications</label>
      <label class="check"><input type="checkbox" name="speak" ${p.speak ? "checked" : ""}> speak alerts aloud</label>
      <label class="check"><input type="checkbox" name="badge" ${p.badge ? "checked" : ""}> show unread count on the bell / menu</label>
      <div style="grid-column:1/3;display:flex;gap:8px"><button class="btn primary">Save</button><button class="btn ghost" type="button" id="prefs-cancel">Cancel</button></div>
    </form>`);
  $("#prefs-cancel").onclick = closeModal;
  $("#prefs-form").onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    const body = { kinds: $$("input[name=kind]:checked", f).map((x) => x.value), min_severity: f.min_severity.value, speak_min_severity: f.speak_min_severity.value, toast: f.toast.checked, speak: f.speak.checked, badge: f.badge.checked };
    try { const out = await api("/api/notifications/preferences", { method: "PUT", body: JSON.stringify(body) }); NOTIF.prefs = out.preferences; setSpeak(out.preferences.speak, false); closeModal(); toast("Preferences saved", "ok"); refreshInbox(); if (S.view === "notifications") loadNotifications(); }
    catch (e) { toast(e.message, "err"); }
  };
}

// ------------------------------------------------------------------ geofences
let FENCES = [], FENCE_SEL = null, FENCE_PICK = null;
async function loadFences() {
  try { FENCES = await api("/api/geofences"); } catch (_) { FENCES = []; }
  const sel = $("#map-fence"); if (!sel) return;
  const v = sel.value;
  sel.innerHTML = '<option value="">— none —</option>' + FENCES.map((f) => `<option value="${esc(f.id)}">${esc(f.name)} (${f.camera_count})</option>`).join("");
  sel.value = FENCES.some((f) => f.id === v) ? v : "";
  if (MAP) drawFences();
}
function drawFences() {
  MAP.fences = MAP.fences || L.layerGroup().addTo(MAP); MAP.fences.clearLayers();
  FENCES.forEach((f) => {
    const sel = FENCE_SEL && FENCE_SEL.id === f.id, col = f.active ? (sel ? "#ef4444" : "#a855f7") : "#94a3b8";
    const shape = f.kind === "polygon" ? L.polygon(f.polygon, { color: col, weight: sel ? 3 : 2, fillOpacity: 0.12 }) : L.circle([f.lat, f.lon], { radius: f.radius_m, color: col, weight: sel ? 3 : 2, fillOpacity: 0.12 });
    shape.bindTooltip(`${esc(f.name)} · ${f.camera_count} camera${f.camera_count === 1 ? "" : "s"}`).on("click", () => { $("#map-fence").value = f.id; showFence(f.id); }).addTo(MAP.fences);
  });
}
function showFence(id) {
  FENCE_SEL = FENCES.find((f) => f.id === id) || null;
  ["#fence-wall", "#fence-edit", "#fence-del"].forEach((b) => { const el = $(b); if (el) el.disabled = !FENCE_SEL; });
  if (MAP) drawFences();
  if (!FENCE_SEL) { $("#fence-info").textContent = "Pick a location on the map and draw a circle or polygon around it: the cameras inside are grouped, and alerts / incidents from them raise a geofence notification."; $("#fence-cams").innerHTML = ""; return; }
  const f = FENCE_SEL;
  $("#fence-info").innerHTML = `<b>${esc(f.name)}</b> — ${f.kind === "circle" ? `circle, radius ${f.radius_m} m` : `polygon, ${f.polygon.length} points`} · ${f.area_km2} km² · notifies on ${f.notify_kinds.join(", ") || "nothing"} (${f.severity})${f.active ? "" : ' · <span class="bad-chip">inactive</span>'} · <b>${f.camera_count}</b> camera${f.camera_count === 1 ? "" : "s"}${f.description ? `<div class="muted">${esc(f.description)}</div>` : ""}`;
  $("#fence-cams").innerHTML = f.cameras.map((c, i) => `<span class="rc ${c.registry_only ? "reg" : c.status === "offline" ? "off" : ""}" data-lat="${c.lat}" data-lon="${c.lon}"><span class="n">${i + 1}</span>${esc(c.name)}${c.distance_m != null ? `<span class="km">${c.distance_m} m</span>` : ""}</span>`).join("") || '<span class="muted small">No cameras inside this geofence.</span>';
  $$("#fence-cams .rc").forEach((el) => el.onclick = () => MAP && MAP.setView([+el.dataset.lat, +el.dataset.lon], 16));
  if (MAP) { const b = f.kind === "polygon" ? L.polygon(f.polygon).getBounds() : L.circle([f.lat, f.lon], { radius: f.radius_m }).getBounds(); MAP.fitBounds(b, { padding: [30, 30] }); }
}
function fenceDialog(f) {
  const draft = f ? { ...f } : { kind: "circle", radius_m: 500, polygon: [], notify_kinds: ["alert", "incident"], severity: "warn", active: true, lat: null, lon: null };
  modal(`<h3>${f ? "Edit geofence" : "New geofence"}</h3>
    <p class="muted small">Close this box, then click on the map to pick the centre (circle) or the corners (polygon); the dialog re-opens with the points filled in. You can also type coordinates.</p>
    <form id="fence-form" class="search-form" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label>Name <input name="name" required value="${esc(draft.name || "")}" placeholder="Paldi circle zone"></label>
      <label>Shape <select name="kind"><option value="circle" ${draft.kind === "circle" ? "selected" : ""}>circle around a point</option><option value="polygon" ${draft.kind === "polygon" ? "selected" : ""}>polygon (drawn corners)</option></select></label>
      <label>Centre lat, lon <input name="center" value="${draft.lat != null ? `${(+draft.lat).toFixed(5)}, ${(+draft.lon).toFixed(5)}` : ""}" placeholder="click the map"></label>
      <label>Radius (m) <input name="radius_m" type="number" min="20" max="50000" value="${draft.radius_m || 500}"></label>
      <label style="grid-column:1/3">Polygon corners (lat, lon per line) <textarea name="polygon" rows="3">${(draft.polygon || []).map((p) => `${(+p[0]).toFixed(5)}, ${(+p[1]).toFixed(5)}`).join("\n")}</textarea></label>
      <label>Notify on <select name="notify_kinds" multiple size="3"><option value="alert" ${draft.notify_kinds.includes("alert") ? "selected" : ""}>watchlist / challan alerts</option><option value="incident" ${draft.notify_kinds.includes("incident") ? "selected" : ""}>analytics incidents</option><option value="camera" ${draft.notify_kinds.includes("camera") ? "selected" : ""}>camera offline / online</option></select></label>
      <label>Severity <select name="severity"><option ${draft.severity === "info" ? "selected" : ""}>info</option><option ${draft.severity === "warn" ? "selected" : ""}>warn</option><option ${draft.severity === "critical" ? "selected" : ""}>critical</option></select></label>
      <label>Department (optional) <input name="department" value="${esc(draft.department || "")}"></label>
      <label class="check"><input type="checkbox" name="active" ${draft.active !== false ? "checked" : ""}> active</label>
      <div style="grid-column:1/3;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn ghost" type="button" id="fence-pick">Pick on map</button><button class="btn ghost" type="button" id="fence-preview">Preview cameras</button><button class="btn primary">${f ? "Save" : "Create geofence"}</button><span class="muted small" id="fence-preview-out"></span></div>
    </form>`);
  const form = $("#fence-form");
  const body = () => {
    const c = form.center.value.split(",").map((x) => parseFloat(x));
    const poly = form.polygon.value.split(/\n/).map((l) => l.split(",").map((x) => parseFloat(x))).filter((p) => p.length === 2 && p.every(Number.isFinite));
    return { name: form.name.value.trim(), kind: form.kind.value, lat: Number.isFinite(c[0]) ? c[0] : undefined, lon: Number.isFinite(c[1]) ? c[1] : undefined, radius_m: +form.radius_m.value || 500,
      polygon: poly, notify_kinds: [...form.notify_kinds.selectedOptions].map((o) => o.value), severity: form.severity.value, department: form.department.value.trim(), active: form.active.checked };
  };
  $("#fence-pick").onclick = () => { FENCE_PICK = { ...body(), id: f?.id, pts: [] }; closeModal(); startFencePick(); };
  $("#fence-preview").onclick = async () => { const out = $("#fence-preview-out"); try { const pv = await api("/api/geofences/preview", { method: "POST", body: JSON.stringify(body()) }); out.innerHTML = `<b>${pv.camera_count}</b> camera(s) · ${pv.area_km2} km²: ${pv.cameras.slice(0, 8).map((c) => esc(c.name)).join(", ")}`; } catch (e) { out.innerHTML = `<span class="bad-chip">${esc(e.message)}</span>`; } };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try { const saved = await api(f ? `/api/geofences/${f.id}` : "/api/geofences", { method: f ? "PATCH" : "POST", body: JSON.stringify(body()) }); closeModal(); toast(`${saved.name}: ${saved.camera_count} camera(s) inside`, "ok"); await loadFences(); $("#map-fence").value = saved.id; showFence(saved.id); }
    catch (e) { toast(e.message, "err"); }
  };
}
function startFencePick() {
  if (!MAP) return;
  const kind = FENCE_PICK.kind;
  MAP.pick = MAP.pick || L.layerGroup().addTo(MAP); MAP.pick.clearLayers();
  $("#gis-map").classList.add("fence-pick");
  toast(kind === "circle" ? "Click the map once to set the centre of the geofence" : "Click the corners of the area; double-click (or press Done) to finish", "ok");
  const bar = document.createElement("div"); bar.id = "fence-pickbar"; bar.className = "pager"; bar.style.cssText = "position:absolute;z-index:1000;left:60px;top:10px;background:var(--panel);padding:6px 10px;border-radius:8px;border:1px solid var(--line)";
  bar.innerHTML = `<span id="fence-pick-n">${kind === "circle" ? "click the centre…" : "0 corners"}</span> <button class="btn primary small" id="fence-pick-done">Done</button> <button class="btn ghost small" id="fence-pick-cancel">Cancel</button>`;
  $("#gis-map").appendChild(bar);
  const finish = (cancel) => {
    MAP.off("click", onClick); MAP.off("dblclick", onDbl); $("#gis-map").classList.remove("fence-pick"); bar.remove(); MAP.pick.clearLayers(); MAP.doubleClickZoom.enable();
    const d = FENCE_PICK; FENCE_PICK = null;
    if (cancel) return;
    const base = d.id ? FENCES.find((x) => x.id === d.id) : null;
    const draft = { ...(base || {}), ...d };
    if (kind === "circle" && d.pts.length) { draft.lat = d.pts[0][0]; draft.lon = d.pts[0][1]; }
    if (kind === "polygon") draft.polygon = d.pts;
    fenceDialog(base ? { ...draft, id: base.id } : null);
    if (!base) { const form = $("#fence-form"); form.name.value = draft.name || ""; form.kind.value = kind; form.radius_m.value = draft.radius_m || 500; if (kind === "circle" && draft.lat != null) form.center.value = `${draft.lat.toFixed(5)}, ${draft.lon.toFixed(5)}`; if (kind === "polygon") form.polygon.value = (draft.polygon || []).map((p) => `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`).join("\n"); form.department.value = draft.department || ""; form.severity.value = draft.severity || "warn"; }
  };
  const onClick = (e) => {
    FENCE_PICK.pts.push([e.latlng.lat, e.latlng.lng]);
    MAP.pick.clearLayers();
    if (kind === "circle") { L.circle(e.latlng, { radius: FENCE_PICK.radius_m || 500, color: "#ef4444", fillOpacity: 0.15 }).addTo(MAP.pick); finish(false); return; }
    FENCE_PICK.pts.forEach((p) => L.circleMarker(p, { radius: 5, color: "#ef4444" }).addTo(MAP.pick));
    if (FENCE_PICK.pts.length > 1) L.polygon(FENCE_PICK.pts, { color: "#ef4444", fillOpacity: 0.15 }).addTo(MAP.pick);
    $("#fence-pick-n").textContent = `${FENCE_PICK.pts.length} corner${FENCE_PICK.pts.length === 1 ? "" : "s"}`;
  };
  const onDbl = () => finish(false);
  MAP.doubleClickZoom.disable();
  MAP.on("click", onClick); MAP.on("dblclick", onDbl);
  $("#fence-pick-done").onclick = () => finish(false); $("#fence-pick-cancel").onclick = () => finish(true);
}
// ------------------------------------------------------------------ wiring
bind("#login-form", "onsubmit", login);
bind("#logout", "onclick", logout);
$$("#tabs button").forEach((b) => b.onclick = () => show(b.dataset.view));
$$("#grid-select button").forEach((b) => b.onclick = () => { buildWall(b.dataset.grid); saveWall(); });
bind("#cam-filter", "oninput", renderCamTree);
bind("#wall-clear", "onclick", () => S.tiles.forEach(clearTile));
$("#layout-save").onclick = async () => {
  const name = prompt("Layout name (e.g. Ring Road)"); if (!name) return;
  await api(`/api/layouts/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ grid: S.grid, cameras: S.tiles.map((t) => t.cam) }) });
  toast(`Layout "${name}" saved`, "ok"); loadLayouts();
};
bind("#search-form", "onsubmit", runSearch);
bind("#export-csv", "onclick", exportCsv);
bind("#move-form", "onsubmit", runMovement);
bind("#watch-form", "onsubmit", addWatch);
bind("#alerts-open", "onchange", loadAlerts);
bind("#pb-form", "onsubmit", runPlayback);
bind("#modal-x", "onclick", closeModal);
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };  // returning false here would cancel form submits inside the modal

bind("#mfa-verify", "onclick", mfaVerify);
bind("#setup-btn", "onclick", signup);
bind("#person-form", "onsubmit", enrolPerson);
bind("#analysis-form", "onsubmit", runAnalysis);
bind("#upload-refresh", "onclick", () => loadUploads());
bind("#reg-add", "onclick", () => regEdit(""));
bind("#reg-import", "onclick", regImport);
bind("#reg-template", "onclick", () => window.open(withTok("/api/registry/template.csv")));
bind("#reg-export", "onclick", () => { const f = $("#reg-filter"); window.open(withTok(`/api/registry/export.csv?department=${encodeURIComponent(f.department.value)}&camera_type=${f.camera_type.value}&status=${f.status.value}&integrated=${f.integrated.value}&q=${encodeURIComponent(f.q.value)}`)); });
bind("#reg-gaps", "onclick", regGaps);
bind("#reg-api", "onclick", regApi);
bind("#reg-geocode", "onclick", regGeocode);
bind("#dev-connect", "onclick", () => connectDevice());
bind("#speak-toggle", "onclick", () => setSpeak(!SPEAK.on));
bind("#detect-toggle", "onclick", () => setDetection({ enabled: !DET_STATE.enabled }));
try { if (localStorage.getItem("uvp-speak") === "1") setSpeak(true, false); } catch (_) {}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { SPEAK.voices = speechSynthesis.getVoices(); };
bind("#counts-refresh", "onclick", loadCountsView);
bind("#counts-hours", "onchange", loadCountsView);
if ($("#reg-filter")) { let t; $("#reg-filter").oninput = $("#reg-filter").onchange = () => { clearTimeout(t); t = setTimeout(loadRegistry, 250); }; }
$$("[data-goto]").forEach((a) => a.onclick = (ev) => { ev.preventDefault(); show(a.dataset.goto); });
bind("#user-form", "onsubmit", createUser);
bind("#mfa-confirm", "onclick", () => mfaConfirm());
bind("#mfa-setup", "onclick", mfaSetupFromApp);
bind("#break-glass", "onclick", breakGlassDialog);
bind("#audit-verify", "onclick", verifyAudit);
bind("#audit-export", "onclick", () => window.open(withTok(`/api/audit/export.csv?${auditQuery().toString()}`)));
bind("#audit-reset", "onclick", () => { const f = $("#audit-filter"); f.reset(); AUDIT.page = 1; AUDIT.sort = "ts"; AUDIT.order = "desc"; loadAudit(); });
if ($("#audit-filter")) { let t; $("#audit-filter").oninput = $("#audit-filter").onchange = () => { clearTimeout(t); AUDIT.page = 1; t = setTimeout(loadAudit, 300); }; }
$$("#audit-table th[data-sort]").forEach((th) => th.onclick = () => { const k = th.dataset.sort; if (AUDIT.sort === k) AUDIT.order = AUDIT.order === "asc" ? "desc" : "asc"; else { AUDIT.sort = k; AUDIT.order = k === "ts" ? "desc" : "asc"; } AUDIT.page = 1; loadAudit(); });
bind("#bell", "onclick", toggleBell);
bind("#bell-readall", "onclick", () => markAllRead());
bind("#bell-open", "onclick", () => { closeBell(); show("notifications"); });
document.addEventListener("click", (e) => { if (!e.target.closest(".bell-wrap")) closeBell(); });
bind("#notif-readall", "onclick", () => markAllRead());
if ($("#notif-filter")) { let t; $("#notif-filter").oninput = $("#notif-filter").onchange = () => { clearTimeout(t); NOTIF.page = 1; t = setTimeout(loadNotifications, 250); }; }
if ($("#rep-filter")) $("#rep-filter").onchange = loadReports;
bind("#rep-csv", "onclick", () => window.open(withTok(`/api/reports/daily.csv?${reportQuery().toString()}`)));
bind("#rep-print", "onclick", () => window.print());
bind("#role-create", "onclick", createRole);
bind("#map-route", "onchange", (e) => showRoute(e.target.value));
bind("#menu-toggle", "onclick", () => setRail(!$("#app").classList.contains("rail")));
bind("#bell-prefs", "onclick", () => { closeBell(); notifPrefsDialog(); });
bind("#notif-prefs", "onclick", notifPrefsDialog);
bind("#map-fence", "onchange", (e) => showFence(e.target.value));
bind("#fence-new", "onclick", () => fenceDialog(null));
bind("#fence-edit", "onclick", () => FENCE_SEL && fenceDialog(FENCE_SEL));
bind("#fence-wall", "onclick", () => FENCE_SEL && routeOnWall({ name: FENCE_SEL.name, cameras: FENCE_SEL.cameras }));
bind("#fence-del", "onclick", async () => { if (!FENCE_SEL || !confirm(`Delete geofence ${FENCE_SEL.name}?`)) return; try { await api(`/api/geofences/${FENCE_SEL.id}`, { method: "DELETE" }); await loadFences(); showFence(""); } catch (e) { toast(e.message, "err"); } });
bind("#route-new", "onclick", () => routeDialog(null));
bind("#route-edit", "onclick", () => ROUTE_SEL && routeDialog(ROUTE_SEL));
bind("#route-wall", "onclick", () => ROUTE_SEL && routeOnWall(ROUTE_SEL));
bind("#route-del", "onclick", async () => { if (!ROUTE_SEL || !confirm(`Delete route ${ROUTE_SEL.name}?`)) return; try { await api(`/api/routes/${ROUTE_SEL.id}`, { method: "DELETE" }); await loadRoutes(); showRoute(""); } catch (e) { toast(e.message, "err"); } });
bind("#route-select", "onchange", (e) => { const r = ROUTES.find((x) => x.id === e.target.value); e.target.value = ""; if (r) routeOnWall(r); });
bind("#lookup-vahan", "onclick", () => doLookup("vahan", $("#lookup-form").plate.value));
bind("#lookup-sarathi", "onclick", () => doLookup("sarathi", $("#lookup-form").dl.value));
bind("#routes-save", "onclick", saveRoutes);
bind("#routes-add", "onclick", () => { const rs = collectRoutes(); rs.push({ kind: "alert", priority: "high", subkind: "exact", channel: (NOTIFY?.channels.find((c) => c.type === "voice") || NOTIFY?.channels[0] || {}).name, to: [], enabled: true }); renderRoutes(rs); $("#routes-table tbody tr:last-child [data-f=to]")?.focus(); });
bind("#routes-reset", "onclick", async () => { if (!confirm("Discard the routes edited here and use config/notify.yaml again?")) return; try { await api("/api/admin/notifications/routes", { method: "DELETE" }); loadIntegrations(); } catch (e) { toast(e.message, "err"); } });
bind("#arch-run", "onclick", runArchival);
bind("#arch-refresh", "onclick", loadArchival);
bind("#arch-schedule-save", "onclick", saveArchivalSchedule);
bind("#grant-form", "onsubmit", addGrant);
bind("#hold-form", "onsubmit", addHold);
bind("#dpdp-form", "onsubmit", (e) => e.preventDefault());
bind("#dpdp-access", "onclick", dpdpAccess);
bind("#dpdp-erase", "onclick", dpdpErase);
bind("#bm-form", "onsubmit", addBookmark);
bind("#case-form", "onsubmit", createCase);
bind("#cases-mine", "onchange", loadCases);
bind("#stitch-btn", "onclick", stitchClips);
bind("#ch-status", "onchange", loadChallans);
bind("#sla-days", "onchange", loadSla);
bind("#dets-toggle", "onchange", (e) => { DETS.show = e.target.checked; if (!DETS.show) $$("canvas.dets").forEach((c) => c.getContext("2d").clearRect(0, 0, c.width, c.height)); });
bind("#rep-week", "onchange", loadReport);
bind("#tr-hours", "onchange", loadTraffic);
const LANGS = ["en", "hi", "gu"];
bind("#lang-toggle", "onclick", () => setLang(LANGS[(LANGS.indexOf(I18N.lang) + 1) % LANGS.length]));
$$(".theme-toggle").forEach((b) => b.onclick = toggleTheme);
bind("#sidebar-toggle", "onclick", () => setRail(!$("#app").classList.contains("rail")));
$$("[data-go]").forEach((b) => b.onclick = () => show(b.dataset.go));
try { if (localStorage.getItem("uvp-rail") === "1") $("#app").classList.add("rail"); } catch (_) {}
applyTheme(document.documentElement.getAttribute("data-theme") || "dark");
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { const m = $(".tile.max"); if (m) { const t = S.tiles.find((x) => x.el === m); if (t) tileAction(t, "max"); } }
  if (e.altKey && /^[1-9]$/.test(e.key)) { const b = $$("#tabs button:not(.hidden)")[+e.key - 1]; if (b) { b.click(); b.focus(); } } });
bind("#key-form", "onsubmit", createKey);
bind("#hook-form", "onsubmit", createHook);
bind("#inc-open", "onchange", loadIncidents);
bind("#hl-sync", "onclick", async () => { try { const r = await api("/api/hotlists/sync", { method: "POST" }); toast(`Synced: ${Object.values(r).map((x) => `${x.source} +${x.added ?? 0}`).join(", ")}`, "ok"); loadWatchlist(); } catch (e) { toast(e.message, "err"); } });

(function boot() {
  let lang = "en"; try { lang = localStorage.getItem("uvp-lang") || ((navigator.language || "").startsWith("hi") ? "hi" : (navigator.language || "").startsWith("gu") ? "gu" : "en"); } catch (_) {}
  setLang(lang);
  // SSO return: /#sso=<token> (session) or /#mfa=<step token>; errors as /#sso_error=<code>
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("sso")) { history.replaceState(null, "", "/"); S.token = h.get("sso"); return api("/api/me").then((u) => { setSession({ token: S.token, user: u }); start(); }); }
  if (h.get("mfa")) { history.replaceState(null, "", "/"); MFA.token = h.get("mfa"); $("#login").classList.remove("hidden"); return showStep2(); }
  if (h.get("sso_error")) { history.replaceState(null, "", "/"); $("#login-error").textContent = `SSO sign-in failed (${h.get("sso_error")})`; }
  try { const s = JSON.parse(sessionStorage.getItem("uvp")); if (s?.token) { S.token = s.token; S.user = s.user; return start().catch(() => logout()); } } catch (_) {}
  fetch("/api/auth/providers").then((r) => r.json()).then((p) => {
    if (p.oidc && p.oidc.enabled) { $("#sso-btn").textContent = `Sign in with ${p.oidc.name}`; $("#sso-btn").classList.remove("hidden"); }
    if (p.needs_setup) return fetch("/api/auth/setup").then((r) => r.json()).then((st) => showSetup(st.password_rules)).catch(() => showSetup());
    $("#demo-hint").classList.toggle("hidden", !p.yaml_users);
  }).catch(() => {});
  $("#login").classList.remove("hidden");
})();
