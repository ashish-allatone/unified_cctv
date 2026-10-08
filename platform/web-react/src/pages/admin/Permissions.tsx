import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { fmtTime, toIso, toLocalInput } from "../../lib/format";
import { toast } from "../../lib/toast";
import { useWsMessage } from "../../lib/ws";
import Modal from "../../components/Modal";

type Row = {
  id: string;
  scope_kind: string;
  scope_value: string;
  scope_label: string;
  grantee_kind: "user" | "role";
  grantee: string;
  perms: string[];
  reason: string;
  granted_by: string;
  created_at: string;
  updated_at?: string;
  expires_at?: string | null;
  revoked_by?: string;
  status: "active" | "expired" | "revoked";
};

type Options = {
  cameras: { id: string; name: string; department: string }[];
  departments: string[];
  routes: { id: string; name: string; priority: string; camera_count: number }[];
  users: { username: string; role: string }[];
  roles: { name: string; description: string }[];
  perms: { id: string; label: string; help: string }[];
};

const PERM_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  live: { label: "Live Feed", color: "perm-live", icon: "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" },
  playback: { label: "Playback", color: "perm-playback", icon: "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  export: { label: "Export", color: "perm-export", icon: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" },
  search: { label: "Search", color: "perm-search", icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" },
  alerts: { label: "Alerts", color: "perm-alerts", icon: "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" },
  edit: { label: "Manage", color: "perm-edit", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" },
  ptz: { label: "PTZ", color: "perm-ptz", icon: "M12 2v4m0 12v4M2 12h4m12 0h4" },
};

export default function Permissions() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"active" | "history">("active");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [perms, setPerms] = useState<string[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<Row | null | "new">(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ status: tab });
    if (scope) qs.set("scope", scope);
    if (kind) qs.set("grantee_kind", kind);
    if (q.trim()) qs.set("q", q.trim());
    try {
      const [r, o] = await Promise.all([
        api(`/api/permissions?${qs}`),
        opts ? Promise.resolve(opts) : api<Options>("/api/permissions/options"),
      ]);
      setRows(r.items || []);
      setLabels(r.labels || {});
      setPerms(r.perms || []);
      setOpts(o);
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Failed to load permissions");
    } finally {
      setLoading(false);
    }
  }, [tab, scope, kind, q, opts]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  useEffect(() => {
    const i = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30000);
    return () => clearInterval(i);
  }, [load]);

  useWsMessage(
    "inbox",
    useCallback(
      (m) => {
        if (m.kind === "security" && /^Camera permission/.test(m.title || "")) load();
      },
      [load]
    )
  );

  const revoke = async (r: Row) => {
    if (!confirm(`Revoke ${r.grantee}'s access policy on "${r.scope_label}"?`)) return;
    try {
      await api(`/api/permissions/${r.id}`, { method: "DELETE" });
      toast("Permission policy revoked — live sessions updated instantly", "ok");
      load();
    } catch (e: any) {
      toast(e.message, "err");
    }
  };

  const roleOf = (u: string) => opts?.users.find((x) => x.username === u)?.role || "User";

  // Compute key stats for dashboard KPIs
  const stats = useMemo(() => {
    const totalActive = rows.filter((r) => r.status === "active").length;
    const rolePolicies = rows.filter((r) => r.grantee_kind === "role").length;
    const userPolicies = rows.filter((r) => r.grantee_kind === "user").length;
    const deptScopes = new Set(rows.filter((r) => r.scope_kind === "department").map((r) => r.scope_value)).size;
    const expSoon = rows.filter((r) => {
      if (!r.expires_at || r.status !== "active") return false;
      const diff = new Date(r.expires_at).getTime() - Date.now();
      return diff > 0 && diff < 7 * 86400000;
    }).length;
    return { totalActive, rolePolicies, userPolicies, deptScopes, expSoon };
  }, [rows]);

  // Robust client-side filter fallback ensuring instant & accurate updates
  const displayedRows = useMemo(() => {
    let list = rows;
    if (kind) {
      list = list.filter((r) => r.grantee_kind === kind);
    }
    if (scope) {
      if (scope === "all") list = list.filter((r) => r.scope_kind === "all");
      else if (scope === "department") list = list.filter((r) => r.scope_kind === "department");
      else if (scope === "route") list = list.filter((r) => r.scope_kind === "route");
      else if (scope === "camera") list = list.filter((r) => r.scope_kind === "camera");
    }
    return list;
  }, [rows, kind, scope]);

  return (
    <div className="perm-console-root">
      {/* KPI Overview Cards */}
      <div className="perm-kpis-grid">
        <div
          className={`perm-kpi-card perm-kpi-interactive ${kind === "" && scope === "" ? "active-kpi-filter" : ""}`}
          onClick={() => { setKind(""); setScope(""); setTab("active"); setQ(""); }}
          role="button"
          tabIndex={0}
          title="Click to view all active policies"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Active Policies</span>
              <span className="kpi-action-link">Reset Filters</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{tab === "active" ? rows.length : stats.totalActive}</span>
              <span className="kpi-sub-pill sober-pill">Enforced</span>
            </div>
            <span className="kpi-desc">Applies to live authenticated sessions</span>
          </div>
        </div>

        <div
          className={`perm-kpi-card perm-kpi-interactive ${kind === "role" ? "active-kpi-filter" : ""}`}
          onClick={() => navigate("/admin/roles")}
          role="button"
          tabIndex={0}
          title="Click to open the full Role Matrix (/admin/roles)"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Role Matrix</span>
              <span className="kpi-action-link">Open Matrix &rarr;</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.rolePolicies}</span>
              <span className="kpi-sub-pill sober-pill">{opts?.roles.length || 0} roles configured</span>
            </div>
            <div className="kpi-footer-row">
              <span className="kpi-desc">Global role capabilities</span>
              <button
                type="button"
                className={`kpi-mini-filter-btn ${kind === "role" ? "active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setKind(kind === "role" ? "" : "role");
                }}
                title="Filter table below to role policies"
              >
                {kind === "role" ? "Showing Roles ✓" : "Filter Roles"}
              </button>
            </div>
          </div>
        </div>

        <div className="perm-kpi-card">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="2" width="16" height="20" rx="2" />
              <line x1="9" y1="22" x2="9" y2="2" />
              <line x1="15" y1="22" x2="15" y2="2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <span className="kpi-label">Departments Governed</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{opts?.departments.length || 0}</span>
              <span className="kpi-sub-pill sober-pill">{opts?.cameras.length || 0} cameras</span>
            </div>
            <span className="kpi-desc">Across all monitored zones</span>
          </div>
        </div>

        <div className="perm-kpi-card">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="kpi-meta">
            <span className="kpi-label">Expiring Grants</span>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.expSoon}</span>
              <span className={`kpi-sub-pill ${stats.expSoon > 0 ? "warn-pill" : "sober-pill"}`}>
                {stats.expSoon > 0 ? "7-day window" : "None pending"}
              </span>
            </div>
            <span className="kpi-desc">Temporary security passes</span>
          </div>
        </div>
      </div>

      {/* Main Table Container Card */}
      <div className="perm-panel-card">
        {/* Header & Controls Toolbar */}
        <div className="perm-toolbar">
          {/* Left: Tab Switcher (Active vs History) */}
          <div className="perm-segmented-switch">
            <button
              type="button"
              className={`seg-tab-btn ${tab === "active" ? "active" : ""}`}
              onClick={() => setTab("active")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Active Policies</span>
              {tab === "active" && <span className="tab-badge">{rows.length}</span>}
            </button>
            <button
              type="button"
              className={`seg-tab-btn ${tab === "history" ? "active" : ""}`}
              onClick={() => setTab("history")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Audit History</span>
              {tab === "history" && <span className="tab-badge">{rows.length}</span>}
            </button>
          </div>

          {/* Right Action Buttons */}
          <div className="perm-actions-group">
            <button
              type="button"
              className="btn ghost icon small refresh-btn"
              onClick={() => { setOpts(null); load(); }}
              title="Refresh permissions list"
              disabled={loading}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? "spin" : ""}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              type="button"
              className="btn primary perm-grant-btn"
              onClick={() => setEditing("new")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Grant Permission</span>
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="perm-filter-strip">
          <div className="perm-search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by user, role, department or camera…"
              className="search-input"
            />
            {q && (
              <button type="button" className="clear-btn" onClick={() => setQ("")} title="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="perm-select-wrap">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="perm-select"
            >
              <option value="">All Scopes</option>
              <option value="all">All Cameras (Universal)</option>
              <option value="department">Departments</option>
              <option value="route">VIP Routes</option>
              <option value="camera">Specific Cameras</option>
            </select>
          </div>

          <div className="perm-select-wrap">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="perm-select"
            >
              <option value="">All Grantees</option>
              <option value="role">Roles (Group)</option>
              <option value="user">Users (Individual)</option>
            </select>
          </div>

          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>{displayedRows.length} {displayedRows.length === 1 ? "policy" : "policies"}</span>
          </div>
        </div>

        {err && <div className="inline-err-banner">{err}</div>}

        {/* Permissions Data Table Matching User Design */}
        <div className="acl-table-card">
          <div className="acl-table-scroll">
            <table className="acl-table">
              <thead>
                <tr>
                  <th style={{ width: "14%" }}>SCOPE / ZONE</th>
                  <th style={{ width: "22%" }}>GRANTED TO</th>
                  <th style={{ width: "12%" }}>TYPE</th>
                  <th style={{ width: "36%" }}>CAPABILITIES</th>
                  <th style={{ width: "10%" }}>VALIDITY</th>
                  <th style={{ width: "6%", textAlign: "right" }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {displayedRows.length ? (
                  displayedRows.map((r) => {
                    const isRole = r.grantee_kind === "role";
                    const isRevoked = r.status !== "active";

                    return (
                      <tr key={r.id} className={isRevoked ? "revoked-row" : ""}>
                        {/* BUCKET */}
                        <td>
                          <span className="acl-bucket-pill">{r.scope_label || r.scope_value}</span>
                        </td>

                        {/* GRANTED TO */}
                        <td>
                          <div className="acl-grantee-cell">
                            {isRole ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#9333ea" strokeWidth="2" className="acl-grantee-ico">
                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" className="acl-grantee-ico">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                              </svg>
                            )}
                            <span>{r.grantee}</span>
                          </div>
                        </td>

                        {/* TYPE */}
                        <td>
                          <span className={`acl-type-pill ${isRole ? "acl-type-role" : "acl-type-employee"}`}>
                            {isRole ? "Role" : "employee"}
                          </span>
                        </td>

                        {/* PERMISSIONS */}
                        <td>
                          <div className="acl-perms-strip">
                            {r.perms && r.perms.length ? (
                              r.perms.map((p) => {
                                const conf = PERM_CONFIG[p] || { label: labels[p] || p, color: "perm-view", icon: "" };
                                const pillClass =
                                  p === "live" ? "perm-view" :
                                  p === "ptz" ? "perm-upload" :
                                  p === "playback" ? "perm-download" :
                                  p === "admin" ? "perm-delete" :
                                  p === "export" ? "perm-share" :
                                  p === "search" ? "perm-folder" :
                                  "perm-alerts";
                                return (
                                  <span key={p} className={`acl-perm-badge ${pillClass} active`}>
                                    {labels[p] || conf.label}
                                  </span>
                                );
                              })
                            ) : (
                              <span style={{ color: "#94a3b8", fontSize: 11.5 }}>No permissions</span>
                            )}
                          </div>
                        </td>

                        {/* EXPIRES */}
                        <td>
                          <span className="acl-expires-text">
                            {r.expires_at ? fmtTime(r.expires_at) : "Never"}
                          </span>
                        </td>

                        {/* ACTIONS */}
                        <td style={{ textAlign: "right" }}>
                          {r.status === "active" ? (
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                              <button
                                type="button"
                                className="acl-action-trash"
                                title="Revoke access policy"
                                onClick={() => revoke(r)}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 16, height: 16 }}>
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <span style={{ color: "#94a3b8", fontSize: 12 }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "32px 16px" }}>
                      <span style={{ color: "#64748b", fontSize: 13 }}>No permission policies found</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Grant or Modify Permission Modal Dialog */}
      {editing && opts && (
        <GrantDialog
          row={editing === "new" ? null : editing}
          opts={opts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setTab("active");
            load();
          }}
        />
      )}
    </div>
  );
}

type Choice = { k: string; v: string; label: string; grp: string; sub?: string };

function GrantDialog({
  row,
  opts,
  onClose,
  onSaved,
}: {
  row: Row | null;
  opts: Options;
  onClose: () => void;
  onSaved: () => void;
}) {
  const choices = useMemo<Choice[]>(
    () => [
      { k: "all", v: "*", label: "All cameras", grp: "" },
      ...opts.departments.map((d) => ({
        k: "department",
        v: d,
        label: d,
        grp: "Departments (every camera in department)",
        sub: `${opts.cameras.filter((c) => c.department === d).length} cameras`,
      })),
      ...opts.routes.map((r) => ({
        k: "route",
        v: r.id,
        label: `${r.priority === "vip" ? "★ " : ""}${r.name}`,
        grp: "VIP routes (follows designated route cameras)",
        sub: `${r.camera_count} cameras`,
      })),
      ...opts.cameras.map((c) => ({
        k: "camera",
        v: c.id,
        label: c.name,
        grp: `Cameras · ${c.department || "General"}`,
        sub: c.id,
      })),
    ],
    [opts]
  );

  const key = (c: { k: string; v: string }) => `${c.k}:${c.v}`;
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(row ? [`${row.scope_kind}:${row.scope_value}`] : [])
  );
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"role" | "user">(row?.grantee_kind || "role");
  const [grantee, setGrantee] = useState(row?.grantee || "");
  const [perms, setPerms] = useState<Set<string>>(() => new Set(row ? row.perms : ["live"]));
  const [expires, setExpires] = useState(
    row?.expires_at ? toLocalInput(new Date(row.expires_at)) : ""
  );
  const [reason, setReason] = useState(row?.reason || "");
  const [busy, setBusy] = useState(false);

  const toggle = (c: Choice, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      const k = key(c);
      if (on) {
        if (k === "all:*") return new Set(["all:*"]);
        n.delete("all:*");
        n.add(k);
      } else {
        n.delete(k);
      }
      return n;
    });

  const vis = choices.filter((c) => {
    const f = filter.toLowerCase().trim();
    return (
      !f ||
      c.label.toLowerCase().includes(f) ||
      (c.sub || "").toLowerCase().includes(f) ||
      c.grp.toLowerCase().includes(f)
    );
  });

  const pickedChoices = [...picked]
    .map((k) => choices.find((c) => key(c) === k))
    .filter(Boolean) as Choice[];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!perms.size) return toast("Select at least one capability", "warn");
    const expires_at = expires ? toIso(expires) : "";
    setBusy(true);
    try {
      if (row) {
        await api(`/api/permissions/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ perms: [...perms], expires_at, reason: reason.trim() }),
        });
      } else {
        if (!picked.size) {
          setBusy(false);
          return toast("Choose at least one camera, department or VIP route", "warn");
        }
        if (!grantee) {
          setBusy(false);
          return toast(`Select a target ${kind}`, "warn");
        }
        const scopes = [...picked].map((x) => {
          const i = x.indexOf(":");
          return { scope_kind: x.slice(0, i), scope_value: x.slice(i + 1) };
        });
        await api("/api/permissions", {
          method: "POST",
          body: JSON.stringify({
            scopes,
            grantee_kind: kind,
            grantee,
            perms: [...perms],
            expires_at: expires_at || null,
            reason: reason.trim(),
          }),
        });
      }
      toast(
        row
          ? "Permission policy updated"
          : `Permission granted across ${picked.size} scope${picked.size === 1 ? "" : "s"} — live users updated instantly`,
        "ok"
      );
      onSaved();
    } catch (e: any) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  };

  let lastGrp: string | null = null;
  return (
    <Modal open onClose={onClose}>
      <div className="perm-modal-head">
        <div className="modal-title-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="modal-head-ico">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <div>
            <h3>{row ? "Modify Access Policy" : "Grant Security Policy"}</h3>
            <span className="modal-subtitle">
              {row ? `Updating scope for ${row.grantee}` : "Delegate camera view or control permissions to roles or users"}
            </span>
          </div>
        </div>
      </div>

      <form className="perm-modal-form" onSubmit={submit}>
        {/* Scope Selection Box */}
        <div className="modal-section">
          <label className="section-title">
            <span>Target Scopes</span>
            <span className="section-hint">Select departments, cameras, or routes</span>
          </label>

          <div className={`scope-picker-box ${row ? "picker-locked" : ""}`}>
            <div className="picked-chips-strip">
              {pickedChoices.length ? (
                pickedChoices.map((c) => (
                  <span key={key(c)} className="picked-chip">
                    <span>{c.label}</span>
                    {!row && (
                      <button type="button" className="chip-remove" onClick={() => toggle(c, false)}>
                        ×
                      </button>
                    )}
                  </span>
                ))
              ) : (
                <span className="chips-placeholder">No scope selected yet — pick below</span>
              )}
            </div>

            {!row && (
              <>
                <div className="picker-search-bar">
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Search cameras, departments, routes…"
                    autoComplete="off"
                  />
                </div>
                <div className="picker-scroll-list">
                  {vis.length ? (
                    vis.map((c) => {
                      const g = c.grp !== lastGrp ? c.grp : null;
                      lastGrp = c.grp;
                      return (
                        <div key={key(c)}>
                          {g && <div className="picker-group-label">{g}</div>}
                          <label className={`picker-row ${picked.has(key(c)) ? "checked" : ""}`}>
                            <input
                              type="checkbox"
                              checked={picked.has(key(c))}
                              onChange={(e) => toggle(c, e.target.checked)}
                            />
                            <span className="picker-item-label">{c.label}</span>
                            {c.sub && <span className="picker-item-sub">{c.sub}</span>}
                          </label>
                        </div>
                      );
                    })
                  ) : (
                    <div className="picker-empty">No matching scopes found</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Grantee Target Box */}
        <div className="modal-section">
          <label className="section-title">
            <span>Assignee</span>
            <span className="section-hint">Who receives this authorization</span>
          </label>

          <div className="grantee-type-seg">
            <button
              type="button"
              className={`type-seg-btn ${kind === "role" ? "active" : ""}`}
              disabled={!!row}
              onClick={() => { setKind("role"); setGrantee(""); }}
            >
              👥 Role Matrix
            </button>
            <button
              type="button"
              className={`type-seg-btn ${kind === "user" ? "active" : ""}`}
              disabled={!!row}
              onClick={() => { setKind("user"); setGrantee(""); }}
            >
              👤 Explicit User
            </button>
          </div>

          <div className="grantee-select-wrap">
            {kind === "role" ? (
              <select
                value={grantee}
                disabled={!!row}
                onChange={(e) => setGrantee(e.target.value)}
                className="perm-select modal-full-select"
              >
                <option value="">Select Target Role…</option>
                {opts.roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name} {r.description ? `— ${r.description}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={grantee}
                disabled={!!row}
                onChange={(e) => setGrantee(e.target.value)}
                className="perm-select modal-full-select"
              >
                <option value="">Select Target User…</option>
                {opts.users.map((u) => (
                  <option key={u.username} value={u.username}>
                    {u.username} ({u.role})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Permissions Capability Grid */}
        <div className="modal-section">
          <label className="section-title">
            <span>Capabilities</span>
            <span className="section-hint">Allowed video feed operations</span>
          </label>

          <div className="modal-perm-grid">
            {opts.perms.map((p) => {
              const active = perms.has(p.id);
              const conf = PERM_CONFIG[p.id];
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`modal-perm-card ${active ? "checked" : ""}`}
                  onClick={() =>
                    setPerms((s) => {
                      const n = new Set(s);
                      n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                      return n;
                    })
                  }
                >
                  <div className="card-checkbox-row">
                    <span className="perm-card-title">{p.label}</span>
                    <span className={`perm-card-check ${active ? "on" : ""}`}>{active ? "✓" : ""}</span>
                  </div>
                  <span className="perm-card-help">{p.help}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Expiration and Justification */}
        <div className="modal-row-grid">
          <div>
            <label className="section-title">
              <span>Expiration</span>
              <span className="section-hint">Leave blank for permanent</span>
            </label>
            <input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className="modal-input"
            />
          </div>

          <div>
            <label className="section-title">
              <span>Justification / Reason</span>
              <span className="section-hint">Optional audit context</span>
            </label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Incident investigation, shift cover…"
              className="modal-input"
            />
          </div>
        </div>

        {/* Modal Footer Controls */}
        <div className="modal-footer">
          <span className="modal-scope-count">
            {picked.size > 1 ? `${picked.size} scopes queued` : ""}
          </span>
          <div className="modal-btn-pair">
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy}>
              {busy ? "Processing…" : row ? "Save Changes" : "Apply Policy"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
