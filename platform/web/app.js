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
const can = (role) => S.user && RANK[S.user.role] >= RANK[role];
// Attach a handler only if the element exists: a stale cached index.html must never stop the whole script.
function bind(sel, ev, fn) { const el = $(sel); if (el) el[ev] = fn; else console.warn("missing element", sel, "(hard-refresh the page: Ctrl+Shift+R)"); }
// ------------------------------------------------------------------ i18n (en / hi); strings in /i18n/<lang>.json
const I18N = { lang: "en", dict: {} };
const t = (k, fallback) => I18N.dict[k] || fallback || k;
async function setLang(lang) {
  try { I18N.dict = await fetch(`/i18n/${lang}.json`).then((r) => r.json()); I18N.lang = lang; } catch (_) { I18N.dict = {}; I18N.lang = "en"; }
  try { localStorage.setItem("uvp-lang", I18N.lang); } catch (_) {}
  document.documentElement.lang = I18N.lang;
  $$("[data-i18n]").forEach((el) => { const v = I18N.dict[el.dataset.i18n]; if (v) el.textContent = v; });
  $$("[data-i18n-placeholder]").forEach((el) => { const v = I18N.dict[el.dataset.i18nPlaceholder]; if (v) el.placeholder = v; });
}
const has = (feature) => !!(S.user && (S.user.features || []).includes(feature));
const setSession = (j) => { S.token = j.token; S.user = j.user; sessionStorage.setItem("uvp", JSON.stringify({ token: S.token, user: S.user })); };

let API_DOWN_TOAST = 0;
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}`, ...(opts.headers || {}) } });
  } catch (e) {
    // "Failed to fetch" = no answer at all: your network to the server dropped, or the API container is restarting
    if (Date.now() - API_DOWN_TOAST > 8000) { API_DOWN_TOAST = Date.now(); toast("Cannot reach the server (your network, or the API restarting). Reconnecting automatically…", "err"); }
    watchServer();
    throw new Error("server unreachable (" + (e.message || "network error") + ")");
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
  location.reload();
}

async function start() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#user-name").textContent = `${S.user.username} · ${S.user.role}${S.user.mfa ? " · 2FA" : ""}${S.user.tenant ? " · " + S.user.tenant : ""}`;
  licenseBanner();
  if (S.user.branding && S.user.branding.title) { $(".brand").lastChild.textContent = S.user.branding.title; document.title = S.user.branding.title; }
  if (S.user.branding && S.user.branding.accent) document.documentElement.style.setProperty("--accent", S.user.branding.accent);
  $$("[data-role]").forEach((el) => { if (!can(el.dataset.role)) el.classList.add("hidden"); });
  $$("[data-feature]").forEach((el) => el.classList.toggle("hidden", !has(el.dataset.feature)));
  S.cfg = await api("/api/config");
  const prov = await fetch("/api/auth/providers").then((r) => r.json()).catch(() => ({}));
  $("#break-glass").classList.toggle("hidden", !(prov.break_glass && ["supervisor", "admin"].includes(S.user.role) && !S.user.break_glass));
  await refreshMfaButton();
  renderBreakGlassBanner();
  await loadCameras();
  buildWall(S.grid);
  restoreWall();
  loadLayouts();
  connectWs();
  refreshAlertBadge();
  setInterval(loadCameras, 15000);
  let last = "overview";
  try { last = localStorage.getItem("uvp-view") || "overview"; } catch (_) {}
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
    <td style="white-space:nowrap">${has("admin") ? `<button class="btn small" data-dev-edit="${esc(d.id)}">Edit</button> <button class="btn small danger" data-dev-del="${esc(d.id)}">Disconnect</button>` : ""}</td></tr>`).join("")
    : '<tr><td colspan="8" class="muted">No devices connected from the console yet — click <b>Connect a device</b>.</td></tr>';
  $$("#dev-table [data-dev-edit]").forEach((b) => b.onclick = () => connectDevice(rows.find((x) => x.id === b.dataset.devEdit)));
  $$("#dev-table [data-dev-del]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Disconnect ${b.dataset.devDel}? Its cameras leave the wall and the registry.`)) return;
    const r = await api(`/api/devices/${b.dataset.devDel}`, { method: "DELETE" }); toast(`disconnected, ${r.cameras_removed} camera(s) removed`, "ok"); loadDevices(); loadCameras();
  });
}
async function connectDevice(existing = null) {
  try { DEV_TYPES ||= await api("/api/devices/types"); } catch (e) { toast(e.message, "err"); return; }
  const c = existing?.config || {};
  const kind = existing ? (c.streams ? "camera" : c.vendor ? "nvr" : c.adapter === "onvif" ? "onvif" : "template") : "nvr";
  const vendors = Object.entries(DEV_TYPES.vendors);
  modal(`<h3>${existing ? `Edit device · ${esc(existing.name)}` : "Connect a device"}</h3>
    <p class="muted small">Give the platform a <b>read-only</b> account on the device. Credentials are stored encrypted and never shown again; the relay pulls each stream once, however many people watch.</p>
    <form id="dev-form" class="search-form">
      <label>Device type <select name="type" ${existing ? "disabled" : ""}>${Object.entries(DEV_TYPES.types).map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      <span class="muted small" id="dev-help" style="flex-basis:100%"></span>
      <label>Name <input name="name" required value="${esc(existing?.name || "")}" placeholder="e.g. Sola police station NVR"></label>
      <label>Department <input name="department" required value="${esc(existing?.department || "")}" placeholder="Police / Municipal / Transport…"></label>
      <label data-for="nvr">Vendor <select name="vendor">${vendors.map(([k, v]) => `<option value="${k}" ${k === c.vendor ? "selected" : ""}>${k}${v.adapter === "onvif" ? " (ONVIF)" : ""}</option>`).join("")}</select></label>
      <label data-for="nvr template onvif">Host / IP <input name="host" value="${esc(c.host || "")}" placeholder="10.20.30.40 or nvr.police.gov.in"></label>
      <label data-for="nvr template">RTSP port <input name="rtsp_port" type="number" value="${c.rtsp_port || 554}"></label>
      <label data-for="onvif">ONVIF port <input name="onvif_port" type="number" value="${c.onvif_port || 80}"></label>
      <label data-for="template" style="flex-basis:100%">Main stream template <input name="main_template" value="${esc(c.main || "")}" placeholder="rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}"></label>
      <label data-for="template" style="flex-basis:100%">Sub stream template (optional) <input name="sub_template" value="${esc(c.sub || "")}" placeholder="leave blank if the device has one stream per channel"></label>
      <label data-for="camera" style="flex-basis:100%">Main stream URL <input name="main_url" value="${esc((c.streams || [])[0]?.main || "")}" placeholder="rtsp://10.0.0.9:554/Streaming/Channels/101 (no user:pass in the URL)"></label>
      <label data-for="camera" style="flex-basis:100%">Sub stream URL (optional) <input name="sub_url" value="${esc((c.streams || [])[0]?.sub || "")}"></label>
      <label data-for="camera">Latitude <input name="lat" type="number" step="any" value="${(c.streams || [])[0]?.lat ?? ""}"></label>
      <label data-for="camera">Longitude <input name="lon" type="number" step="any" value="${(c.streams || [])[0]?.lon ?? ""}"></label>
      <label data-for="nvr template">Channels <input name="channels" type="number" min="1" max="512" value="${(c.channels || []).length || 4}"></label>
      <label>Username <input name="username" autocomplete="off" value="${esc(existing?.username || "")}" placeholder="read-only account"></label>
      <label>Password <input name="password" type="password" autocomplete="new-password" placeholder="${existing ? "leave blank to keep" : ""}"></label>
      <label class="check"><input type="checkbox" name="anpr" ${(c.channels || c.streams || []).some((x) => x.anpr) ? "checked" : ""}> ANPR on these cameras</label>
      <label>Record <select name="record"><option value="anpr" ${c.record === "anpr" ? "selected" : ""}>ANPR cameras only</option><option value="all" ${c.record === "all" ? "selected" : ""}>all cameras</option><option value="none" ${c.record === "none" ? "selected" : ""}>none</option></select></label>
      <label>Max streams pulled at once <input name="max_concurrent_pulls" type="number" min="1" value="${c.max_concurrent_pulls || ""}" placeholder="= channels"></label>
      <div style="flex-basis:100%;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn" type="button" id="dev-test">Test connection</button><button class="btn primary" id="dev-save">${existing ? "Save changes" : "Save & connect"}</button><span class="small" id="dev-result"></span></div>
    </form>`);
  const f = $("#dev-form");
  const showFields = () => { const t = f.type.value; $("#dev-help").textContent = DEV_TYPES.types[t].help + (t === "nvr" && DEV_TYPES.vendors[f.vendor.value]?.notes ? ` ${DEV_TYPES.vendors[f.vendor.value].notes}` : "");
    $$("[data-for]", f).forEach((el) => el.classList.toggle("hidden", !el.dataset.for.split(" ").includes(t))); };
  f.type.onchange = f.vendor.onchange = showFields; showFields();
  const read = () => { const b = {}; [...f.elements].forEach((el) => { if (!el.name) return; b[el.name] = el.type === "checkbox" ? el.checked : el.value; });
    b.type = f.type.value; ["lat", "lon", "rtsp_port", "onvif_port", "channels", "max_concurrent_pulls"].forEach((k) => { b[k] = b[k] === "" ? null : Number(b[k]); }); return b; };
  $("#dev-test").onclick = async () => {
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
      const r = await fetch("/api/version", { cache: "no-store" });
      if (!r.ok) return;
      clearInterval(SERVER_WATCH); SERVER_WATCH = null;
      const secs = Math.round((Date.now() - SERVER_DOWN_AT) / 1000);
      toast(`Server reachable again after ${secs} s — reconnecting streams`, "ok");
      try { if (S.ws && S.ws.readyState !== 1) connectWs(); } catch (_) {}
      try { await loadCameras(); } catch (_) {}
      S.tiles.filter((t) => t.cam).forEach((t) => { clearTimeout(t.retry); playTile(t); });
      if (S.view && typeof show === "function") show(S.view);
    } catch (_) { /* still down */ }
  }, 3000);
}

// ------------------------------------------------------------------ navigation
function show(view) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
  const btn = $(`#tabs button[data-view="${view}"]`);
  if (btn && $("#page-title")) $("#page-title").textContent = btn.querySelector("span")?.textContent || view;
  if ($("#page-sub")) $("#page-sub").textContent = { wall: `${S.tiles.filter((t) => t.cam).length} feeds`, overview: new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) }[view] || "";
  S.view = view;
  try { localStorage.setItem("uvp-view", view); } catch (_) {}
  ({ overview: loadOverview, search: loadSearch, alerts: loadAlerts, watchlist: loadWatchlist, upload: loadUploads, registry: loadRegistry, counts: loadCountsView, sources: loadSources, audit: loadAudit, playback: loadPlayback, admin: loadAdmin, cases: loadCases, map: loadMap, movement: loadMovementCases, violations: loadViolations }[view] || (() => {}))();
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
  const c = S.camById[camId];
  if (!c) return;
  tile.cam = camId; tile.profile = profile;
  tile.el.innerHTML = `<video muted autoplay playsinline></video><canvas class="dets"></canvas><span class="detcount"></span>
    <div class="ov"><span class="dot live"></span><span class="t"><b>${esc(c.name)}</b></span>
      <span class="tagchip dept-${esc(c.department)}">${esc(c.department)}</span>${c.anpr_enabled ? '<span class="tagchip anpr">ANPR</span>' : ""}</div>
    <div class="state">connecting…</div>
    <div class="acts"><button data-a="max">${profile === "main" ? "Exit full" : "Full HD"}</button><button data-a="snap">Snapshot</button>
      ${has("playback") ? '<button data-a="bookmark" title="Keep the last 10 s and next 10 s as a clip">Bookmark</button>' : ""}
      ${can("analyst") ? '<button data-a="tag">Tag event</button><button data-a="hist">ANPR history</button>' : ""}<button data-a="close">✕</button></div>`;
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
  if (a === "hist") { show("search"); const f = $("#search-form"); f.camera.value = c.id; f.plate.value = ""; runSearch(); }
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
  if (S.user.role !== "admin") return;
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
  const p = new URLSearchParams({ plate: f.plate.value.trim(), fuzzy: f.fuzzy.checked, camera: f.camera.value, tag: f.tag.value, vehicle_type: f.vehicle_type.value, colour: f.colour.value, limit: 300 });
  if (f.since.value) p.set("since", toIso(f.since.value));
  if (f.until.value) p.set("until", toIso(f.until.value));
  const r = await api(`/api/events?${p}`);
  S.lastResults = r.events;
  $("#result-title").textContent = f.plate.value || f.camera.value || f.tag.value ? `${r.count} matching vehicle records` : "Latest vehicle records";
  $("#results tbody").innerHTML = r.events.map((e) => `<tr>
    <td>${esc(fmtTime(e.ts))}</td><td><span class="platebox plate ${e.plate_masked ? "masked" : ""}" ${e.plate_masked ? 'title="Plate masked: your role has no plate_search"' : `data-plate="${esc(e.plate)}"`}>${esc(e.plate)}</span></td>
    <td>${e.crop_url ? `<img class="crop" src="${esc(withTok(e.crop_url))}" data-frame="${esc(e.frame_url)}" alt="">` : ""}</td>
    <td>${esc(S.camById[e.camera_id]?.name || e.camera_id)}</td><td><span class="dept-${esc(e.department)}">${esc(e.department)}</span></td>
    <td>${Math.round(e.confidence * 100)}%</td><td>${e.reads}</td><td>${esc(e.direction)}</td>
    <td class="small">${[e.vehicle_colour, (e.vehicle_type || "").replace("_", " "), e.plate_colour && e.plate_colour !== "white" ? `${e.plate_colour} plate` : "", e.make_model].filter(Boolean).map(esc).join(" · ")}</td>
    <td>${(e.tags || []).filter((t) => !/^(type|colour|plate):/.test(t)).map((t) => `<span class="tagchip ${["watchlist", "challan_suggested", "over_speed", "wrong_way", "red_light", "triple_riding", "no_helmet"].includes(t) ? "watchlist" : ""}">${esc(t)}</span>`).join(" ")}</td>
    <td><button type="button" class="btn ghost small" data-clip="${esc(e.id)}">Clip</button>${has("export") ? ` <a class="btn ghost small" href="${esc(withTok(`/api/events/${e.id}/export`))}" title="Signed, watermarked evidence bundle (zip)">Evidence</a>` : ""}${has("cases") ? ` <button type="button" class="btn ghost small" data-case-add="${esc(e.id)}" title="File this sighting into a case">${t("btn.case", "+ Case")}</button>` : ""}${has("plate_search") && !e.plate_masked ? ` <button type="button" class="btn ghost small" data-fix="${esc(e.id)}" data-plate="${esc(e.plate)}" title="Confirm or correct this read">${t("btn.fix", "Fix plate")}</button>` : ""}</td></tr>`).join("")
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
  const rows = await api("/api/reports/anpr/review-queue?limit=30");
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
function playArchive(url, title) {
  const src = url.startsWith("http") ? url : withTok(url);
  modal(`<h3>${esc(title)}</h3><video controls autoplay playsinline style="width:min(90vw,960px);max-height:70vh;background:#000" src="${esc(src)}"></video>
    <p class="small muted">Streamed from the video archive (object storage). This access is written to the audit log.</p>`);
}

// ------------------------------------------------------------------ playback (archived recordings)
async function loadPlayback() {
  const sel = $("#pb-camera");
  if (!sel.options.length) {
    const opts = S.cameras.map((c) => `<option value="${esc(c.id)}">${esc(c.department)} · ${esc(c.name)}</option>`).join("");
    sel.innerHTML = opts; $("#bm-camera").innerHTML = opts;
    $("#pb-form").day.value = new Date().toISOString().slice(0, 10);
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
  const rows = await api(`/api/incidents?open_only=${$("#inc-open").checked}&limit=200`);
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
    MAP.on("click", (e) => nearestAt(e.latlng.lat, e.latlng.lng));
    ["#map-colour", "#map-cones", "#map-registry-only"].forEach((s) => $(s).onchange = () => drawMap());
    $("#map-gaps").onchange = () => drawGaps();
  }
  MAP.data = data;
  drawMap(true);
  if ($("#map-gaps").checked) drawGaps();
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
async function runPlayback(ev) {
  ev && ev.preventDefault();
  const f = $("#pb-form");
  const r = await api(`/api/cameras/${encodeURIComponent(f.camera.value)}/recordings?day=${f.day.value}`);
  $("#pb-title").textContent = `${r.count} recorded segments`;
  $("#pb-sub").textContent = `${S.camById[r.camera_id]?.name || r.camera_id} · ${r.day} (UTC day)`;
  $("#pb-table tbody").innerHTML = r.segments.map((x) => `<tr><td>${esc(fmtTime(x.start))}</td><td>${Math.round(x.duration_s)} s</td>
    <td>${(x.bytes / 1048576).toFixed(1)} MB</td><td><button type="button" class="btn ghost small" data-url="${esc(x.url)}" data-start="${esc(x.start)}">Play</button></td></tr>`).join("")
    || '<tr><td colspan="4" class="muted">No archived segments for this day. Recording only runs for cameras selected by RECORD_MODE (default: ANPR cameras).</td></tr>';
  $$("[data-url]", $("#pb-table")).forEach((b) => b.onclick = () => playArchive(b.dataset.url, `${S.camById[r.camera_id]?.name || r.camera_id} · ${fmtTime(b.dataset.start)}`));
}
function bindPlates(root) {
  $$("[data-plate]", root).forEach((el) => el.onclick = () => traceVehicle(el.dataset.plate));
  $$("img[data-frame]", root).forEach((el) => el.onclick = () => modal(`<img src="${esc(withTok(el.dataset.frame))}" alt="Evidence frame">`));
}
function exportCsv() {
  // server-side export: signed manifest + Ed25519 signature travel with the CSV, and the export is audited
  const f = $("#search-form");
  const p = new URLSearchParams({ plate: f.plate.value.trim(), camera: f.camera.value, tag: f.tag.value });
  if (f.since.value) p.set("since", toIso(f.since.value));
  if (f.until.value) p.set("until", toIso(f.until.value));
  location.href = withTok(`/api/events/export.csv?${p}`);
}

// ------------------------------------------------------------------ vehicle movement
function traceVehicle(plate) { show("movement"); $("#move-form").plate.value = plate; runMovement(); }
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
  const rows = await api(`/api/alerts?open_only=${$("#alerts-open").checked}`);
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
    <div class="small muted">${esc(s.detail)}${s.checked_at ? ` · checked ${esc(fmtTime(s.checked_at))}` : ""}</div></div>`).join("")
    || '<p class="muted">No sources yet. The adapter service registers them on start.</p>';
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
async function loadAudit() {
  const rows = await api("/api/audit?limit=300");
  $("#audit-table tbody").innerHTML = rows.map((r) => `<tr class="${r.action.startsWith("break_glass") ? "row-bg" : ""}"><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td><td>${esc(r.detail)}</td><td>${esc(r.ip)} <span class="muted small" title="row hash">${esc(r.hash)}</span></td></tr>`).join("");
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
  $("#users-table tbody").innerHTML = users.map((u) => `<tr class="${u.is_active === false ? "muted" : ""}"><td>${esc(u.username)}${u.is_super ? ' <span class="ok-chip">super</span>' : ""}${u.is_active === false ? ' <span class="bad-chip">inactive</span>' : ""}</td><td>${esc(u.provider)}</td><td>${esc(u.role)}</td><td>${esc((u.departments || []).join(", "))}</td>
    <td>${u.mfa_enrolled ? '<span class="ok-chip">enrolled</span>' : (u.mfa_required ? '<span class="bad-chip">required</span>' : "–")}</td><td>${u.last_login ? esc(fmtTime(u.last_login)) : "–"}${u.locked_until ? ' <span class="bad-chip">locked</span>' : ""}</td><td>${u.active_grants}</td>
    <td>${u.locked_until ? `<button class="btn ghost small" data-unlock="${esc(u.username)}">Unlock</button> ` : ""}${u.mfa_enrolled ? `<button class="btn ghost small" data-mfareset="${esc(u.username)}">Reset 2FA</button> ` : ""}${su && u.provider === "db" && u.username !== S.user.username ? `<button class="btn ghost small" data-user-active="${esc(u.username)}" data-active="${u.is_active !== false}">${u.is_active === false ? "Activate" : "Deactivate"}</button> <button class="btn ghost small" data-user-pw="${esc(u.username)}">Set password</button> <button class="btn ghost small" data-user-del="${esc(u.username)}">Remove</button>` : ""}</td></tr>`).join("");
  $("#grants-table tbody").innerHTML = grants.map((g) => `<tr class="${g.kind === "break_glass" ? "row-bg" : ""}"><td>${esc(g.username)}</td><td>${esc(g.kind)}</td><td>${esc(g.value)}</td><td>${esc(g.reason)}</td><td>${esc(g.granted_by)}</td><td>${g.expires_at ? esc(fmtTime(g.expires_at)) : "never"}</td><td><button class="btn ghost small" data-revoke="${esc(g.id)}">Revoke</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No active grants.</td></tr>';
  $("#holds-table tbody").innerHTML = holds.map((h) => `<tr><td>${esc(h.kind)}</td><td>${esc(h.value)}</td><td>${esc(h.reference)}</td><td>${esc(h.reason)}</td><td>${esc(h.created_by)}</td><td>${esc(fmtTime(h.created_at))}</td><td><button class="btn ghost small" data-release="${esc(h.id)}">Release</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No legal holds.</td></tr>';
  loadIntegrations();
  $$("[data-unlock]").forEach((b) => b.onclick = () => api(`/api/admin/users/${b.dataset.unlock}/unlock`, { method: "POST" }).then(loadAdmin));
  $$("[data-mfareset]").forEach((b) => b.onclick = () => api(`/api/auth/mfa/reset/${b.dataset.mfareset}`, { method: "POST" }).then(loadAdmin));
  $$("[data-user-active]").forEach((b) => b.onclick = () => api(`/api/users/${b.dataset.userActive}`, { method: "PATCH", body: JSON.stringify({ is_active: b.dataset.active !== "true" }) }).then(loadAdmin).catch((e) => toast(e.message, "err")));
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
    const u = await api("/api/users", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password"), role: f.get("role"),
      departments: departments.length ? departments : ["*"], is_super: !!f.get("is_super") }) });
    toast(`User ${u.username} created (${u.role}). They can enable 2FA with the 2FA button after signing in.`, "ok");
    ev.target.reset(); ev.target.departments.value = "*";
    loadAdmin();
  } catch (e) { toast(e.message, "err"); }
}
async function loadIntegrations() {
  const [keys, hooks, notif, tenants, vendors] = await Promise.all([api("/api/admin/api-keys"), api("/api/admin/webhooks"), api("/api/admin/notifications?limit=50"), api("/api/tenants"), api("/api/admin/vendors")]);
  $("#keys-table tbody").innerHTML = keys.map((k) => `<tr class="${k.revoked ? "muted" : ""}"><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc((k.features || []).join(", "))}</td><td>${esc((k.departments || []).join(", "))}</td><td>${k.expires_at ? esc(fmtTime(k.expires_at)) : "never"}</td><td>${k.last_used ? esc(fmtTime(k.last_used)) : "–"}</td><td>${k.revoked ? "revoked" : `<button class="btn ghost small" data-key-rev="${esc(k.id)}">Revoke</button>`}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No API keys.</td></tr>';
  $("#hooks-table tbody").innerHTML = hooks.webhooks.map((w) => `<tr class="${w.active ? "" : "muted"}"><td>${esc(w.name)}</td><td class="small">${esc(w.url)}</td><td>${esc((w.kinds || []).join(", "))}</td><td>${esc((w.departments || []).join(", "))}</td><td class="small">${esc(w.last_status || "–")}${w.last_delivery ? `<br>${esc(fmtTime(w.last_delivery))}` : ""}</td><td>${w.failures}</td>
    <td><button class="btn ghost small" data-hook-test="${esc(w.id)}">Test</button> <button class="btn ghost small" data-hook-toggle="${esc(w.id)}" data-active="${w.active}">${w.active ? "Disable" : "Enable"}</button> <button class="btn ghost small" data-hook-del="${esc(w.id)}">✕</button></td></tr>`).join("") || '<tr><td colspan="7" class="muted">No webhooks.</td></tr>';
  $("#notif-sub").textContent = `channels: ${notif.channels.map((c) => `${c.name} (${c.type}${c.enabled ? "" : ", off"})`).join(", ") || "none"} · ${notif.routes.length} routes (config/notify.yaml)`;
  $("#notif-table tbody").innerHTML = notif.log.map((n) => `<tr><td>${esc(fmtTime(n.ts))}</td><td>${esc(n.channel)}</td><td class="small">${esc(n.recipient)}</td><td>${esc(n.kind)}</td><td class="small">${esc(n.subject)}</td><td><span class="${n.status === "sent" ? "ok-chip" : "bad-chip"}">${esc(n.status)}</span></td><td class="small muted">${esc(n.detail)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Nothing sent yet.</td></tr>';
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
document.addEventListener("keydown", (e) => { if (e.altKey && /^[1-9]$/.test(e.key)) { const b = $$("#tabs button:not(.hidden)")[+e.key - 1]; if (b) { b.click(); b.focus(); } } });
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
