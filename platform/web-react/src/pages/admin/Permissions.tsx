import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtTime, toIso, toLocalInput } from "../../lib/format";
import { toast } from "../../lib/toast";
import { useWsMessage } from "../../lib/ws";
import Modal from "../../components/Modal";

type Row = { id: string; scope_kind: string; scope_value: string; scope_label: string; grantee_kind: "user" | "role"; grantee: string; perms: string[];
  reason: string; granted_by: string; created_at: string; updated_at?: string; expires_at?: string | null; revoked_by?: string; status: "active" | "expired" | "revoked" };
type Options = { cameras: { id: string; name: string; department: string }[]; departments: string[]; routes: { id: string; name: string; priority: string; camera_count: number }[];
  users: { username: string; role: string }[]; roles: { name: string; description: string }[]; perms: { id: string; label: string; help: string }[] };

const SCOPE_CLS: Record<string, string> = { all: "all", department: "dept", route: "route", camera: "cam" };

export default function Permissions() {
  const [tab, setTab] = useState<"active" | "history">("active");
  const [scope, setScope] = useState(""); const [kind, setKind] = useState(""); const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]); const [labels, setLabels] = useState<Record<string, string>>({}); const [perms, setPerms] = useState<string[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState(""); const [editing, setEditing] = useState<Row | null | "new">(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ status: tab }); if (scope) qs.set("scope", scope); if (kind) qs.set("grantee_kind", kind); if (q.trim()) qs.set("q", q.trim());
    try {
      const [r, o] = await Promise.all([api(`/api/permissions?${qs}`), opts ? Promise.resolve(opts) : api<Options>("/api/permissions/options")]);
      setRows(r.items); setLabels(r.labels); setPerms(r.perms); setOpts(o); setErr("");
    } catch (e: any) { setErr(e.message); }
  }, [tab, scope, kind, q, opts]);
  useEffect(() => { const t = setTimeout(load, q ? 350 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { const i = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30000); return () => clearInterval(i); }, [load]);
  useWsMessage("inbox", useCallback((m) => { if (m.kind === "security" && /^Camera permission/.test(m.title || "")) load(); }, [load]));

  const revoke = async (r: Row) => {
    if (!confirm(`Revoke ${r.grantee}'s permissions on ${r.scope_label}?`)) return;
    try { await api(`/api/permissions/${r.id}`, { method: "DELETE" }); toast("Permission revoked — applies to signed-in users at once", "ok"); load(); } catch (e: any) { toast(e.message, "err"); }
  };
  const roleOf = (u: string) => opts?.users.find((x) => x.username === u)?.role || "user";

  return (
    <div className="panel" id="perms-panel">
      <div className="panel-head">
        <div><h3>Permission settings</h3><span className="muted small">Control who can do what on which cameras — a user or a role, one camera, a department, a VIP route or all cameras, optionally until a date. Applies to signed-in users at once.</span></div>
        <span><button className="btn small ghost" onClick={() => { setOpts(null); load(); }} title="Refresh">⟳</button> <button className="btn small primary" onClick={() => setEditing("new")}>+ Grant permission</button></span>
      </div>
      <div className="tabs small">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>🔐 Permissions</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>🕘 History</button>
      </div>
      <form className="search-form" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label>Scope <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">All scopes</option><option value="all">All cameras</option><option value="department">Departments</option><option value="route">VIP routes</option><option value="camera">Cameras</option></select></label>
        <label>Granted to <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option><option value="user">Users</option><option value="role">Roles</option></select></label>
        <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="user, role, camera…" /></label>
        <button className="btn small ghost">Apply filter</button><span className="muted small">{rows.length} row{rows.length === 1 ? "" : "s"}</span>
      </form>
      {err && <div className="inline-err">{err}</div>}
      <div className="scroll-x">
        <table className="table" id="perms-table">
          <thead><tr><th>Scope</th><th>Granted to</th><th>Type</th><th>Permissions</th><th>Expires</th><th>By</th><th></th></tr></thead>
          <tbody>
            {rows.length ? rows.map((r) => (
              <tr key={r.id} className={r.status === "active" ? "" : "muted"}>
                <td><span className={`scope-chip ${SCOPE_CLS[r.scope_kind] || "cam"}`} title={r.scope_value}>{r.scope_kind === "all" ? "All cameras" : r.scope_kind === "route" ? `★ ${r.scope_label.replace(/^Route: /, "")}` : r.scope_label}</span></td>
                <td>{r.grantee_kind === "role" ? "👥" : "👤"} <b>{r.grantee}</b>{r.status !== "active" && <> <span className={r.status === "revoked" ? "bad-chip" : "warn-chip"}>{r.status}{r.revoked_by ? ` by ${r.revoked_by}` : ""}</span></>}{r.reason && <div className="muted small">{r.reason}</div>}</td>
                <td><span className={`type-chip ${r.grantee_kind}`}>{r.grantee_kind === "role" ? "Role" : roleOf(r.grantee)}</span></td>
                <td className="pchips">{perms.map((p) => <span key={p} className={`pchip ${p} ${r.perms.includes(p) ? "" : "off"}`} title={`${labels[p]}${r.perms.includes(p) ? "" : " — not granted"}`}>{labels[p]}</span>)}</td>
                <td className="muted">{r.expires_at ? fmtTime(r.expires_at) : "Never"}</td>
                <td className="muted small">{r.granted_by}<div>{fmtTime(r.updated_at || r.created_at)}</div></td>
                <td className="nowrap">{r.status === "active" && <><button className="btn ghost small" title="Change" onClick={() => setEditing(r)}>✎</button> <button className="btn ghost small danger" title="Revoke" onClick={() => revoke(r)}>🗑</button></>}</td>
              </tr>
            )) : <tr><td colSpan={7} className="muted">{tab === "active" ? "No permissions granted yet — press + Grant permission." : "No past permissions."}</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && opts && <GrantDialog row={editing === "new" ? null : editing} opts={opts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTab("active"); load(); }} />}
    </div>
  );
}

type Choice = { k: string; v: string; label: string; grp: string; sub?: string };

function GrantDialog({ row, opts, onClose, onSaved }: { row: Row | null; opts: Options; onClose: () => void; onSaved: () => void }) {
  const choices = useMemo<Choice[]>(() => [
    { k: "all", v: "*", label: "All cameras", grp: "" },
    ...opts.departments.map((d) => ({ k: "department", v: d, label: d, grp: "Departments (every camera in it)", sub: `${opts.cameras.filter((c) => c.department === d).length} cameras` })),
    ...opts.routes.map((r) => ({ k: "route", v: r.id, label: `${r.priority === "vip" ? "★ " : ""}${r.name}`, grp: "VIP routes (follows the route's cameras)", sub: `${r.camera_count} cameras` })),
    ...opts.cameras.map((c) => ({ k: "camera", v: c.id, label: c.name, grp: `Cameras · ${c.department || "—"}`, sub: c.id })),
  ], [opts]);
  const key = (c: { k: string; v: string }) => `${c.k}:${c.v}`;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(row ? [`${row.scope_kind}:${row.scope_value}`] : []));
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"role" | "user">(row?.grantee_kind || "role");
  const [grantee, setGrantee] = useState(row?.grantee || "");
  const [perms, setPerms] = useState<Set<string>>(() => new Set(row ? row.perms : ["live"]));
  const [expires, setExpires] = useState(row?.expires_at ? toLocalInput(new Date(row.expires_at)) : "");
  const [reason, setReason] = useState(row?.reason || "");
  const [busy, setBusy] = useState(false);

  const toggle = (c: Choice, on: boolean) => setPicked((s) => { const n = new Set(s); const k = key(c); if (on) { if (k === "all:*") return new Set(["all:*"]); n.delete("all:*"); n.add(k); } else n.delete(k); return n; });
  const vis = choices.filter((c) => { const f = filter.toLowerCase().trim(); return !f || c.label.toLowerCase().includes(f) || (c.sub || "").toLowerCase().includes(f) || c.grp.toLowerCase().includes(f); });
  const pickedChoices = [...picked].map((k) => choices.find((c) => key(c) === k)).filter(Boolean) as Choice[];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!perms.size) return toast("Tick at least one permission", "warn");
    const expires_at = expires ? toIso(expires) : "";
    setBusy(true);
    try {
      if (row) await api(`/api/permissions/${row.id}`, { method: "PATCH", body: JSON.stringify({ perms: [...perms], expires_at, reason: reason.trim() }) });
      else {
        if (!picked.size) { setBusy(false); return toast("Choose at least one camera, department or route", "warn"); }
        if (!grantee) { setBusy(false); return toast(`Choose a ${kind}`, "warn"); }
        const scopes = [...picked].map((x) => { const i = x.indexOf(":"); return { scope_kind: x.slice(0, i), scope_value: x.slice(i + 1) }; });
        await api("/api/permissions", { method: "POST", body: JSON.stringify({ scopes, grantee_kind: kind, grantee, perms: [...perms], expires_at: expires_at || null, reason: reason.trim() }) });
      }
      toast(row ? "Permission updated" : `Permission granted on ${picked.size} scope${picked.size === 1 ? "" : "s"} — signed-in users get it at once`, "ok");
      onSaved();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };

  let lastGrp: string | null = null;
  return (
    <Modal open onClose={onClose}>
      <h3>{row ? "Change permission" : "Grant camera permission"}</h3>
      <form className="search-form perm-form" style={{ display: "grid", gap: 12 }} onSubmit={submit}>
        <div>
          <div className="muted small" style={{ marginBottom: 5 }}>Cameras {!row && <span className="muted">— tick one or more: cameras, departments or VIP routes</span>}</div>
          <div className={`campick ${row ? "disabled" : ""}`}>
            <div className="campick-chips">
              {pickedChoices.length ? pickedChoices.map((c) => <span key={key(c)} className={`scope-chip ${SCOPE_CLS[c.k]}`}>{c.label}{!row && <button type="button" className="x" onClick={() => toggle(c, false)}>×</button>}</span>) : (row ? null : <span className="muted small">nothing selected yet</span>)}
            </div>
            {!row && <>
              <input id="perm-pick-q" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search cameras, departments, routes…" autoComplete="off" />
              <div className="campick-list">
                {vis.length ? vis.map((c) => { const g = c.grp !== lastGrp ? c.grp : null; lastGrp = c.grp; return (
                  <div key={key(c)}>
                    {g ? <div className="combo-group">{g}</div> : null}
                    <label className={`campick-item ${picked.has(key(c)) ? "on" : ""}`}><input type="checkbox" checked={picked.has(key(c))} onChange={(e) => toggle(c, e.target.checked)} /> <span>{c.label}</span><span className="muted small">{c.sub || ""}</span></label>
                  </div>); }) : <div className="combo-empty muted small">No match</div>}
              </div>
            </>}
          </div>
        </div>
        <div><div className="muted small" style={{ marginBottom: 5 }}>Grant to</div>
          <div className="seg"><button type="button" className={kind === "role" ? "active" : ""} disabled={!!row} onClick={() => { setKind("role"); setGrantee(""); }}>👥 Role</button><button type="button" className={kind === "user" ? "active" : ""} disabled={!!row} onClick={() => { setKind("user"); setGrantee(""); }}>👤 User</button></div></div>
        {kind === "role"
          ? <label>Role <select value={grantee} disabled={!!row} onChange={(e) => setGrantee(e.target.value)}><option value="">Select role…</option>{opts.roles.map((r) => <option key={r.name} value={r.name}>{r.name}{r.description ? ` — ${r.description}` : ""}</option>)}</select></label>
          : <label>User <select value={grantee} disabled={!!row} onChange={(e) => setGrantee(e.target.value)}><option value="">Select user…</option>{opts.users.map((u) => <option key={u.username} value={u.username}>{u.username} ({u.role})</option>)}</select></label>}
        <div><div className="muted small" style={{ marginBottom: 5 }}>Permissions</div>
          <div className="perm-grid">{opts.perms.map((p) => <button key={p.id} type="button" className={`perm-btn ${p.id} ${perms.has(p.id) ? "on" : ""}`} title={p.help} onClick={() => setPerms((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>{p.label}</button>)}</div></div>
        <label>Expires (optional) <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <label>Reason (optional) <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="shift cover, event duty, court order…" /></label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          <span className="muted small">{picked.size > 1 ? `${picked.size} scopes → ${picked.size} rows` : ""}</span>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{row ? "Save" : "Grant permission"}</button>
        </div>
      </form>
    </Modal>
  );
}
