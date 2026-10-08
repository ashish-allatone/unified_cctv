import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export type UserRow = {
  username: string;
  provider: string;
  role: string;
  departments: string[];
  cameras?: string[];
  is_super: boolean;
  is_active: boolean;
  mfa_enrolled: boolean;
  mfa_required: boolean;
  locked_until?: string | null;
  last_login?: string | null;
  active_grants: number;
};

type Cam = { id: string; name: string; department: string };

type SortField = "username" | "role" | "provider" | "last_login" | "active_grants" | "status";
type SortDir = "asc" | "desc";

export default function Users() {
  const { user: me } = useAuth();
  const su = !!me?.is_super;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [cams, setCams] = useState<Cam[]>([]);
  const [roles, setRoles] = useState<string[]>(["viewer", "analyst", "supervisor", "admin"]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // Modal dialog states
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);

  // Search & Filter states
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [mfaFilter, setMfaFilter] = useState("");

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("username");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [us, reg, rl] = await Promise.all([
        api<UserRow[]>("/api/admin/users"),
        api("/api/registry").catch(() => []),
        api("/api/roles").catch(() => null),
      ]);
      setUsers(Array.isArray(us) ? us : []);
      setCams(
        (Array.isArray(reg) ? reg : [])
          .map((c: any) => ({ id: c.id, name: c.name, department: c.department }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      if (rl?.roles && Array.isArray(rl.roles)) {
        setRoles(rl.roles.map((r: any) => r.name));
      }
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = (p: Promise<any>, ok?: string) =>
    p
      .then(() => {
        if (ok) toast(ok, "ok");
        load();
      })
      .catch((e) => toast(e.message, "err"));

  const camName = (id: string) => cams.find((c) => c.id === id)?.name || id;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  // Mini Dashboard Statistics
  const stats = useMemo(() => {
    const total = users.length;
    const activeCount = users.filter((u) => u.is_active !== false).length;
    const inactiveCount = users.filter((u) => u.is_active === false).length;
    const superCount = users.filter((u) => u.is_super).length;
    const mfaCount = users.filter((u) => u.mfa_enrolled).length;
    const mfaReqCount = users.filter((u) => u.mfa_required && !u.mfa_enrolled).length;
    const lockedCount = users.filter((u) => !!u.locked_until).length;
    return { total, activeCount, inactiveCount, superCount, mfaCount, mfaReqCount, lockedCount };
  }, [users]);

  // Client-Side Search, Filter, and Sort
  const filteredUsers = useMemo(() => {
    let list = users;

    if (q.trim()) {
      const query = q.trim().toLowerCase();
      list = list.filter((u) => {
        const matchName = u.username.toLowerCase().includes(query);
        const matchRole = u.role?.toLowerCase().includes(query);
        const matchProvider = u.provider?.toLowerCase().includes(query);
        const matchDept = u.departments?.some((d) => d.toLowerCase().includes(query));
        return matchName || matchRole || matchProvider || matchDept;
      });
    }

    if (roleFilter) {
      list = list.filter((u) => u.role === roleFilter);
    }

    if (statusFilter === "active") {
      list = list.filter((u) => u.is_active !== false && !u.locked_until);
    } else if (statusFilter === "inactive") {
      list = list.filter((u) => u.is_active === false);
    } else if (statusFilter === "locked") {
      list = list.filter((u) => !!u.locked_until);
    } else if (statusFilter === "super") {
      list = list.filter((u) => u.is_super);
    }

    if (providerFilter) {
      list = list.filter((u) => u.provider === providerFilter);
    }

    if (mfaFilter === "enrolled") {
      list = list.filter((u) => u.mfa_enrolled);
    } else if (mfaFilter === "required") {
      list = list.filter((u) => u.mfa_required);
    } else if (mfaFilter === "none") {
      list = list.filter((u) => !u.mfa_enrolled && !u.mfa_required);
    }

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === "username") {
        cmp = a.username.localeCompare(b.username);
      } else if (sortField === "role") {
        cmp = (a.role || "").localeCompare(b.role || "");
      } else if (sortField === "provider") {
        cmp = (a.provider || "").localeCompare(b.provider || "");
      } else if (sortField === "last_login") {
        const timeA = a.last_login ? new Date(a.last_login).getTime() : 0;
        const timeB = b.last_login ? new Date(b.last_login).getTime() : 0;
        cmp = timeA - timeB;
      } else if (sortField === "active_grants") {
        cmp = (a.active_grants || 0) - (b.active_grants || 0);
      } else if (sortField === "status") {
        const rank = (u: UserRow) => (u.locked_until ? 0 : u.is_active === false ? 1 : u.is_super ? 3 : 2);
        cmp = rank(a) - rank(b);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [users, q, roleFilter, statusFilter, providerFilter, mfaFilter, sortField, sortDir]);

  const clearFilters = () => {
    setQ("");
    setRoleFilter("");
    setStatusFilter("");
    setProviderFilter("");
    setMfaFilter("");
  };

  return (
    <div className="users-console-root">
      {/* Mini Dashboard Overview Cards */}
      <div className="perm-kpis-grid">
        {/* Total Users */}
        <div
          className={`perm-kpi-card perm-kpi-interactive ${statusFilter === "" && !q ? "active-kpi-filter" : ""}`}
          onClick={clearFilters}
          role="button"
          tabIndex={0}
          title="Click to view all users"
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
              <span className="kpi-label">Total Accounts</span>
              <span className="kpi-action-link">Reset</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.total}</span>
              <span className="kpi-sub-pill sober-pill">{stats.activeCount} active</span>
            </div>
            <span className="kpi-desc">Directory &amp; local database identities</span>
          </div>
        </div>

        {/* Super Admins */}
        <div
          className={`perm-kpi-card perm-kpi-interactive ${statusFilter === "super" ? "active-kpi-filter" : ""}`}
          onClick={() => setStatusFilter(statusFilter === "super" ? "" : "super")}
          role="button"
          tabIndex={0}
          title="Click to filter super administrators"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Super Admins</span>
              <span className="kpi-action-link">{statusFilter === "super" ? "Filtered ✓" : "Filter"}</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.superCount}</span>
              <span className="kpi-sub-pill sober-pill">Root privileges</span>
            </div>
            <span className="kpi-desc">Full system &amp; security governance access</span>
          </div>
        </div>

        {/* 2FA / MFA Protected */}
        <div
          className={`perm-kpi-card perm-kpi-interactive ${mfaFilter === "enrolled" ? "active-kpi-filter" : ""}`}
          onClick={() => setMfaFilter(mfaFilter === "enrolled" ? "" : "enrolled")}
          role="button"
          tabIndex={0}
          title="Click to filter 2FA enrolled users"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">MFA Enrolled</span>
              <span className="kpi-action-link">{mfaFilter === "enrolled" ? "Filtered ✓" : "Filter"}</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.mfaCount}</span>
              <span className="kpi-sub-pill sober-pill">
                {stats.mfaReqCount ? `${stats.mfaReqCount} pending` : "Secured"}
              </span>
            </div>
            <span className="kpi-desc">Two-factor TOTP authentication active</span>
          </div>
        </div>

        {/* Locked / Issues */}
        <div
          className={`perm-kpi-card perm-kpi-interactive ${statusFilter === "locked" ? "active-kpi-filter" : ""}`}
          onClick={() => setStatusFilter(statusFilter === "locked" ? "" : "locked")}
          role="button"
          tabIndex={0}
          title="Click to filter locked accounts"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Security Lockouts</span>
              <span className="kpi-action-link">{statusFilter === "locked" ? "Filtered ✓" : "Inspect"}</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{stats.lockedCount}</span>
              <span className={`kpi-sub-pill ${stats.lockedCount > 0 ? "warn-pill" : "sober-pill"}`}>
                {stats.lockedCount > 0 ? "Action required" : "No lockouts"}
              </span>
            </div>
            <span className="kpi-desc">Brute-force lockout prevention status</span>
          </div>
        </div>
      </div>

      {/* Main Table Container Card */}
      <div className="perm-panel-card">
        {/* Header Toolbar */}
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>User Directory</h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              {su
                ? "You are a Super Administrator: manage role mappings, department/camera boundaries and authentication."
                : "Accounts are provisioned by super administrators; external directory users appear after initial login."}
            </p>
          </div>
          <div className="perm-actions-group">
            <button
              type="button"
              className="btn ghost icon small refresh-btn"
              onClick={load}
              title="Refresh users directory"
              disabled={loading}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? "spin" : ""}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            {su && (
              <button type="button" className="btn primary perm-grant-btn" onClick={() => setCreating(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>+ Create User</span>
              </button>
            )}
          </div>
        </div>

        {/* Filter Bar with Search, Role, Status, Provider, 2FA */}
        <div className="perm-filter-strip">
          {/* Search box */}
          <div className="perm-search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search user, role, provider or department…"
              className="search-input"
            />
            {q && (
              <button type="button" className="clear-btn" onClick={() => setQ("")} title="Clear search">
                ×
              </button>
            )}
          </div>

          {/* Role Filter */}
          <div className="perm-select-wrap">
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="perm-select">
              <option value="">All Roles</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  Role: {r}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="perm-select-wrap">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="perm-select">
              <option value="">All Statuses</option>
              <option value="active">Active Only</option>
              <option value="inactive">Inactive Only</option>
              <option value="locked">Locked Out</option>
              <option value="super">Super Admins</option>
            </select>
          </div>

          {/* Provider Filter */}
          <div className="perm-select-wrap">
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="perm-select">
              <option value="">All Providers</option>
              <option value="db">Local Database (db)</option>
              <option value="ldap">LDAP / Active Directory</option>
              <option value="sso">Single Sign-On (sso)</option>
            </select>
          </div>

          {/* 2FA Filter */}
          <div className="perm-select-wrap">
            <select value={mfaFilter} onChange={(e) => setMfaFilter(e.target.value)} className="perm-select">
              <option value="">All 2FA</option>
              <option value="enrolled">2FA Enrolled</option>
              <option value="required">2FA Required</option>
              <option value="none">2FA None</option>
            </select>
          </div>

          {/* Result Count */}
          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>
              {filteredUsers.length} of {users.length} {users.length === 1 ? "user" : "users"}
            </span>
          </div>
        </div>

        {err && <div className="inline-err-banner">{err}</div>}

        {/* User Data Table with Sortable Columns */}
        <div className="perm-table-container">
          <table className="perm-table users-table" id="users-table">
            <thead>
              <tr>
                {/* Username Header (Sortable) */}
                <th
                  style={{ width: "22%", cursor: "pointer", userSelect: "none" }}
                  onClick={() => toggleSort("username")}
                  title="Click to sort by username"
                >
                  <div className="th-sort-wrapper">
                    <span>User &amp; Identity</span>
                    <span className="sort-indicator">
                      {sortField === "username" ? (sortDir === "asc" ? " ▲" : " ▼") : " ↕"}
                    </span>
                  </div>
                </th>

                {/* Role Header (Sortable) */}
                <th
                  style={{ width: "12%", cursor: "pointer", userSelect: "none" }}
                  onClick={() => toggleSort("role")}
                  title="Click to sort by role"
                >
                  <div className="th-sort-wrapper">
                    <span>Role</span>
                    <span className="sort-indicator">
                      {sortField === "role" ? (sortDir === "asc" ? " ▲" : " ▼") : " ↕"}
                    </span>
                  </div>
                </th>

                {/* Provider Header (Sortable) */}
                <th
                  style={{ width: "10%", cursor: "pointer", userSelect: "none" }}
                  onClick={() => toggleSort("provider")}
                  title="Click to sort by provider"
                >
                  <div className="th-sort-wrapper">
                    <span>Provider</span>
                    <span className="sort-indicator">
                      {sortField === "provider" ? (sortDir === "asc" ? " ▲" : " ▼") : " ↕"}
                    </span>
                  </div>
                </th>

                {/* Access Header */}
                <th style={{ width: "24%" }}>Camera &amp; Department Access</th>

                {/* 2FA Header */}
                <th style={{ width: "8%" }}>2FA / MFA</th>

                {/* Last Login Header (Sortable) */}
                <th
                  style={{ width: "11%", cursor: "pointer", userSelect: "none" }}
                  onClick={() => toggleSort("last_login")}
                  title="Click to sort by last login"
                >
                  <div className="th-sort-wrapper">
                    <span>Last Login</span>
                    <span className="sort-indicator">
                      {sortField === "last_login" ? (sortDir === "asc" ? " ▲" : " ▼") : " ↕"}
                    </span>
                  </div>
                </th>

                {/* Grants Header (Sortable) */}
                <th
                  style={{ width: "5%", cursor: "pointer", userSelect: "none", textAlign: "center" }}
                  onClick={() => toggleSort("active_grants")}
                  title="Click to sort by active grants"
                >
                  <div className="th-sort-wrapper" style={{ justifyContent: "center" }}>
                    <span>Grants</span>
                    <span className="sort-indicator">
                      {sortField === "active_grants" ? (sortDir === "asc" ? " ▲" : " ▼") : " ↕"}
                    </span>
                  </div>
                </th>

                {/* Action Header */}
                <th style={{ width: "8%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.length ? (
                filteredUsers.map((u) => {
                  const isSelf = me?.username === u.username;
                  return (
                    <tr
                      key={u.username}
                      className={`perm-row ${u.is_active === false ? "revoked-row" : ""}`}
                    >
                      {/* User & Identity */}
                      <td>
                        <div className="grantee-cell">
                          <div
                            className="sober-avatar"
                            title={u.is_super ? "Super Administrator" : "User"}
                          >
                            {u.is_super ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                            ) : (
                              u.username.slice(0, 2).toUpperCase()
                            )}
                          </div>
                          <div className="grantee-meta">
                            <div className="grantee-title-row">
                              <span className="grantee-name">{u.username}</span>
                              {isSelf && <span className="sober-tag">you</span>}
                              {u.is_super && <span className="sober-tag bold-tag">super admin</span>}
                              {u.is_active === false && <span className="sober-tag inactive-tag">inactive</span>}
                              {u.locked_until && <span className="sober-tag locked-tag">locked</span>}
                            </div>
                            <span className="grantee-subtext">
                              {u.provider === "db" ? "Local database" : `${u.provider.toUpperCase()} directory`}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Role */}
                      <td>
                        <span className="sober-role-text">{u.role || "viewer"}</span>
                      </td>

                      {/* Provider */}
                      <td>
                        <span className="sober-provider-tag">{u.provider.toUpperCase()}</span>
                      </td>

                      {/* Camera & Department Access */}
                      <td>
                        <div className="access-info-cell">
                          <div className="access-depts-text">
                            {u.departments && u.departments.length ? (
                              u.departments.includes("*") ? (
                                <span className="sober-access-all">All Departments</span>
                              ) : (
                                <span>{u.departments.join(", ")}</span>
                              )
                            ) : (
                              <span className="sober-muted-dash">No department access</span>
                            )}
                          </div>
                          {!!u.cameras?.length && (
                            <div className="access-cams-text">
                              {u.cameras.length} camera{u.cameras.length === 1 ? "" : "s"}:{" "}
                              {u.cameras.slice(0, 3).map(camName).join(", ")}
                              {u.cameras.length > 3 ? ` (+${u.cameras.length - 3})` : ""}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* 2FA Status */}
                      <td>
                        <div className="sober-2fa-cell">
                          {u.mfa_enrolled ? (
                            <span className="sober-2fa-status">
                              <span className="status-dot dot-ok" /> Enrolled
                            </span>
                          ) : u.mfa_required ? (
                            <span className="sober-2fa-status">
                              <span className="status-dot dot-warn" /> Required
                            </span>
                          ) : (
                            <span className="sober-muted-dash">–</span>
                          )}
                        </div>
                      </td>

                      {/* Last Login */}
                      <td>
                        <div className="audit-cell">
                          <span className="audit-time">{u.last_login ? fmtTime(u.last_login) : "Never"}</span>
                          {u.locked_until && (
                            <span className="locked-warning-text">
                              Locked until {fmtTime(u.locked_until)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Active Grants */}
                      <td style={{ textAlign: "center" }}>
                        <span className="sober-grants-count">
                          {u.active_grants || 0}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: "right" }}>
                        <div className="row-actions-group">
                          {/* EDIT OPTION (Pencil Button) */}
                          <button
                            type="button"
                            className="action-btn edit-action"
                            title={`Edit ${u.username} (role, access scopes & settings)`}
                            onClick={() => setEditingUser(u)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>

                          {/* UNLOCK ACTION (If locked) */}
                          {u.locked_until && (
                            <button
                              type="button"
                              className="action-btn"
                              title="Unlock account from lockout"
                              onClick={() => act(api(`/api/admin/users/${u.username}/unlock`, { method: "POST" }), "Account unlocked")}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                              </svg>
                            </button>
                          )}

                          {/* DELETE ACTION (If super admin and not self) */}
                          {su && u.provider === "db" && !isSelf && (
                            <button
                              type="button"
                              className="action-btn delete-action"
                              title={`Delete account ${u.username}`}
                              onClick={() => {
                                if (confirm(`Permanently delete account "${u.username}" and its credentials?`)) {
                                  act(api(`/api/users/${u.username}`, { method: "DELETE" }), `Account ${u.username} deleted`);
                                }
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8}>
                    <div className="perm-empty-state">
                      <div className="empty-ico-box">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                        </svg>
                      </div>
                      <h4>No users found</h4>
                      <p>No user accounts match the current filter or search criteria.</p>
                      {(q || roleFilter || statusFilter || providerFilter || mfaFilter) && (
                        <button type="button" className="btn ghost small clear-filters-btn" onClick={clearFilters}>
                          Clear All Filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* EDIT USER MODAL */}
      {editingUser && (
        <EditUserDialog
          u={editingUser}
          cams={cams}
          roles={roles}
          isSuperAdmin={su}
          isSelf={me?.username === editingUser.username}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null);
            load();
          }}
        />
      )}

      {/* CREATE USER MODAL */}
      {creating && (
        <CreateDialog
          cams={cams}
          roles={roles}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// Department & Camera Access Picker Component
function DeptCams({
  depts,
  setDepts,
  mode,
  setMode,
  picked,
  setPicked,
  cams,
}: {
  depts: string[];
  setDepts: (d: string[]) => void;
  mode: "all" | "some" | "none";
  setMode: (m: "all" | "some" | "none") => void;
  picked: string[];
  setPicked: (p: string[]) => void;
  cams: Cam[];
}) {
  const allDepts = useMemo(() => [...new Set(cams.map((c) => c.department))].sort(), [cams]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6, display: "block" }}>
          Department Scope Boundary
        </label>
        <div className="grantee-type-seg">
          <button
            type="button"
            className={`type-seg-btn ${mode === "all" ? "active" : ""}`}
            onClick={() => setMode("all")}
          >
            Universal (All Departments)
          </button>
          <button
            type="button"
            className={`type-seg-btn ${mode === "some" ? "active" : ""}`}
            onClick={() => setMode("some")}
          >
            Specific Departments
          </button>
          <button
            type="button"
            className={`type-seg-btn ${mode === "none" ? "active" : ""}`}
            onClick={() => setMode("none")}
          >
            Restricted (Cameras Only)
          </button>
        </div>

        {mode === "some" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10, padding: 8, background: "var(--bg2)", borderRadius: 6, border: "1px solid var(--line)" }}>
            {allDepts.map((d) => {
              const checked = depts.includes(d);
              return (
                <label key={d} className={`picked-chip ${checked ? "" : "muted"}`} style={{ cursor: "pointer", userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setDepts(e.target.checked ? [...depts, d] : depts.filter((x) => x !== d))
                    }
                    style={{ marginRight: 4 }}
                  />
                  {d}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 4, display: "block" }}>
          Additional Explicit Cameras ({picked.length} selected)
        </label>
        <span style={{ fontSize: 11, color: "#64748b", display: "block", marginBottom: 6 }}>
          Hold Ctrl / Cmd to select multiple specific cameras outside department boundaries
        </span>
        <select
          multiple
          size={5}
          value={picked}
          onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}
          className="modal-full-select"
          style={{ height: 110 }}
        >
          {cams.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.department})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Comprehensive Edit User Dialog
function EditUserDialog({
  u,
  cams,
  roles,
  isSuperAdmin,
  isSelf,
  onClose,
  onSaved,
}: {
  u: UserRow;
  cams: Cam[];
  roles: string[];
  isSuperAdmin: boolean;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(u.role || "viewer");
  const [isActive, setIsActive] = useState(u.is_active !== false);
  const [mode, setMode] = useState<"all" | "some" | "none">(
    u.departments.includes("*") ? "all" : u.departments.length ? "some" : "none"
  );
  const [depts, setDepts] = useState<string[]>(u.departments.filter((d) => d !== "*"));
  const [picked, setPicked] = useState<string[]>(u.cameras || []);
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const departments = mode === "all" ? ["*"] : mode === "some" ? depts : [];
    const payload: any = {
      role,
      departments,
      cameras: picked,
      is_active: isActive,
    };

    if (newPassword.trim()) {
      if (newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        setSaving(false);
        return toast("Password requirement: minimum 10 characters, 1 uppercase letter, 1 digit", "warn");
      }
      payload.password = newPassword.trim();
    }

    try {
      await api(`/api/users/${u.username}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      toast(`User "${u.username}" updated successfully`, "ok");
      onSaved();
    } catch (err: any) {
      toast(err.message || "Failed to save user", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose}>
      <div className="perm-modal-head" style={{ marginBottom: 12 }}>
        <div className="modal-title-box">
          <div className="kpi-icon-box sober-icon-box" style={{ width: 38, height: 38 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </div>
          <div>
            <h3 style={{ fontSize: 16, margin: 0, color: "var(--text)" }}>Edit User: {u.username}</h3>
            <span style={{ fontSize: 12, color: "#475569" }}>
              Configure role capabilities, camera access and security parameters
            </span>
          </div>
        </div>
      </div>

      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Profile & Status Row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Assigned Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="perm-select"
              style={{ width: "100%", height: 36 }}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Account Status
            </label>
            <div className="grantee-type-seg" style={{ height: 36, alignItems: "center" }}>
              <button
                type="button"
                className={`type-seg-btn ${isActive ? "active" : ""}`}
                onClick={() => setIsActive(true)}
              >
                Active
              </button>
              <button
                type="button"
                className={`type-seg-btn ${!isActive ? "active" : ""}`}
                onClick={() => !isSelf && setIsActive(false)}
                disabled={isSelf}
                title={isSelf ? "Cannot deactivate yourself" : "Deactivate account"}
              >
                Inactive
              </button>
            </div>
          </div>
        </div>

        {/* Password Reset (Optional) */}
        {u.provider === "db" && (
          <div style={{ padding: 10, background: "var(--bg2)", borderRadius: 7, border: "1px solid var(--line)" }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Set New Password (Optional)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Leave blank to keep existing password"
              autoComplete="new-password"
              className="modal-input"
              style={{ margin: 0 }}
            />
            <span style={{ fontSize: 10.5, color: "#64748b", marginTop: 4, display: "block" }}>
              If changing: min 10 characters, 1 uppercase letter, 1 digit
            </span>
          </div>
        )}

        {/* Scopes & Cameras Picker */}
        <DeptCams {...{ depts, setDepts, mode, setMode, picked, setPicked, cams }} />

        {/* Security Quick Actions */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 6 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {u.locked_until && (
              <button
                type="button"
                className="btn ghost small"
                style={{ color: "#78350f" }}
                onClick={() =>
                  api(`/api/admin/users/${u.username}/unlock`, { method: "POST" })
                    .then(() => toast("Account unlocked", "ok"))
                    .catch((err) => toast(err.message, "err"))
                }
              >
                Unlock Account
              </button>
            )}
            {u.mfa_enrolled && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  if (confirm(`Reset 2FA for ${u.username}? User will need to re-enroll next login.`)) {
                    api(`/api/auth/mfa/reset/${u.username}`, { method: "POST" })
                      .then(() => toast("2FA reset successfully", "ok"))
                      .catch((err) => toast(err.message, "err"));
                  }
                }}
              >
                Reset 2FA
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// Create User Dialog
function CreateDialog({
  cams,
  roles,
  onClose,
  onSaved,
}: {
  cams: Cam[];
  roles: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("viewer");
  const [isSuper, setIsSuper] = useState(false);
  const [mode, setMode] = useState<"all" | "some" | "none">("all");
  const [depts, setDepts] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const departments = mode === "all" ? ["*"] : mode === "some" ? depts : [];
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim(),
          password,
          role,
          departments,
          cameras: picked,
          is_super: isSuper,
        }),
      });
      toast(`User "${username}" successfully created`, "ok");
      onSaved();
    } catch (err: any) {
      toast(err.message || "Failed to create user", "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose}>
      <div className="perm-modal-head" style={{ marginBottom: 12 }}>
        <div className="modal-title-box">
          <div className="kpi-icon-box sober-icon-box" style={{ width: 38, height: 38 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </div>
          <div>
            <h3 style={{ fontSize: 16, margin: 0, color: "var(--text)" }}>Create New User</h3>
            <span style={{ fontSize: 12, color: "#475569" }}>
              Provision a local user account with credentials and access boundary
            </span>
          </div>
        </div>
      </div>

      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Username *
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="e.g. j.doe"
              autoComplete="off"
              className="modal-input"
              style={{ margin: 0 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Initial Password *
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              placeholder="min 10, 1 uppercase, 1 digit"
              className="modal-input"
              style={{ margin: 0 }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "center" }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="perm-select"
              style={{ width: "100%", height: 36 }}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 20 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "#334155", cursor: "pointer" }}>
              <input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} />
              Super Administrator (Full Root Access)
            </label>
          </div>
        </div>

        <DeptCams {...{ depts, setDepts, mode, setMode, picked, setPicked, cams }} />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Creating…" : "Create User"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
