import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export type Role = {
  name: string;
  description: string;
  features: string[];
  builtin: boolean;
  users: number;
  rank: number;
};

export type Feat = {
  id: string;
  label: string;
};

// Helpful descriptions and domain categorizations for system permissions
const FEAT_DEFINITIONS: Record<string, { desc: string; category: string }> = {
  live: { desc: "Access live camera streams and interactive video wall", category: "Surveillance & Feeds" },
  ptz: { desc: "Pan, tilt and optical zoom camera controls", category: "Surveillance & Feeds" },
  playback: { desc: "Search and play back recorded video archives", category: "Surveillance & Feeds" },
  wall: { desc: "Configure multi-grid layouts and monitor presets", category: "Surveillance & Feeds" },

  search: { desc: "Forensic timeline search across recorded events", category: "Forensics & Intelligence" },
  export: { desc: "Download and export signed tamper-evident MP4 clips", category: "Forensics & Intelligence" },
  alerts: { desc: "Receive and acknowledge real-time dispatch alerts", category: "Forensics & Intelligence" },
  anpr: { desc: "Query license plate recognitions and vehicle watchlist", category: "Forensics & Intelligence" },
  face: { desc: "Facial recognition matches and person-of-interest logs", category: "Forensics & Intelligence" },

  users: { desc: "Create, edit and manage operator accounts and 2FA", category: "Access & Governance" },
  roles: { desc: "Configure role matrix capabilities and security tiers", category: "Access & Governance" },
  grants: { desc: "Issue temporary cross-department emergency passes", category: "Access & Governance" },
  holds: { desc: "Place legal evidence holds protecting footage from deletion", category: "Access & Governance" },
  admin: { desc: "Root platform administration and system governance", category: "Access & Governance" },

  registry: { desc: "View camera hardware catalog and stream telemetry", category: "System & Platform" },
  registry_edit: { desc: "Add, modify and decommission cameras and RTSP URLs", category: "System & Platform" },
  archival: { desc: "Set retention schedules, cold storage tiers and quotas", category: "System & Platform" },
  dpdp: { desc: "Process citizen privacy requests and audit erasure logs", category: "System & Platform" },
  keys: { desc: "Manage API tokens, ingest keys and rate limits", category: "System & Platform" },
  hooks: { desc: "Subscribe to real-time event webhooks and push alerts", category: "System & Platform" },
  tenants: { desc: "Tenant isolation and camera vendor presets", category: "System & Platform" },
};

function getFeatInfo(f: Feat) {
  const def = FEAT_DEFINITIONS[f.id];
  return {
    desc: def?.desc || `Grant authorization for ${f.label.toLowerCase()}`,
    category: def?.category || "General Capabilities",
  };
}

const CAT_ICONS: Record<string, string> = {
  "Surveillance & Feeds": "📹",
  "Forensics & Intelligence": "🔍",
  "Access & Governance": "🛡️",
  "System & Platform": "⚙️",
};

const CCTV_PERMS = [
  { id: "live", label: "Live", cls: "perm-view", desc: "Watch live surveillance camera streams" },
  { id: "playback", label: "Playback", cls: "perm-download", desc: "Search and play back recorded archives" },
  { id: "ptz", label: "PTZ", cls: "perm-upload", desc: "Camera pan, tilt and zoom control" },
  { id: "export", label: "Export", cls: "perm-share", desc: "Export tamper-evident video clips" },
  { id: "search", label: "Search", cls: "perm-folder", desc: "Forensic timeline event search" },
  { id: "alerts", label: "Alerts", cls: "perm-alerts", desc: "Real-time dispatch alert notifications" },
  { id: "admin", label: "Admin", cls: "perm-delete", desc: "System administration & settings" },
];

function getRoleTitle(r: Role): string {
  if (r.name === "admin") return "Root Administrator";
  if (r.name === "operator") return "Control Room Operator";
  if (r.name === "viewer") return "Surveillance Viewer";
  if (r.name === "supervisor") return "Operations Supervisor";
  if (r.name === "guard") return "Security Guard";
  return r.description || r.name;
}

export default function Roles() {
  const { refresh } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [feats, setFeats] = useState<Feat[]>([]);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);

  // View modes: "table" (matching user design), "matrix" (grid), or "profile" (single role)
  const [viewMode, setViewMode] = useState<"table" | "matrix" | "profile">("table");
  const [showAllPerms, setShowAllPerms] = useState(false);
  const [selectedRoleName, setSelectedRoleName] = useState<string>("");

  // Search & Category Filters
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  // Create Role Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api("/api/roles");
      const roleList: Role[] = Array.isArray(r?.roles) ? r.roles : [];
      const featList: Feat[] = Array.isArray(r?.features) ? r.features : [];
      setRoles(roleList);
      setFeats(featList);
      setDraft(Object.fromEntries(roleList.map((x: Role) => [x.name, new Set(x.features || [])])));
      if (!selectedRoleName && roleList.length) {
        setSelectedRoleName(roleList[0].name);
      }
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, [selectedRoleName]);

  useEffect(() => {
    load();
  }, [load]);

  // Determine if a specific role has unsaved changes
  const isRoleDirty = useCallback(
    (r: Role) => {
      const d = draft[r.name];
      if (!d) return false;
      const a = [...d].sort().join(",");
      const b = [...(r.features || [])].sort().join(",");
      return a !== b;
    },
    [draft]
  );

  const dirtyRoles = useMemo(() => roles.filter((r) => isRoleDirty(r)), [roles, isRoleDirty]);
  const totalUsers = useMemo(() => roles.reduce((acc, r) => acc + (r.users || 0), 0), [roles]);

  // Selected role object for profile mode
  const currentRole = useMemo(
    () => roles.find((r) => r.name === selectedRoleName) || roles[0] || null,
    [roles, selectedRoleName]
  );

  // Group features by category
  const categorizedFeats = useMemo(() => {
    const map = new Map<string, Feat[]>();
    feats.forEach((f) => {
      const cat = getFeatInfo(f).category;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(f);
    });
    return map;
  }, [feats]);

  const categories = useMemo(() => Array.from(categorizedFeats.keys()).sort(), [categorizedFeats]);

  // Filtered features
  const filteredFeats = useMemo(() => {
    let list = feats;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((f) => {
        const info = getFeatInfo(f);
        return (
          f.label.toLowerCase().includes(q) ||
          f.id.toLowerCase().includes(q) ||
          info.desc.toLowerCase().includes(q)
        );
      });
    }
    if (categoryFilter) {
      list = list.filter((f) => getFeatInfo(f).category === categoryFilter);
    }
    return list;
  }, [feats, search, categoryFilter]);

  // Filtered roles for policy table
  const filteredRoles = useMemo(() => {
    if (!search.trim()) return roles;
    const q = search.trim().toLowerCase();
    return roles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description && r.description.toLowerCase().includes(q)) ||
        getRoleTitle(r).toLowerCase().includes(q)
    );
  }, [roles, search]);

  const tick = (roleName: string, f: string, on: boolean) =>
    setDraft((d) => {
      const n = new Set(d[roleName] || []);
      on ? n.add(f) : n.delete(f);
      if (f === "registry_edit" && on) n.add("registry");
      return { ...d, [roleName]: n };
    });

  const setCategoryForRole = (roleName: string, catName: string, enable: boolean) => {
    const catFeats = categorizedFeats.get(catName) || [];
    setDraft((d) => {
      const n = new Set(d[roleName] || []);
      catFeats.forEach((f) => {
        enable ? n.add(f.id) : n.delete(f.id);
      });
      return { ...d, [roleName]: n };
    });
  };

  const setAllForRole = (roleName: string, enableAll: boolean) => {
    setDraft((d) => {
      const n = new Set<string>();
      if (enableAll) {
        feats.forEach((f) => n.add(f.id));
      } else {
        // Keep essential 'live'
        n.add("live");
      }
      return { ...d, [roleName]: n };
    });
  };

  const discardRole = (r: Role) => {
    setDraft((d) => ({
      ...d,
      [r.name]: new Set(r.features || []),
    }));
  };

  const discardAll = () => {
    setDraft(Object.fromEntries(roles.map((x: Role) => [x.name, new Set(x.features || [])])));
    toast("All unsaved role edits discarded", "ok");
  };

  const saveRole = async (r: Role) => {
    const features = [...(draft[r.name] || [])];
    try {
      await api(`/api/roles/${encodeURIComponent(r.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ features }),
      });
      toast(`Role "${r.name}" saved · ${features.length} capabilities active`, "ok");
      load();
      refresh();
    } catch (e: any) {
      toast(e.message || "Save failed", "err");
    }
  };

  const saveAll = async () => {
    if (!dirtyRoles.length) return;
    setSavingAll(true);
    try {
      await Promise.all(
        dirtyRoles.map((r) =>
          api(`/api/roles/${encodeURIComponent(r.name)}`, {
            method: "PATCH",
            body: JSON.stringify({ features: [...(draft[r.name] || [])] }),
          })
        )
      );
      toast(`Saved modifications across ${dirtyRoles.length} role${dirtyRoles.length === 1 ? "" : "s"}`, "ok");
      load();
      refresh();
    } catch (e: any) {
      toast(e.message || "Failed to save all roles", "err");
    } finally {
      setSavingAll(false);
    }
  };

  const removeRole = async (r: Role) => {
    if (!confirm(`Permanently remove custom role "${r.name}"?`)) return;
    try {
      await api(`/api/roles/${encodeURIComponent(r.name)}`, { method: "DELETE" });
      toast(`Role "${r.name}" removed`, "ok");
      if (selectedRoleName === r.name) {
        setSelectedRoleName(roles[0]?.name || "");
      }
      load();
    } catch (e: any) {
      toast(e.message || "Removal failed", "err");
    }
  };

  const createRole = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(cleanName)) {
      return toast("Role name: lowercase letters, digits, _ or -, 2–32 characters", "warn");
    }

    setCreating(true);
    let initialFeatures = ["live"];
    if (cloneFrom) {
      const source = roles.find((r) => r.name === cloneFrom);
      if (source?.features) {
        initialFeatures = [...source.features];
      }
    }

    try {
      await api("/api/roles", {
        method: "POST",
        body: JSON.stringify({ name: cleanName, description: desc.trim(), features: initialFeatures }),
      });
      toast(`Role "${cleanName}" created · initialized with ${initialFeatures.length} permissions`, "ok");
      setName("");
      setDesc("");
      setCloneFrom("");
      setCreateOpen(false);
      setSelectedRoleName(cleanName);
      load();
    } catch (err: any) {
      toast(err.message || "Failed to create role", "err");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="roles-console-root">
      {/* Sober Mini Dashboard KPI Grid */}
      <div className="perm-kpis-grid">
        {/* Total Roles */}
        <div className="perm-kpi-card" title="Total active roles configured in the access matrix">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Configured Roles</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{roles.length}</span>
              <span className="kpi-sub-pill sober-pill">
                {roles.filter((r) => r.builtin).length} builtin · {roles.filter((r) => !r.builtin).length} custom
              </span>
            </div>
            <span className="kpi-desc">Global security boundary tiers</span>
          </div>
        </div>

        {/* Governed Users */}
        <div className="perm-kpi-card" title="Total users mapped to these roles">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Governed Users</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{totalUsers}</span>
              <span className="kpi-sub-pill sober-pill">Mapped accounts</span>
            </div>
            <span className="kpi-desc">Inheriting role capability profiles</span>
          </div>
        </div>

        {/* System Capabilities */}
        <div className="perm-kpi-card" title="Total granular permission switches available">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Capabilities</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{feats.length}</span>
              <span className="kpi-sub-pill sober-pill">{categories.length} categories</span>
            </div>
            <span className="kpi-desc">Video, forensic &amp; admin controls</span>
          </div>
        </div>

        {/* Pending Edits / Sync Status */}
        <div className="perm-kpi-card" title="Unsaved modifications status">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Matrix Status</span>
              {dirtyRoles.length > 0 && (
                <button
                  type="button"
                  className="kpi-action-link"
                  onClick={saveAll}
                  disabled={savingAll}
                  title="Save all role modifications"
                >
                  {savingAll ? "Saving…" : "Save All"}
                </button>
              )}
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{dirtyRoles.length}</span>
              <span className={`kpi-sub-pill ${dirtyRoles.length > 0 ? "warn-pill" : "sober-pill"}`}>
                {dirtyRoles.length > 0 ? "Unsaved edits" : "Synchronized ✓"}
              </span>
            </div>
            <span className="kpi-desc">
              {dirtyRoles.length > 0
                ? `${dirtyRoles.map((r) => r.name).join(", ")} modified`
                : "Database matches active sessions"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Console Panel Card */}
      <div className="roles-panel-card">
        {/* Header Toolbar */}
        <div className="roles-toolbar">
          <div className="roles-title-group">
            <div className="roles-title-row">
              <h3 className="roles-panel-title">Role Capabilities Matrix</h3>
              <span className="roles-count-tag">{roles.length} Roles Configured</span>
            </div>
            <p className="roles-panel-desc">
              Configure fine-grained video wall, forensic search, user management and system permissions.
            </p>
          </div>

          <div className="perm-actions-group">
            {/* View Mode Segmented Switch (Policy Table vs Matrix Comparison vs Role Profiles) */}
            <div className="perm-segmented-switch">
              <button
                type="button"
                className={`seg-tab-btn ${viewMode === "table" ? "active" : ""}`}
                onClick={() => setViewMode("table")}
                title="Policy Table layout"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="3" />
                  <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="3" />
                  <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="3" />
                </svg>
                <span>Policy Table</span>
              </button>

              <button
                type="button"
                className={`seg-tab-btn ${viewMode === "matrix" ? "active" : ""}`}
                onClick={() => setViewMode("matrix")}
                title="View full side-by-side matrix comparison"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
                <span>Matrix Comparison</span>
              </button>

              <button
                type="button"
                className={`seg-tab-btn ${viewMode === "profile" ? "active" : ""}`}
                onClick={() => setViewMode("profile")}
                title="View detailed single-role inspector"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>Role Inspector</span>
              </button>
            </div>

            <button
              type="button"
              className="btn ghost icon small refresh-btn"
              onClick={load}
              title="Refresh role matrix"
              disabled={loading}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? "spin" : ""}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>

            {dirtyRoles.length > 0 && (
              <button
                type="button"
                className="btn ghost small"
                onClick={discardAll}
                title="Discard all pending role modifications"
              >
                Discard All
              </button>
            )}

            {dirtyRoles.length > 0 && (
              <button
                type="button"
                className="btn primary perm-grant-btn"
                onClick={saveAll}
                disabled={savingAll}
                title="Commit all unsaved role modifications"
              >
                <span>Save All ({dirtyRoles.length})</span>
              </button>
            )}

            <button
              type="button"
              className="btn primary perm-grant-btn"
              onClick={() => setCreateOpen(true)}
              title="Add a custom role"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Create Role</span>
            </button>
          </div>
        </div>

        {/* Filter Strip */}
        <div className="perm-filter-strip">
          {/* Search Permissions */}
          <div className="perm-search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search roles, assignees or capabilities…"
              className="search-input"
            />
            {search && (
              <button type="button" className="clear-btn" onClick={() => setSearch("")} title="Clear search">
                ×
              </button>
            )}
          </div>

          {/* Results Count */}
          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>
              {filteredRoles.length} of {roles.length} {roles.length === 1 ? "role" : "roles"}
            </span>
          </div>
        </div>

        {err && <div className="inline-err-banner">{err}</div>}

        {/* VIEW MODE 1: POLICY TABLE (CLEAN ENTERPRISE DESIGN) */}
        {viewMode === "table" && (
          <div className="acl-table-card">
            <div className="acl-table-scroll">
              <table className="acl-table">
                <thead>
                  <tr>
                    <th style={{ width: "12%" }}>ROLE</th>
                    <th style={{ width: "24%" }}>DESCRIPTION / SCOPE</th>
                    <th style={{ width: "12%" }}>TIER</th>
                    <th style={{ width: "36%" }}>CAPABILITIES</th>
                    <th style={{ width: "10%" }}>ASSIGNED</th>
                    <th style={{ width: "6%", textAlign: "right" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoles.map((r) => {
                    const isDirty = isRoleDirty(r);

                    return (
                      <tr key={r.name} className={isDirty ? "dirty-row" : ""}>
                        {/* ROLE */}
                        <td>
                          <span className="acl-bucket-pill">{r.name}</span>
                        </td>

                        {/* DESCRIPTION / SCOPE */}
                        <td>
                          <div className="acl-grantee-cell">
                            {r.builtin ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#9333ea" strokeWidth="2" className="acl-grantee-ico">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" className="acl-grantee-ico">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                              </svg>
                            )}
                            <div>
                              <div style={{ fontWeight: 600, color: "var(--text)" }}>{getRoleTitle(r)}</div>
                              {r.description && r.description !== getRoleTitle(r) && (
                                <div style={{ fontSize: 11, color: "#64748b" }}>{r.description}</div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* TIER */}
                        <td>
                          <span className={`acl-type-pill ${r.builtin ? "acl-type-role" : "acl-type-employee"}`}>
                            {r.builtin ? "Built-in" : "Custom"}
                          </span>
                        </td>

                        {/* CAPABILITIES */}
                        <td>
                          <div className="acl-perms-strip">
                            {CCTV_PERMS.map((p) => {
                              const isGranted = draft[r.name]?.has(p.id) || false;
                              const isDisabled = r.name === "admin" && p.id === "admin";

                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  disabled={isDisabled}
                                  onClick={() => tick(r.name, p.id, !isGranted)}
                                  className={`acl-perm-badge ${p.cls} ${isGranted ? "active" : "inactive"}`}
                                  title={
                                    isDisabled
                                      ? "Admin core capability cannot be disabled"
                                      : `${isGranted ? "Revoke" : "Grant"} ${p.label} · ${p.desc}`
                                  }
                                >
                                  {p.label}
                                </button>
                              );
                            })}
                          </div>
                        </td>

                        {/* ASSIGNED */}
                        <td>
                          <span className="acl-expires-text">
                            {r.users} {r.users === 1 ? "user" : "users"}
                          </span>
                        </td>

                        {/* ACTIONS */}
                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                            {isDirty && (
                              <button
                                type="button"
                                className="btn small primary"
                                style={{ padding: "2px 7px", fontSize: 10.5 }}
                                onClick={() => saveRole(r)}
                                title="Save changes for this role"
                              >
                                Save *
                              </button>
                            )}
                            <button
                              type="button"
                              className="acl-action-trash"
                              onClick={() => removeRole(r)}
                              disabled={r.builtin || r.users > 0}
                              title={
                                r.builtin
                                  ? "Builtin role cannot be deleted"
                                  : r.users > 0
                                  ? `${r.users} assigned users`
                                  : `Delete role ${r.name}`
                              }
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 16, height: 16 }}>
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!filteredRoles.length && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", padding: "32px 16px" }}>
                        <span style={{ color: "#64748b", fontSize: 13 }}>No roles match your search filter</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* VIEW MODE 2: MATRIX COMPARISON GRID */}
        {viewMode === "matrix" && (
          <div className="roles-matrix-scroll-wrap">
            <table className="roles-matrix-table" id="roles-table">
              <thead>
                <tr>
                  {/* Fixed Top-Left Header Cell */}
                  <th className="perm-header-col matrix-sticky-col matrix-corner-th" style={{ padding: "14px 16px" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Capabilities</span>
                      <span style={{ fontSize: 11, fontWeight: 500, color: "#64748b" }}>
                        {feats.length} system permissions
                      </span>
                    </div>
                  </th>

                  {/* Role Column Header Cards */}
                  {roles.map((r) => {
                    const isDirty = isRoleDirty(r);
                    const activeCount = draft[r.name]?.size || 0;
                    const percent = Math.round((activeCount / (feats.length || 1)) * 100);
                    return (
                      <th key={r.name} className={`clean-matrix-th ${isDirty ? "dirty-col" : ""}`}>
                        <div className="matrix-role-card-compact">
                          <div className="matrix-role-top">
                            <span className="matrix-role-name" title={r.name}>{r.name}</span>
                            {r.builtin ? (
                              <span className="role-builtin-tag">builtin</span>
                            ) : (
                              <span className="role-custom-tag">custom</span>
                            )}
                          </div>

                          <div className="matrix-role-meta-sub">
                            <span>{activeCount}/{feats.length} active</span>
                            <span>{percent}%</span>
                          </div>

                          <div className="role-meter-box" style={{ margin: "2px 0 4px" }} title={`${percent}% capabilities active`}>
                            <div className="role-meter-fill" style={{ width: `${percent}%` }} />
                          </div>

                          <div className="matrix-role-toggles">
                            <button
                              type="button"
                              className="role-text-btn"
                              onClick={() => setAllForRole(r.name, true)}
                              title={`Grant all permissions to ${r.name}`}
                            >
                              All
                            </button>
                            <span style={{ color: "#cbd5e1" }}>·</span>
                            <button
                              type="button"
                              className="role-text-btn"
                              onClick={() => setAllForRole(r.name, false)}
                              title={`Clear permissions for ${r.name}`}
                            >
                              None
                            </button>
                            {isDirty && (
                              <>
                                <span style={{ color: "#cbd5e1" }}>·</span>
                                <button
                                  type="button"
                                  className="role-text-btn"
                                  style={{ color: "#2563eb", fontWeight: 700 }}
                                  onClick={() => saveRole(r)}
                                  title="Save edits for this role"
                                >
                                  Save*
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {/* Categorized Matrix Rows */}
                {categories.map((cat) => {
                  const catFeats = (categorizedFeats.get(cat) || []).filter((f) =>
                    filteredFeats.some((ff) => ff.id === f.id)
                  );
                  if (!catFeats.length) return null;

                  return (
                    <Fragment key={cat}>
                      {/* Category Section Header Row */}
                      <tr className="matrix-cat-divider-row">
                        <td colSpan={roles.length + 1} className="matrix-cat-cell">
                          <div className="matrix-cat-header-content">
                            <span className="matrix-cat-title">
                              {CAT_ICONS[cat] || "📁"} {cat}
                            </span>
                            <span className="matrix-cat-count">{catFeats.length} permissions</span>
                          </div>
                        </td>
                      </tr>

                      {/* Individual Feature Rows within Category */}
                      {catFeats.map((f) => {
                        const info = getFeatInfo(f);
                        return (
                          <tr key={f.id} className="matrix-row">
                            {/* Sticky Left Feature Column */}
                            <td className="matrix-feat-cell matrix-sticky-col">
                              <div className="matrix-feat-info">
                                <span className="feat-title">{f.label}</span>
                                <span className="feat-desc-text">{info.desc}</span>
                                <div className="feat-meta-row">
                                  <span className="feat-id">{f.id}</span>
                                </div>
                              </div>
                            </td>

                            {/* Role Permission Cells with Crisp Switch Buttons */}
                            {roles.map((r) => {
                              const isChecked = draft[r.name]?.has(f.id) || false;
                              const isDisabled = r.name === "admin" && f.id === "admin";
                              return (
                                <td key={r.name} className="matrix-check-cell">
                                  <button
                                    type="button"
                                    disabled={isDisabled}
                                    onClick={() => tick(r.name, f.id, !isChecked)}
                                    className={`matrix-switch-btn ${isChecked ? "active" : "inactive"} ${isDisabled ? "locked" : ""}`}
                                    title={
                                      isDisabled
                                        ? "Admin core capability is permanently locked"
                                        : `${isChecked ? "Revoke" : "Grant"} ${f.label} for ${r.name}`
                                    }
                                  >
                                    {isDisabled ? (
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="matrix-switch-ico">
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                      </svg>
                                    ) : isChecked ? (
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="matrix-switch-ico">
                                        <polyline points="20 6 9 17 4 12" />
                                      </svg>
                                    ) : (
                                      <span style={{ fontSize: 13, fontWeight: 600 }}>—</span>
                                    )}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}

                {/* Empty State */}
                {!filteredFeats.length && (
                  <tr>
                    <td colSpan={roles.length + 1}>
                      <div className="perm-empty-state" style={{ padding: "36px 16px" }}>
                        <h4>No matching capabilities found</h4>
                        <p>No permissions match your search or category filter.</p>
                        {search && (
                          <button
                            type="button"
                            className="btn ghost small clear-filters-btn"
                            onClick={() => setSearch("")}
                          >
                            Clear Filter
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Floating Action Bar for Unsaved Changes across any view */}
        {dirtyRoles.length > 0 && (
          <div className="matrix-floating-bar">
            <div className="floating-bar-info">
              <span className="floating-dot-pulse" />
              <span>
                <strong>{dirtyRoles.length} role{dirtyRoles.length === 1 ? "" : "s"}</strong> modified (
                {dirtyRoles.map((r) => r.name).join(", ")})
              </span>
            </div>
            <div className="floating-bar-actions">
              <button
                type="button"
                className="btn ghost small"
                style={{ color: "#e2e8f0" }}
                onClick={discardAll}
              >
                Discard All
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={saveAll}
                disabled={savingAll}
              >
                {savingAll ? "Saving…" : `Save All Changes (${dirtyRoles.length})`}
              </button>
            </div>
          </div>
        )}

        {/* VIEW MODE 2: ROLE PROFILES INSPECTOR */}
        {viewMode === "profile" && currentRole && (
          <div className="role-profile-layout">
            {/* Left Column: Role Selector Cards */}
            <div className="role-profile-sidebar">
              <div className="role-profile-nav-header">
                <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>Access Tiers</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>{roles.length} roles</span>
              </div>

              <div className="role-profile-list">
                {roles.map((r) => {
                  const isSelected = r.name === currentRole.name;
                  const isDirty = isRoleDirty(r);
                  const activeCount = draft[r.name]?.size || 0;
                  const percent = Math.round((activeCount / (feats.length || 1)) * 100);

                  return (
                    <div
                      key={r.name}
                      onClick={() => setSelectedRoleName(r.name)}
                      className={`role-nav-card ${isSelected ? "selected" : ""}`}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="role-nav-card-head">
                        <span className="role-nav-name">{r.name}</span>
                        {!r.builtin ? (
                          <span className="role-custom-tag">custom</span>
                        ) : (
                          <span className="role-builtin-tag">builtin</span>
                        )}
                      </div>

                      <div className="role-nav-meta">
                        <span>{r.users} assigned users</span>
                        <span>{activeCount}/{feats.length} perms</span>
                      </div>

                      <div className="role-meter-box" style={{ marginTop: 4 }}>
                        <div className="role-meter-fill" style={{ width: `${percent}%` }} />
                      </div>

                      {isDirty && <span className="role-dirty-indicator">Unsaved edits *</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Detailed Capability Inspector for Current Role */}
            <div className="role-profile-detail">
              {/* Profile Card Header */}
              <div className="role-profile-header-card">
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--text)" }}>
                      Role: {currentRole.name}
                    </h3>
                    {!currentRole.builtin ? (
                      <span className="role-custom-tag">custom tier</span>
                    ) : (
                      <span className="role-builtin-tag">builtin system role</span>
                    )}
                    {isRoleDirty(currentRole) && (
                      <span className="sober-tag" style={{ background: "#fefce8", color: "#78350f" }}>
                        Unsaved edits pending
                      </span>
                    )}
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#64748b" }}>
                    {currentRole.description || "System configured security authorization tier"}
                  </p>
                </div>

                <div className="role-profile-btn-group">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setAllForRole(currentRole.name, true)}
                    title="Enable all permissions"
                  >
                    Grant All
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setAllForRole(currentRole.name, false)}
                    title="Disable all permissions"
                  >
                    Revoke All
                  </button>
                  {isRoleDirty(currentRole) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => discardRole(currentRole)}
                      title="Discard pending changes"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn primary perm-grant-btn"
                    disabled={!isRoleDirty(currentRole)}
                    onClick={() => saveRole(currentRole)}
                    title="Save changes for this role"
                  >
                    {isRoleDirty(currentRole) ? "Save Changes *" : "Saved"}
                  </button>
                </div>
              </div>

              {/* Categorized Permission Switches in Profile Mode */}
              <div className="role-profile-categories">
                {categories.map((cat) => {
                  const catFeats = (categorizedFeats.get(cat) || []).filter((f) =>
                    filteredFeats.some((ff) => ff.id === f.id)
                  );
                  if (!catFeats.length) return null;

                  return (
                    <div key={cat} className="role-profile-cat-block">
                      <div className="role-profile-cat-header">
                        <div>
                          <h4 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
                            {cat}
                          </h4>
                          <span style={{ fontSize: 11, color: "#64748b" }}>
                            {catFeats.length} capability {catFeats.length === 1 ? "switch" : "switches"}
                          </span>
                        </div>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            className="role-text-btn"
                            onClick={() => setCategoryForRole(currentRole.name, cat, true)}
                          >
                            Enable All
                          </button>
                          <span style={{ color: "#cbd5e1" }}>·</span>
                          <button
                            type="button"
                            className="role-text-btn"
                            onClick={() => setCategoryForRole(currentRole.name, cat, false)}
                          >
                            Disable All
                          </button>
                        </div>
                      </div>

                      <div className="role-profile-switches-grid">
                        {catFeats.map((f) => {
                          const isChecked = draft[currentRole.name]?.has(f.id) || false;
                          const isDisabled = currentRole.name === "admin" && f.id === "admin";
                          const info = getFeatInfo(f);

                          return (
                            <div
                              key={f.id}
                              className={`role-switch-card ${isChecked ? "active-switch" : ""}`}
                              onClick={() => !isDisabled && tick(currentRole.name, f.id, !isChecked)}
                            >
                              <div className="role-switch-meta">
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span className="role-switch-title">{f.label}</span>
                                  <span className="feat-id">{f.id}</span>
                                </div>
                                <span className="role-switch-desc">{info.desc}</span>
                              </div>

                              <button
                                type="button"
                                disabled={isDisabled}
                                className={`matrix-toggle-pill ${isChecked ? "active" : "inactive"}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  !isDisabled && tick(currentRole.name, f.id, !isChecked);
                                }}
                              >
                                {isChecked ? (
                                  <span className="pill-check-inner">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="matrix-check-svg">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    <span className="matrix-pill-label">Enabled</span>
                                  </span>
                                ) : (
                                  <span className="pill-dash-inner">
                                    <span className="matrix-dash-char">Off</span>
                                  </span>
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom Custom Role Deletion */}
              {!currentRole.builtin && (
                <div className="role-danger-zone">
                  <div>
                    <h5 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                      Delete Role: {currentRole.name}
                    </h5>
                    <span style={{ fontSize: 11.5, color: "#64748b" }}>
                      {currentRole.users > 0
                        ? `Cannot delete role while ${currentRole.users} accounts remain mapped to it.`
                        : "Permanently decommissions this authorization tier."}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn ghost small danger"
                    disabled={currentRole.users > 0}
                    onClick={() => removeRole(currentRole)}
                  >
                    Delete Role
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* CREATE CUSTOM ROLE MODAL */}
      {createOpen && (
        <Modal open onClose={() => setCreateOpen(false)}>
          <div className="perm-modal-head" style={{ marginBottom: 12 }}>
            <div className="modal-title-box">
              <div className="kpi-icon-box sober-icon-box" style={{ width: 38, height: 38 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </div>
              <div>
                <h3 style={{ fontSize: 16, margin: 0, color: "var(--text)" }}>Create Custom Role</h3>
                <span style={{ fontSize: 12, color: "#64748b" }}>
                  Define a tailored capability role that can be mapped to local or directory users
                </span>
              </div>
            </div>
          </div>

          <form onSubmit={createRole} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
                  Role Identifier *
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  placeholder="e.g. gate_security"
                  autoComplete="off"
                  className="modal-input"
                  style={{ margin: 0 }}
                />
                <span style={{ fontSize: 10.5, color: "#64748b", marginTop: 3, display: "block" }}>
                  Lowercase letters, numbers, underscores (2–32 chars)
                </span>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
                  Clone Permissions From (Optional)
                </label>
                <select
                  value={cloneFrom}
                  onChange={(e) => setCloneFrom(e.target.value)}
                  className="perm-select"
                  style={{ width: "100%", height: 36, margin: 0 }}
                >
                  <option value="">Start with Basic Video (live)</option>
                  {roles.map((r) => (
                    <option key={r.name} value={r.name}>
                      Copy: {r.name} ({r.features?.length || 0} capabilities)
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: 10.5, color: "#64748b", marginTop: 3, display: "block" }}>
                  Pre-fills capability matrix from an existing role
                </span>
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#334155", display: "block", marginBottom: 4 }}>
                Role Purpose / Description
              </label>
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="e.g. Operators monitoring gate checkpoint cameras and plate logs"
                className="modal-input"
                style={{ margin: 0 }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </button>
              <button type="submit" className="btn primary perm-grant-btn" disabled={creating}>
                {creating ? "Creating…" : "Create Role"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
