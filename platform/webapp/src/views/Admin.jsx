import { useRef } from "react";
import { api, apiJson, fmtTime, splitList } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { CheckChip, EmptyRow, useLoad } from "../components/common.jsx";

/* Users, access grants, legal holds, API keys, webhooks, compliance. */
export default function Admin() {
  const app = useApp();
  const ui = useUI();
  const [d, reload] = useLoad(async () => {
    const [c, users, grants, holds, lic] = await Promise.all([api("/api/compliance/status"), api("/api/admin/users"), api("/api/admin/grants"), api("/api/admin/holds"), app.license || api("/api/license")]);
    return { c, users, grants, holds, lic };
  });
  const [ig, reloadIg] = useLoad(async () => {
    const [keys, hooks, notif, tenants, vendors] = await Promise.all([api("/api/admin/api-keys"), api("/api/admin/webhooks"), api("/api/admin/notifications?limit=50"), api("/api/tenants"), api("/api/admin/vendors")]);
    return { keys, hooks, notif, tenants, vendors };
  });
  const su = !!app.user.is_super;

  /** Submit a form: run fn(form), then reset and reload; errors are toasted. */
  const submit = (fn, after) => async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try { await fn(f); f.reset(); after?.(f); } catch (e) { ui.toast(e.message, "err"); }
  };
  const run = (p, then) => p.then(then).catch((e) => ui.toast(e.message, "err"));

  const createUser = submit(async (f) => {
    const departments = splitList(f.departments.value || "*");
    const u = await apiJson("/api/users", "POST", { username: f.username.value, password: f.password.value, role: f.role.value, departments: departments.length ? departments : ["*"], is_super: f.is_super.checked });
    ui.toast(`User ${u.username} created (${u.role}). They can enable 2FA with the 2FA button after signing in.`, "ok");
  }, () => reload());
  const addGrant = submit(async (f) => {
    await apiJson("/api/admin/grants", "POST", { username: f.username.value.trim(), kind: f.kind.value, value: f.value.value.trim(), hours: +f.hours.value, reason: f.reason.value });
    ui.toast("Grant added; takes effect at the user's next sign-in or refresh", "ok");
  }, () => reload());
  const addHold = submit(async (f) => {
    await apiJson("/api/admin/holds", "POST", { kind: f.kind.value, value: f.value.value.trim(), reference: f.reference.value, reason: f.reason.value });
    ui.toast("Legal hold placed", "ok");
  }, () => reload());
  const createKey = submit(async (f) => {
    const k = await apiJson("/api/admin/api-keys", "POST", { name: f.name.value, features: splitList(f.features.value), departments: splitList(f.departments.value), days: +f.days.value });
    ui.modal(<><h3>API key created</h3><p>Copy it now; it is shown once.</p><pre>{k.key}</pre><p className="small muted">curl -H "X-API-Key: {k.key}" {location.origin}/api/events</p></>);
  }, () => reloadIg());
  const createHook = submit(async (f) => {
    const w = await apiJson("/api/admin/webhooks", "POST", { name: f.name.value, url: f.url.value, kinds: splitList(f.kinds.value), departments: splitList(f.departments.value) });
    ui.modal(<><h3>Webhook added</h3><p>Shared secret for signature verification (shown once):</p><pre>{w.secret}</pre></>);
  }, () => reloadIg());
  const testHook = async (id) => {
    try { const r = await api(`/api/admin/webhooks/${id}/test`, { method: "POST" }); ui.toast(`Test delivery: ${r.last_status}`, r.last_status.startsWith("HTTP 2") ? "ok" : "err"); reloadIg(); }
    catch (e) { ui.toast(e.message, "err"); }
  };
  const setPassword = (username) => {
    const pw = prompt(`New password for ${username} (min 10 chars, 1 uppercase, 1 digit):`);
    if (pw) run(apiJson(`/api/users/${username}`, "PATCH", { password: pw }), () => ui.toast("Password set", "ok"));
  };
  const removeUser = (username) => { if (confirm(`Remove account ${username}? Its 2FA enrolment and grants are deleted too.`)) run(api(`/api/users/${username}`, { method: "DELETE" }), reload); };

  return (
    <main id="view-admin" className="view">
      <div className="view-head"><div><h2>Administration</h2><p>Users, access grants, legal holds, API keys, webhooks, compliance.</p></div></div>
      {d && <Compliance c={d.c} lic={d.lic} />}

      <div className="panel">
        <div className="panel-head"><h3>Users</h3><span className="muted small" id="users-sub">{su ? "You are a super admin: create users here; deactivate keeps the account for audit, remove deletes it with its 2FA state" : "Accounts are created by a super admin; directory (LDAP/SSO) users appear after first login"}</span></div>
        {su && <form id="user-form" className="search-form" onSubmit={createUser}>
          <label>Username <input name="username" required placeholder="firstname.lastname" /></label>
          <label>Password <input name="password" type="password" required autoComplete="new-password" placeholder="min 10, 1 uppercase, 1 digit" /></label>
          <label>Role <select name="role"><option value="viewer">viewer</option><option value="analyst">analyst</option><option value="supervisor">supervisor</option><option value="admin">admin</option></select></label>
          <label>Departments <input name="departments" defaultValue="*" placeholder="* or Police, Municipal" /></label>
          <label className="check"><input type="checkbox" name="is_super" /> super admin</label>
          <button className="btn primary">Create user</button>
        </form>}
        <table className="table" id="users-table"><thead><tr><th>User</th><th>Provider</th><th>Role</th><th>Departments</th><th>2FA</th><th>Last login</th><th>Grants</th><th /></tr></thead>
          <tbody>{d?.users.map((u) => (
            <tr key={u.username} className={u.is_active === false ? "muted" : ""}>
              <td>{u.username}{u.is_super && <> <span className="ok-chip">super</span></>}{u.is_active === false && <> <span className="bad-chip">inactive</span></>}</td>
              <td>{u.provider}</td><td>{u.role}</td><td>{(u.departments || []).join(", ")}</td>
              <td>{u.mfa_enrolled ? <span className="ok-chip">enrolled</span> : u.mfa_required ? <span className="bad-chip">required</span> : "–"}</td>
              <td>{u.last_login ? fmtTime(u.last_login) : "–"}{u.locked_until && <> <span className="bad-chip">locked</span></>}</td><td>{u.active_grants}</td>
              <td>{u.locked_until && <><button className="btn ghost small" onClick={() => run(api(`/api/admin/users/${u.username}/unlock`, { method: "POST" }), reload)}>Unlock</button> </>}
                {u.mfa_enrolled && <><button className="btn ghost small" onClick={() => run(api(`/api/auth/mfa/reset/${u.username}`, { method: "POST" }), reload)}>Reset 2FA</button> </>}
                {su && u.provider === "db" && u.username !== app.user.username && <>
                  <button className="btn ghost small" onClick={() => run(apiJson(`/api/users/${u.username}`, "PATCH", { is_active: u.is_active === false }), reload)}>{u.is_active === false ? "Activate" : "Deactivate"}</button>{" "}
                  <button className="btn ghost small" onClick={() => setPassword(u.username)}>Set password</button>{" "}
                  <button className="btn ghost small" onClick={() => removeUser(u.username)}>Remove</button></>}</td>
            </tr>))}</tbody></table>
      </div>

      <form id="grant-form" className="panel search-form" onSubmit={addGrant}>
        <label>User <input name="username" required placeholder="police_op" /></label>
        <label>Kind <select name="kind"><option value="feature">feature</option><option value="camera">camera</option><option value="department">department</option></select></label>
        <label>Value <input name="value" required placeholder="export / muni-cam1 / Municipal" /></label>
        <label>Hours <input name="hours" type="number" defaultValue="24" min="0" step="0.5" /></label>
        <label>Reason <input name="reason" required placeholder="shift cover, court order…" /></label>
        <button className="btn primary">Grant access</button>
      </form>
      <div className="panel"><div className="panel-head"><h3>Active grants and break-glass sessions</h3></div>
        <table className="table" id="grants-table"><thead><tr><th>User</th><th>Kind</th><th>Value</th><th>Reason</th><th>By</th><th>Expires (IST)</th><th /></tr></thead>
          <tbody>{d && (d.grants.length ? d.grants.map((g) => (
            <tr key={g.id} className={g.kind === "break_glass" ? "row-bg" : ""}><td>{g.username}</td><td>{g.kind}</td><td>{g.value}</td><td>{g.reason}</td><td>{g.granted_by}</td><td>{g.expires_at ? fmtTime(g.expires_at) : "never"}</td>
              <td><button className="btn ghost small" onClick={() => run(api(`/api/admin/grants/${g.id}`, { method: "DELETE" }), reload)}>Revoke</button></td></tr>))
            : <EmptyRow cols={7}>No active grants.</EmptyRow>)}</tbody></table></div>

      <form id="hold-form" className="panel search-form" onSubmit={addHold}>
        <label>Legal hold on <select name="kind"><option value="plate">plate</option><option value="camera">camera</option><option value="event">event</option></select></label>
        <label>Value <input name="value" required placeholder="MP04ZR7493 / police-cam1 / event id" /></label>
        <label>Reference <input name="reference" placeholder="FIR / court order no." /></label>
        <label>Reason <input name="reason" /></label>
        <button className="btn primary">Place hold</button>
      </form>
      <div className="panel"><div className="panel-head"><h3>Legal holds</h3><span className="muted small">Held records are never purged by retention and cannot be erased under DPDP requests</span></div>
        <table className="table" id="holds-table"><thead><tr><th>Kind</th><th>Value</th><th>Reference</th><th>Reason</th><th>By</th><th>Since (IST)</th><th /></tr></thead>
          <tbody>{d && (d.holds.length ? d.holds.map((h) => (
            <tr key={h.id}><td>{h.kind}</td><td>{h.value}</td><td>{h.reference}</td><td>{h.reason}</td><td>{h.created_by}</td><td>{fmtTime(h.created_at)}</td>
              <td><button className="btn ghost small" onClick={() => run(api(`/api/admin/holds/${h.id}`, { method: "DELETE" }), reload)}>Release</button></td></tr>))
            : <EmptyRow cols={7}>No legal holds.</EmptyRow>)}</tbody></table></div>

      <form id="key-form" className="panel search-form" onSubmit={createKey}>
        <label>API key name <input name="name" required placeholder="traffic-erp" /></label>
        <label>Features <input name="features" defaultValue="search,playback" placeholder="search,playback,plate_search" /></label>
        <label>Departments <input name="departments" defaultValue="*" /></label>
        <label>Valid days <input name="days" type="number" defaultValue="365" min="0" /></label>
        <button className="btn primary">Create key</button>
      </form>
      <div className="panel"><div className="panel-head"><h3>API keys</h3><span className="muted small">Send as <code>X-API-Key</code>; OpenAPI at <a href="/docs" target="_blank" rel="noreferrer">/docs</a></span></div>
        <table className="table" id="keys-table"><thead><tr><th>Name</th><th>Prefix</th><th>Features</th><th>Departments</th><th>Expires</th><th>Last used</th><th /></tr></thead>
          <tbody>{ig && (ig.keys.length ? ig.keys.map((k) => (
            <tr key={k.id} className={k.revoked ? "muted" : ""}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td>{(k.features || []).join(", ")}</td><td>{(k.departments || []).join(", ")}</td>
              <td>{k.expires_at ? fmtTime(k.expires_at) : "never"}</td><td>{k.last_used ? fmtTime(k.last_used) : "–"}</td>
              <td>{k.revoked ? "revoked" : <button className="btn ghost small" onClick={() => run(api(`/api/admin/api-keys/${k.id}`, { method: "DELETE" }), reloadIg)}>Revoke</button>}</td></tr>))
            : <EmptyRow cols={7}>No API keys.</EmptyRow>)}</tbody></table></div>

      <form id="hook-form" className="panel search-form" onSubmit={createHook}>
        <label>Webhook name <input name="name" required placeholder="CAD intake" /></label>
        <label>URL <input name="url" required placeholder="https://cad.example.gov.in/api/cctv" /></label>
        <label>Kinds <input name="kinds" defaultValue="alert,incident" placeholder="anpr.event,alert,incident,challan,camera.health" /></label>
        <label>Departments <input name="departments" defaultValue="*" /></label>
        <button className="btn primary">Add webhook</button>
      </form>
      <div className="panel"><div className="panel-head"><h3>Webhooks</h3><span className="muted small">Signed with X-UVP-Signature (HMAC-SHA256); auto-disabled after 50 failures</span></div>
        <table className="table" id="hooks-table"><thead><tr><th>Name</th><th>URL</th><th>Kinds</th><th>Departments</th><th>Last</th><th>Failures</th><th /></tr></thead>
          <tbody>{ig && (ig.hooks.webhooks.length ? ig.hooks.webhooks.map((w) => (
            <tr key={w.id} className={w.active ? "" : "muted"}><td>{w.name}</td><td className="small">{w.url}</td><td>{(w.kinds || []).join(", ")}</td><td>{(w.departments || []).join(", ")}</td>
              <td className="small">{w.last_status || "–"}{w.last_delivery && <><br />{fmtTime(w.last_delivery)}</>}</td><td>{w.failures}</td>
              <td><button className="btn ghost small" data-hook-test={w.id} onClick={() => testHook(w.id)}>Test</button>{" "}
                <button className="btn ghost small" onClick={() => run(api(`/api/admin/webhooks/${w.id}?active=${!w.active}`, { method: "PATCH" }), reloadIg)}>{w.active ? "Disable" : "Enable"}</button>{" "}
                <button className="btn ghost small" onClick={() => run(api(`/api/admin/webhooks/${w.id}`, { method: "DELETE" }), reloadIg)}>✕</button></td></tr>))
            : <EmptyRow cols={7}>No webhooks.</EmptyRow>)}</tbody></table></div>

      <div className="panel"><div className="panel-head"><h3>Notifications</h3>
        <span className="muted small" id="notif-sub">{ig && `channels: ${ig.notif.channels.map((c) => `${c.name} (${c.type}${c.enabled ? "" : ", off"})`).join(", ") || "none"} · ${ig.notif.routes.length} routes (config/notify.yaml)`}</span></div>
        <table className="table" id="notif-table"><thead><tr><th>When (IST)</th><th>Channel</th><th>To</th><th>Kind</th><th>Subject</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>{ig && (ig.notif.log.length ? ig.notif.log.map((n, i) => (
            <tr key={i}><td>{fmtTime(n.ts)}</td><td>{n.channel}</td><td className="small">{n.recipient}</td><td>{n.kind}</td><td className="small">{n.subject}</td>
              <td><span className={n.status === "sent" ? "ok-chip" : "bad-chip"}>{n.status}</span></td><td className="small muted">{n.detail}</td></tr>))
            : <EmptyRow cols={7}>Nothing sent yet.</EmptyRow>)}</tbody></table></div>

      <div className="panel"><div className="panel-head"><h3>Tenants &amp; vendor presets</h3></div>
        {ig && <><div className="small" id="tenants-list">Tenants: {ig.tenants.tenants.map((t) => <span key={t.id} className="tagchip">{t.id} · {t.name}</span>)}</div>
          <div className="small muted" id="vendors-list">Vendor presets (config/vendors.yaml): {Object.entries(ig.vendors).map(([k, v]) => `${k} (${v.adapter})`).join(", ")}</div></>}</div>

      <Dpdp />
    </main>
  );
}

function Compliance({ c, lic }) {
  const { t } = useI18n();
  return <div className="cards" id="compliance-cards">
    <div className="card"><b>{t("license.title", "Licence")} · v{lic.version}</b><div className="kv">
      <span>Customer</span><span>{lic.customer}</span>
      <span>Mode</span><CheckChip ok={lic.mode === "licensed"}>{lic.status}</CheckChip>
      <span>Cameras</span><CheckChip ok={!lic.over_limit.cameras}>{`${lic.usage.cameras_total} / ${lic.limits.cameras ?? "∞"}`}</CheckChip>
      <span>ANPR channels</span><CheckChip ok={!lic.over_limit.anpr_channels}>{`${lic.usage.anpr_channels} / ${lic.limits.anpr_channels ?? "∞"}`}</CheckChip>
      <span>Analytics channels</span><CheckChip ok={!lic.over_limit.analytics_channels}>{`${lic.usage.analytics_channels} / ${lic.limits.analytics_channels ?? "∞"}`}</CheckChip>
      <span>Expires</span><span>{lic.expires || "–"}</span></div></div>
    <div className="card"><b>Identity</b><div className="kv">
      <span>Local users</span><CheckChip ok>{c.identity.local ? "on" : "off"}</CheckChip>
      <span>LDAP / AD</span><CheckChip ok={c.identity.ldap}>{c.identity.ldap ? "on" : "off"}</CheckChip>
      <span>SSO (OIDC)</span><CheckChip ok={c.identity.oidc}>{c.identity.oidc ? "on" : "off"}</CheckChip>
      <span>2FA required</span><span>{c.identity.mfa_required_roles.join(", ") || "none (set mfa.required_roles)"}</span>
      <span>Lockout</span><span>{c.identity.lockout.failures} failures / {c.identity.lockout.seconds}s</span></div></div>
    <div className="card"><b>Audit &amp; retention</b><div className="kv">
      <span>Hash chain</span><CheckChip ok={c.audit.hash_chain.ok}>{c.audit.hash_chain.ok ? `intact, ${c.audit.hash_chain.rows} rows` : "BROKEN"}</CheckChip>
      <span>Audit retention</span><CheckChip ok={c.audit.certin_180_days}>{`${c.audit.retention_days} days (CERT-In ≥180)`}</CheckChip>
      <span>Events</span><span>{c.retention.default.events_days} d</span>
      <span>Clips / crops</span><span>{c.retention.default.clips_days} / {c.retention.default.crops_days} d</span>
      <span>Recordings</span><span>{c.retention.default.recordings_days} d</span>
      <span>Legal holds</span><span>{c.legal_holds_active}</span></div></div>
    <div className="card"><b>Data protection</b><div className="kv">
      <span>Plate masking</span><CheckChip ok={c.pii.mask_plates}>{c.pii.mask_plates ? "on" : "off"}</CheckChip>
      <span>Face blur in frames</span><CheckChip ok={c.pii.blur_faces}>{c.pii.blur_faces ? "on" : "off"}</CheckChip>
      <span>Object storage encryption</span><CheckChip ok={!String(c.encryption.object_storage_sse).startsWith("none")}>{c.encryption.object_storage_sse}</CheckChip>
      <span>TLS proxy</span><CheckChip ok={c.encryption.tls_proxy}>{c.encryption.tls_proxy ? "on" : "off (see deploy/tls)"}</CheckChip>
      <span>Secrets</span><span>{c.encryption.secrets}</span>
      <span>Exports</span><CheckChip ok>signed + watermarked</CheckChip></div></div>
  </div>;
}

function Dpdp() {
  const ui = useUI();
  const plate = useRef(null);
  const access = async () => {
    const p = plate.current.value.trim(); if (!p) return;
    try {
      const r = await api(`/api/dpdp/subject-access?plate=${encodeURIComponent(p)}`);
      ui.modal(<><h3>Subject access report · {r.plate}</h3>
        <p className="muted small">{r.events.length} sightings · {r.alerts.length} alerts · watchlist: {String(r.watchlist)} · legal holds: {r.legal_holds.join(", ") || "none"} · retention: events {r.retention_days.events_days} d</p>
        <pre style={{ maxHeight: "50vh", overflow: "auto" }}>{JSON.stringify(r, null, 1)}</pre></>);
    } catch (e) { ui.toast(e.message, "err"); }
  };
  const erase = async () => {
    const p = plate.current.value.trim(); if (!p) return;
    if (!confirm(`Erase every record, clip and crop for ${p}? This is irreversible and audited.`)) return;
    try { const r = await api(`/api/dpdp/erase?plate=${encodeURIComponent(p)}&reason=data principal request`, { method: "POST" }); ui.toast(`Erased ${r.events_erased} events, ${r.alerts_erased} alerts, ${r.objects_erased} objects`, "ok"); }
    catch (e) { ui.toast(e.message, "err"); }
  };
  return <form id="dpdp-form" className="panel search-form" onSubmit={(e) => e.preventDefault()}>
    <label>DPDP request for plate <input ref={plate} name="plate" required placeholder="MP04ZR7493" /></label>
    <button className="btn ghost" type="button" id="dpdp-access" onClick={access}>Subject access report</button>
    <button className="btn ghost" type="button" id="dpdp-erase" onClick={erase}>Erase records</button>
    <span className="muted small">Both are audited; erasure is refused while a legal hold or watchlist entry exists.</span>
  </form>;
}
