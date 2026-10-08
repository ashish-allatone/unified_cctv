import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtTime, ago } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  features: string[];
  departments: string[];
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used: string | null;
  revoked: boolean;
}

export interface NewKeyResult extends ApiKeyItem {
  key: string;
  note: string;
}

export interface CapabilityGroup {
  category: string;
  icon: string;
  items: { id: string; label: string; desc: string }[];
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    category: "Surveillance & Telemetry",
    icon: "camera",
    items: [
      { id: "live", label: "Live Streams & Video Wall", desc: "Access real-time video stream ingestion and mosaic wall" },
      { id: "sources", label: "Sources & Stream Telemetry", desc: "Read camera feeds, online status and FPS bitrate metrics" },
    ],
  },
  {
    category: "Forensics & Playback",
    icon: "film",
    items: [
      { id: "search", label: "Event Search & Timeline", desc: "Query event occurrences, triggers and time-slice markers" },
      { id: "playback", label: "Historical Clip Playback", desc: "Fetch recorded stream segments and historical playback buffer" },
      { id: "export", label: "Evidence & Bundle Export", desc: "Generate signed cryptographic MP4 clips and evidentiary files" },
    ],
  },
  {
    category: "AI Analytics & Intelligence",
    icon: "cpu",
    items: [
      { id: "plate_search", label: "Automatic Number Plate (ANPR)", desc: "Full optical license plate recognition queries and reads" },
      { id: "movement", label: "Vehicle Movement Analysis", desc: "Vehicle trajectory vectors, entry/exit logs and transit paths" },
      { id: "tags", label: "Metadata & Event Tags", desc: "Search and apply semantic classification tags on events" },
      { id: "watchlist", label: "Hotlist & Watchlist Records", desc: "Query watchlist entries and suspect vehicle flags" },
    ],
  },
  {
    category: "Operations & Incident Command",
    icon: "shield",
    items: [
      { id: "alerts_ack", label: "Acknowledge Alerts", desc: "Remotely acknowledge, silence, or triage real-time alerts" },
      { id: "cases", label: "Investigation Dossiers", desc: "Read and link evidence into active investigation cases" },
      { id: "reports", label: "Operational & Health Reports", desc: "Generate automated daily summaries and metric digests" },
      { id: "audit", label: "System Audit Trail", desc: "Inspect tamper-proof hash-chained operational audit records" },
    ],
  },
  {
    category: "Camera Hardware & Device Catalog",
    icon: "hard-drive",
    items: [
      { id: "registry", label: "Camera Hardware Registry (Read)", desc: "Query camera hardware inventory and location coordinates" },
      { id: "registry_edit", label: "Hardware Catalog Management (Edit)", desc: "Create, update, onboard or edit device RTSP specifications" },
    ],
  },
];

const ALL_CAPABILITIES = CAPABILITY_GROUPS.flatMap((g) => g.items);

export default function ApiKeysAdmin() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [departments, setDepartments] = useState<string[]>([]);
  const [err, setErr] = useState("");

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked" | "expired">("all");
  const [deptFilter, setDeptFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [showDocs, setShowDocs] = useState(false);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createdKeyResult, setCreatedKeyResult] = useState<NewKeyResult | null>(null);
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyItem | null>(null);
  const [usageKeyModal, setUsageKeyModal] = useState<ApiKeyItem | null>(null);

  // Form State for Key Creation
  const [formName, setFormName] = useState("");
  const [formDays, setFormDays] = useState<number>(365);
  const [customDays, setCustomDays] = useState<number>(30);
  const [formDeptMode, setFormDeptMode] = useState<"all" | "custom">("all");
  const [formDepts, setFormDepts] = useState<string[]>([]);
  const [formFeatures, setFormFeatures] = useState<string[]>(["search", "playback"]);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Load API Keys
  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const [data, opts] = await Promise.all([
        api<ApiKeyItem[]>("/api/admin/api-keys"),
        api<{ departments: string[] }>("/api/permissions/options").catch(() => ({ departments: [] })),
      ]);
      setKeys(data || []);
      if (opts?.departments?.length) {
        setDepartments(opts.departments);
      }
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Failed to load API keys");
      toast(e.message || "Failed to load API keys", "err");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  // Derived KPIs
  const now = useMemo(() => new Date(), []);
  const kpis = useMemo(() => {
    let active = 0;
    let revokedOrExpired = 0;
    let recentlyUsed = 0;
    const uniqueFeatures = new Set<string>();

    const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;

    keys.forEach((k) => {
      const isExpired = k.expires_at ? new Date(k.expires_at) < now : false;
      const isActive = !k.revoked && !isExpired;
      if (isActive) {
        active++;
        (k.features || []).forEach((f) => uniqueFeatures.add(f));
      } else {
        revokedOrExpired++;
      }

      if (k.last_used) {
        const lastTime = new Date(k.last_used).getTime();
        if (lastTime >= sevenDaysAgo) {
          recentlyUsed++;
        }
      }
    });

    return {
      active,
      revokedOrExpired,
      recentlyUsed,
      uniqueFeaturesCount: uniqueFeatures.size,
    };
  }, [keys, now]);

  // Filtered Rows
  const filteredKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    return keys.filter((k) => {
      // Search text
      if (q) {
        const matchesName = k.name.toLowerCase().includes(q);
        const matchesPrefix = k.prefix.toLowerCase().includes(q);
        const matchesCreator = k.created_by.toLowerCase().includes(q);
        if (!matchesName && !matchesPrefix && !matchesCreator) return false;
      }

      // Status
      const isExpired = k.expires_at ? new Date(k.expires_at) < now : false;
      if (statusFilter === "active") {
        if (k.revoked || isExpired) return false;
      } else if (statusFilter === "revoked") {
        if (!k.revoked) return false;
      } else if (statusFilter === "expired") {
        if (!isExpired || k.revoked) return false;
      }

      // Department
      if (deptFilter !== "all") {
        if (!k.departments.includes("*") && !k.departments.includes(deptFilter)) {
          return false;
        }
      }

      // Scope
      if (scopeFilter !== "all") {
        if (!k.features.includes(scopeFilter)) {
          return false;
        }
      }

      return true;
    });
  }, [keys, search, statusFilter, deptFilter, scopeFilter, now]);

  // Handle Form Feature Toggles
  const toggleFeature = (fid: string) => {
    setFormFeatures((prev) =>
      prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid]
    );
  };

  const applyFeaturePreset = (preset: "standard" | "ingest" | "analytics" | "all" | "clear") => {
    if (preset === "clear") {
      setFormFeatures([]);
    } else if (preset === "all") {
      setFormFeatures(ALL_CAPABILITIES.map((c) => c.id));
    } else if (preset === "standard") {
      setFormFeatures(["search", "playback", "live", "sources"]);
    } else if (preset === "ingest") {
      setFormFeatures(["registry", "registry_edit", "sources"]);
    } else if (preset === "analytics") {
      setFormFeatures(["plate_search", "movement", "tags", "watchlist", "search"]);
    }
  };

  // Submit Key Generation
  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast("Please provide an application or key name", "warn");
      return;
    }
    if (formFeatures.length === 0) {
      toast("Select at least one capability scope for this machine key", "warn");
      return;
    }

    const depts = formDeptMode === "all" ? ["*"] : formDepts.length > 0 ? formDepts : ["*"];
    const effectiveDays = formDays === -1 ? customDays : formDays;

    setCreating(true);
    try {
      const res = await api<NewKeyResult>("/api/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: formName.trim(),
          features: formFeatures,
          departments: depts,
          days: effectiveDays,
        }),
      });

      setCreatedKeyResult(res);
      setShowCreateModal(false);
      // Reset form
      setFormName("");
      setFormDays(365);
      setFormDeptMode("all");
      setFormDepts([]);
      setFormFeatures(["search", "playback"]);
      toast("API Key generated successfully", "ok");
      loadKeys();
    } catch (e: any) {
      toast(e.message || "Failed to generate API key", "err");
    } finally {
      setCreating(false);
    }
  };

  // Handle Key Revocation
  const handleRevoke = async () => {
    if (!keyToRevoke) return;
    setRevoking(true);
    try {
      await api(`/api/admin/api-keys/${keyToRevoke.id}`, { method: "DELETE" });
      toast(`Revoked API key "${keyToRevoke.name}"`, "ok");
      setKeyToRevoke(null);
      loadKeys();
    } catch (e: any) {
      toast(e.message || "Failed to revoke API key", "err");
    } finally {
      setRevoking(false);
    }
  };

  // Copy to Clipboard Helpers
  const copyText = (text: string, type: "key" | "curl") => {
    navigator.clipboard.writeText(text);
    if (type === "key") {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2200);
    } else {
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2200);
    }
    toast("Copied to clipboard", "ok");
  };

  return (
    <div className="perm-console-root">
      {/* Top Header & Quick Actions */}
      <div className="perm-header-row">
        <div>
          <h2 className="perm-page-title">API Keys & Machine Authentication</h2>
          <p className="perm-page-desc">
            Issue, configure, and monitor cryptographic API tokens for automated microservices, edge devices, and external integrations.
          </p>
        </div>
        <div className="perm-actions-group">
          <button
            type="button"
            className="btn ghost small"
            onClick={loadKeys}
            disabled={loading}
            title="Refresh API keys"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh
          </button>
          <button
            type="button"
            className={`btn small ${showDocs ? "primary" : "outline"}`}
            onClick={() => setShowDocs(!showDocs)}
            title="Toggle Developer Integration Guide"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            {showDocs ? "Hide Guide" : "Integration Guide"}
          </button>
          <button
            type="button"
            className="btn primary small"
            onClick={() => setShowCreateModal(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Issue API Key
          </button>
        </div>
      </div>

      {err && (
        <div className="perm-alert-banner" role="alert" style={{ background: "rgba(239, 68, 68, 0.08)", borderColor: "rgba(239, 68, 68, 0.25)", color: "#ef4444", padding: "10px 14px", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 16, maxHeight: 16, flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{err}</span>
        </div>
      )}

      {/* KPI Stats Strip */}
      {/* KPI Stats Strip */}
      <div className="perm-kpis-grid">
        <div
          className={`perm-kpi-card perm-kpi-interactive ${statusFilter === "active" ? "active-kpi-filter" : ""}`}
          onClick={() => setStatusFilter(statusFilter === "active" ? "all" : "active")}
          role="button"
          tabIndex={0}
          title="Click to toggle filter: Active API keys"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Active API Keys</span>
              {statusFilter === "active" && <span className="kpi-action-link">Active</span>}
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis.active}</span>
              <span className="kpi-sub-pill sober-pill">Authorized</span>
            </div>
            <span className="kpi-desc">Machine callers with live access</span>
          </div>
        </div>

        <div
          className={`perm-kpi-card perm-kpi-interactive ${statusFilter === "revoked" ? "active-kpi-filter" : ""}`}
          onClick={() => setStatusFilter(statusFilter === "revoked" ? "all" : "revoked")}
          role="button"
          tabIndex={0}
          title="Click to toggle filter: Revoked or expired keys"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Revoked / Expired</span>
              {statusFilter === "revoked" && <span className="kpi-action-link">Filtered</span>}
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis.revokedOrExpired}</span>
              <span className={`kpi-sub-pill ${kpis.revokedOrExpired > 0 ? "warn-pill" : "sober-pill"}`}>Terminated</span>
            </div>
            <span className="kpi-desc">Decommissioned access tokens</span>
          </div>
        </div>

        <div
          className="perm-kpi-card"
          title="Programmatic tokens used in the last 7 days"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Active Machine Callers</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis.recentlyUsed}</span>
              <span className="kpi-sub-pill sober-pill">7-day Traffic</span>
            </div>
            <span className="kpi-desc">Active clients sending requests</span>
          </div>
        </div>

        <div
          className="perm-kpi-card"
          title="Unique feature capabilities delegated across active keys"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Delegated Scopes</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis.uniqueFeaturesCount}</span>
              <span className="kpi-sub-pill sober-pill">Capabilities</span>
            </div>
            <span className="kpi-desc">Granular features delegated</span>
          </div>
        </div>
      </div>

      {/* Main Table Panel */}
      <div className="perm-panel-card">
        {/* Filter Strip & Search Bar */}
        <div className="perm-toolbar">
          <div className="perm-filter-strip">
            <div className="perm-search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by key name, prefix or creator..."
                aria-label="Filter API keys"
                className="search-input"
              />
              {search && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={() => setSearch("")}
                  title="Clear search"
                >
                  ×
                </button>
              )}
            </div>

            {/* Status Filter */}
            <div className="perm-select-wrap">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                aria-label="Status filter"
              >
                <option value="all">All Statuses ({keys.length})</option>
                <option value="active">Active Only ({kpis.active})</option>
                <option value="revoked">Revoked Only</option>
                <option value="expired">Expired Only</option>
              </select>
            </div>

            {/* Department Scope Filter */}
            <div className="perm-select-wrap">
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                aria-label="Department filter"
              >
                <option value="all">All Department Scopes</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    Department: {d}
                  </option>
                ))}
              </select>
            </div>

            {/* Capability Scope Filter */}
            <div className="perm-select-wrap">
              <select
                value={scopeFilter}
                onChange={(e) => setScopeFilter(e.target.value)}
                aria-label="Capability scope filter"
              >
                <option value="all">All Capability Scopes</option>
                {ALL_CAPABILITIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    Capability: {c.label} ({c.id})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
            Showing <strong>{filteredKeys.length}</strong> of {keys.length} tokens
          </div>
        </div>

        {/* API Keys Table */}
        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "24%" }}>Key Name & Prefix</th>
                <th style={{ width: "11%" }}>Status</th>
                <th style={{ width: "22%" }}>Authorized Capabilities</th>
                <th style={{ width: "12%" }}>Department Scope</th>
                <th style={{ width: "11%" }}>Last Used</th>
                <th style={{ width: "10%" }}>Expires</th>
                <th style={{ width: "10%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && keys.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                    <div style={{ display: "inline-block", marginBottom: 8 }}>
                      <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 20, maxHeight: 20 }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    </div>
                    <div>Loading API keys...</div>
                  </td>
                </tr>
              ) : filteredKeys.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "48px 16px", color: "var(--muted)" }}>
                    <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.6 }}>🔑</div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>No API keys match criteria</div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      {search || statusFilter !== "all" || deptFilter !== "all" || scopeFilter !== "all"
                        ? "Try clearing filters or search query"
                        : "No programmatic machine tokens have been issued yet."}
                    </div>
                    {(search || statusFilter !== "all" || deptFilter !== "all" || scopeFilter !== "all") && (
                      <button
                        type="button"
                        className="btn outline small"
                        style={{ marginTop: 12 }}
                        onClick={() => {
                          setSearch("");
                          setStatusFilter("all");
                          setDeptFilter("all");
                          setScopeFilter("all");
                        }}
                      >
                        Reset All Filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredKeys.map((k) => {
                  const isExpired = k.expires_at ? new Date(k.expires_at) < now : false;
                  const isActive = !k.revoked && !isExpired;

                  return (
                    <tr key={k.id} className={!isActive ? "muted-row" : ""}>
                      {/* Name & Prefix */}
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
                              {k.name}
                            </span>
                            <span
                              className="tagchip"
                              style={{
                                fontFamily: "monospace",
                                fontSize: 11,
                                padding: "1px 6px",
                                background: "var(--bg2)",
                                borderColor: "var(--line)",
                              }}
                              title="Key prefix"
                            >
                              {k.prefix}...
                            </span>
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                            Created by <strong>{k.created_by || "admin"}</strong> · {fmtTime(k.created_at)}
                          </div>
                        </div>
                      </td>

                      {/* Status */}
                      <td>
                        {k.revoked ? (
                          <span className="bad-chip" style={{ fontSize: 11.5, fontWeight: 600 }}>
                            Revoked
                          </span>
                        ) : isExpired ? (
                          <span className="warn-chip" style={{ fontSize: 11.5, fontWeight: 600 }}>
                            Expired
                          </span>
                        ) : (
                          <span className="ok-chip" style={{ fontSize: 11.5, fontWeight: 600 }}>
                            Active
                          </span>
                        )}
                      </td>

                      {/* Capabilities */}
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {(k.features || []).slice(0, 3).map((f) => (
                            <span
                              key={f}
                              className="tagchip"
                              style={{ fontSize: 11, padding: "2px 6px" }}
                              title={`Feature: ${f}`}
                            >
                              {f}
                            </span>
                          ))}
                          {(k.features || []).length > 3 && (
                            <span
                              className="tagchip"
                              style={{ fontSize: 11, padding: "2px 6px", background: "var(--panel2)" }}
                              title={(k.features || []).join(", ")}
                            >
                              +{(k.features || []).length - 3} more
                            </span>
                          )}
                          {(!k.features || k.features.length === 0) && (
                            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>No scopes</span>
                          )}
                        </div>
                      </td>

                      {/* Department Boundary */}
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {k.departments.includes("*") ? (
                            <span
                              className="tagchip"
                              style={{
                                fontSize: 11,
                                padding: "2px 6px",
                                background: "rgba(59, 130, 246, 0.08)",
                                borderColor: "rgba(59, 130, 246, 0.25)",
                                color: "#3b82f6",
                                fontWeight: 600,
                              }}
                            >
                              All (* wildcard)
                            </span>
                          ) : (
                            k.departments.map((d) => (
                              <span key={d} className="tagchip" style={{ fontSize: 11, padding: "2px 6px" }}>
                                {d}
                              </span>
                            ))
                          )}
                        </div>
                      </td>

                      {/* Last Used */}
                      <td>
                        <div style={{ fontSize: 12, color: k.last_used ? "var(--text)" : "var(--muted)" }}>
                          {k.last_used ? ago(k.last_used) : "Never used"}
                        </div>
                        {k.last_used && (
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                            {fmtTime(k.last_used)}
                          </div>
                        )}
                      </td>

                      {/* Expiration */}
                      <td>
                        <div style={{ fontSize: 12, color: "var(--text)" }}>
                          {k.expires_at ? (
                            <span style={{ color: isExpired ? "#ef4444" : "inherit" }}>
                              {isExpired ? "Expired" : ago(k.expires_at)}
                            </span>
                          ) : (
                            <span style={{ color: "var(--muted)" }}>Never</span>
                          )}
                        </div>
                        {k.expires_at && !isExpired && (
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                            {fmtTime(k.expires_at)}
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => setUsageKeyModal(k)}
                            title="Show code integration snippet"
                            style={{ padding: "4px 8px", fontSize: 11.5 }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 13, maxHeight: 13, marginRight: 4 }}>
                              <polyline points="16 18 22 12 16 6" />
                              <polyline points="8 6 2 12 8 18" />
                            </svg>
                            Usage
                          </button>

                          {!k.revoked && (
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={() => setKeyToRevoke(k)}
                              title="Revoke programmatic access"
                              style={{ padding: "4px 8px", fontSize: 11.5, color: "#ef4444" }}
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Developer Integration Quickstart Guide (Collapsible below table) */}
      {showDocs && (
        <div
          className="perm-panel-card"
          style={{
            marginTop: 18,
            padding: "20px 24px",
            border: "1px solid rgba(59, 130, 246, 0.25)",
            background: "var(--panel)",
            borderRadius: "var(--radius)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="kpi-icon-box sober-icon-box" style={{ width: 36, height: 36, borderRadius: 8 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 16, maxHeight: 16 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Developer Integration Quickstart</h3>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Machine-to-machine authentication parameters & code examples</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a
                href="/docs"
                target="_blank"
                rel="noreferrer"
                className="btn ghost small"
                style={{ fontSize: 12, textDecoration: "none" }}
              >
                Interactive OpenAPI /docs ↗
              </a>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setShowDocs(false)}
                title="Close guide"
              >
                ✕ Close
              </button>
            </div>
          </div>
          <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            All platform REST APIs can be invoked directly by machines using an issued token. Pass the token either via the HTTP header <code style={{ padding: "3px 6px", background: "var(--bg2)", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>X-API-Key</code> or as a standard <code style={{ padding: "3px 6px", background: "var(--bg2)", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>Authorization: Bearer</code> header.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <div style={{ background: "var(--bg2)", padding: "14px 16px", borderRadius: 8, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>1. Direct cURL Invocation</div>
              <pre style={{ margin: 0, padding: "10px 12px", background: "var(--panel)", borderRadius: 6, border: "1px solid var(--line)", fontSize: 12, fontFamily: "monospace", overflowX: "auto", color: "var(--text)", whiteSpace: "pre-wrap" }}>
{`curl -X GET "${window.location.origin}/api/events" \\
  -H "X-API-Key: uvp_your_secret_key" \\
  -H "Accept: application/json"`}
              </pre>
            </div>

            <div style={{ background: "var(--bg2)", padding: "14px 16px", borderRadius: 8, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>2. Python Requests Invocation</div>
              <pre style={{ margin: 0, padding: "10px 12px", background: "var(--panel)", borderRadius: 6, border: "1px solid var(--line)", fontSize: 12, fontFamily: "monospace", overflowX: "auto", color: "var(--text)", whiteSpace: "pre-wrap" }}>
{`import requests

res = requests.get(
    "${window.location.origin}/api/registry",
    headers={"X-API-Key": "uvp_your_secret_key"}
)
cameras = res.json()`}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL: Issue New API Key
          ========================================================================= */}
      <Modal
        open={showCreateModal}
        onClose={() => { if (!creating) setShowCreateModal(false); }}
        wide
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Issue Machine API Token</h3>
          <form onSubmit={handleCreateKey} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.45 }}>
              Generate a cryptographic machine token for automated services or camera ingestion. API keys authenticate machine-to-machine traffic without session cookies.
            </p>

            {/* Key / Client Name */}
            <div>
              <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>
                Client Application or Service Name <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Traffic ANPR Ingest Pipeline, Command Center Gateway"
                required
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  background: "var(--bg2)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
            </div>

            {/* Expiration Preset */}
            <div>
              <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, marginBottom: 6, color: "var(--text)" }}>
                Token Expiration Lifecycle
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {[
                  { label: "30 Days", days: 30 },
                  { label: "90 Days", days: 90 },
                  { label: "180 Days", days: 180 },
                  { label: "1 Year (Recommended)", days: 365 },
                  { label: "Custom Days", days: -1 },
                  { label: "Never Expire", days: 0 },
                ].map((item) => (
                  <button
                    key={item.days}
                    type="button"
                    onClick={() => setFormDays(item.days)}
                    className={`btn small ${formDays === item.days ? "primary" : "outline"}`}
                    style={{ fontSize: 12 }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {formDays === -1 && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="number"
                    min="1"
                    max="1825"
                    value={customDays}
                    onChange={(e) => setCustomDays(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{
                      width: 120,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      background: "var(--bg2)",
                      color: "var(--text)",
                      fontSize: 13,
                    }}
                  />
                  <span style={{ fontSize: 12.5, color: "var(--muted)" }}>days from today</span>
                </div>
              )}
            </div>

            {/* Department Boundary Scope */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                  Departmental Access Scope
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setFormDeptMode("all");
                      setFormDepts([]);
                    }}
                    className={`btn small ${formDeptMode === "all" ? "primary" : "outline"}`}
                    style={{ padding: "2px 8px", fontSize: 11.5 }}
                  >
                    All Departments (*)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFormDeptMode("custom");
                      if (formDepts.length === 0 && departments.length > 0) {
                        setFormDepts([departments[0]]);
                      }
                    }}
                    className={`btn small ${formDeptMode === "custom" ? "primary" : "outline"}`}
                    style={{ padding: "2px 8px", fontSize: 11.5 }}
                  >
                    Specific Boundary
                  </button>
                </div>
              </div>

              {formDeptMode === "custom" ? (
                <div style={{ background: "var(--bg2)", padding: 10, borderRadius: 6, border: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 110, overflowY: "auto" }}>
                  {departments.length > 0 ? (
                    departments.map((d) => (
                      <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", background: "var(--panel)", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--line)" }}>
                        <input
                          type="checkbox"
                          checked={formDepts.includes(d)}
                          onChange={() => {
                            setFormDepts((prev) =>
                              prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
                            );
                          }}
                        />
                        <span>{d}</span>
                      </label>
                    ))
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>No specific departments found. Will default to wildcard (*).</span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--muted)", padding: "6px 8px", background: "var(--bg2)", borderRadius: 6, border: "1px solid var(--line)" }}>
                  Key will be permitted across all cameras and department feeds regardless of tenant boundary.
                </div>
              )}
            </div>

            {/* Feature Capabilities Selection */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                  Capability Scopes ({formFeatures.length} selected) <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => applyFeaturePreset("standard")}
                    className="btn ghost small"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                  >
                    Forensics
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFeaturePreset("analytics")}
                    className="btn ghost small"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                  >
                    ANPR / AI
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFeaturePreset("ingest")}
                    className="btn ghost small"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                  >
                    Device Ingest
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFeaturePreset("all")}
                    className="btn ghost small"
                    style={{ padding: "2px 6px", fontSize: 11 }}
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => applyFeaturePreset("clear")}
                    className="btn ghost small"
                    style={{ padding: "2px 6px", fontSize: 11, color: "#ef4444" }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 260, overflowY: "auto", paddingRight: 4 }}>
                {CAPABILITY_GROUPS.map((group) => (
                  <div key={group.category} style={{ background: "var(--bg2)", borderRadius: 6, padding: "8px 10px", border: "1px solid var(--line)" }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 6 }}>
                      {group.category}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                      {group.items.map((feat) => {
                        const isChecked = formFeatures.includes(feat.id);
                        return (
                          <label
                            key={feat.id}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 8,
                              padding: "6px 8px",
                              borderRadius: 4,
                              background: isChecked ? "var(--panel)" : "transparent",
                              border: `1px solid ${isChecked ? "var(--line2)" : "transparent"}`,
                              cursor: "pointer",
                              transition: "background 0.12s ease",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleFeature(feat.id)}
                              style={{ marginTop: 2 }}
                            />
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                                {feat.label}
                              </span>
                              <span style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.25 }}>
                                {feat.desc}
                              </span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Modal Actions */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <button
                type="button"
                className="btn outline"
                onClick={() => setShowCreateModal(false)}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={creating}
              >
                {creating ? "Generating Token..." : "Issue API Key"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* =========================================================================
          MODAL: Key Created Successfully (Show Secret Once)
          ========================================================================= */}
      <Modal
        open={!!createdKeyResult}
        onClose={() => setCreatedKeyResult(null)}
        wide
      >
        {createdKeyResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>API Key Issued Successfully</h3>
            {/* Warning Banner */}
            <div
              style={{
                background: "rgba(245, 158, 11, 0.12)",
                border: "1px solid rgba(245, 158, 11, 0.35)",
                color: "#d97706",
                padding: "12px 14px",
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.45,
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 18, maxHeight: 18, flexShrink: 0, marginTop: 2 }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>
                <strong>Please copy and record this API key now.</strong>
                <div style={{ marginTop: 2 }}>
                  For security reasons, this token is stored exclusively as a cryptographic SHA-256 hash. You will never be able to view the full plaintext key again.
                </div>
              </div>
            </div>

            {/* Secret Key Display Box */}
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase" }}>
                Secret API Token ({createdKeyResult.name})
              </label>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "var(--bg2)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  gap: 8,
                }}
              >
                <code
                  style={{
                    flex: 1,
                    fontFamily: "monospace",
                    fontSize: 13.5,
                    color: "var(--text)",
                    wordBreak: "break-all",
                    userSelect: "all",
                  }}
                >
                  {createdKeyResult.key}
                </code>
                <button
                  type="button"
                  onClick={() => copyText(createdKeyResult.key, "key")}
                  className={`btn small ${copiedKey ? "primary" : "outline"}`}
                  style={{ flexShrink: 0 }}
                >
                  {copiedKey ? "✓ Copied" : "Copy Key"}
                </button>
              </div>
            </div>

            {/* Ready-to-use cURL Snippet */}
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase" }}>
                Ready-to-use cURL invocation
              </label>
              <div
                style={{
                  position: "relative",
                  background: "var(--bg2)",
                  padding: "10px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                }}
              >
                <pre
                  style={{
                    margin: 0,
                    fontSize: 12,
                    fontFamily: "monospace",
                    overflowX: "auto",
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                  }}
                >
{`curl -X GET "${window.location.origin}/api/events" \\
  -H "X-API-Key: ${createdKeyResult.key}"`}
                </pre>
                <button
                  type="button"
                  onClick={() =>
                    copyText(
                      `curl -X GET "${window.location.origin}/api/events" -H "X-API-Key: ${createdKeyResult.key}"`,
                      "curl"
                    )
                  }
                  className="btn ghost small"
                  style={{ position: "absolute", top: 6, right: 6, fontSize: 11, padding: "2px 8px" }}
                >
                  {copiedCurl ? "✓ Copied" : "Copy cURL"}
                </button>
              </div>
            </div>

            {/* Key Summary */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12, background: "var(--panel)", padding: 10, borderRadius: 6, border: "1px solid var(--line)" }}>
              <div>
                <span style={{ color: "var(--muted)" }}>Departments: </span>
                <strong>{createdKeyResult.departments.join(", ") || "*"}</strong>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Expires: </span>
                <strong>{createdKeyResult.expires_at ? fmtTime(createdKeyResult.expires_at) : "Never"}</strong>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span style={{ color: "var(--muted)" }}>Scopes: </span>
                <strong>{createdKeyResult.features.join(", ")}</strong>
              </div>
            </div>

            {/* Close */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => setCreatedKeyResult(null)}
              >
                I have securely saved this key
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* =========================================================================
          MODAL: Revoke API Key Confirmation
          ========================================================================= */}
      <Modal
        open={!!keyToRevoke}
        onClose={() => { if (!revoking) setKeyToRevoke(null); }}
      >
        {keyToRevoke && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Revoke API Key</h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.45 }}>
              Are you sure you want to revoke the machine API key{" "}
              <strong>"{keyToRevoke.name}"</strong> (prefix{" "}
              <code style={{ fontFamily: "monospace", padding: "1px 4px", background: "var(--bg2)", borderRadius: 4 }}>
                {keyToRevoke.prefix}...
              </code>
              )?
            </p>

            <div
              style={{
                background: "rgba(239, 68, 68, 0.08)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                color: "#ef4444",
                padding: "10px 12px",
                borderRadius: 6,
                fontSize: 12.5,
                lineHeight: 1.4,
              }}
            >
              ⚠️ <strong>Immediate Effect:</strong> Any edge software, daemon workers, or third-party web services using this key will immediately receive HTTP 401 Unauthorized responses. This action cannot be undone.
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
              <button
                type="button"
                className="btn outline"
                onClick={() => setKeyToRevoke(null)}
                disabled={revoking}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={handleRevoke}
                disabled={revoking}
                style={{ background: "#ef4444", borderColor: "#ef4444" }}
              >
                {revoking ? "Revoking..." : "Confirm Revocation"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* =========================================================================
          MODAL: Key Usage & Details Snippets
          ========================================================================= */}
      <Modal
        open={!!usageKeyModal}
        onClose={() => setUsageKeyModal(null)}
        wide
      >
        {usageKeyModal && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Integration Guide · {usageKeyModal.name}
            </h3>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg2)", padding: "10px 14px", borderRadius: 6, border: "1px solid var(--line)" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{usageKeyModal.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                  Prefix: <code style={{ fontFamily: "monospace" }}>{usageKeyModal.prefix}...</code> · Created {fmtTime(usageKeyModal.created_at)}
                </div>
              </div>
              <div>
                {usageKeyModal.revoked ? (
                  <span className="bad-chip">Revoked</span>
                ) : (
                  <span className="ok-chip">Active</span>
                )}
              </div>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase" }}>
                HTTP Request Header (cURL)
              </label>
              <pre style={{ margin: 0, padding: 12, background: "var(--bg2)", borderRadius: 6, border: "1px solid var(--line)", fontSize: 12, fontFamily: "monospace", overflowX: "auto", color: "var(--text)", whiteSpace: "pre-wrap" }}>
{`# Authenticate with X-API-Key header
curl -X GET "${window.location.origin}/api/events" \\
  -H "X-API-Key: ${usageKeyModal.prefix}<YOUR_SECRET_KEY_SUFFIX>"

# Or authenticate using standard Bearer Token
curl -X GET "${window.location.origin}/api/registry" \\
  -H "Authorization: Bearer ${usageKeyModal.prefix}<YOUR_SECRET_KEY_SUFFIX>"`}
              </pre>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase" }}>
                Granted Capability Scopes
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(usageKeyModal.features || []).map((f) => (
                  <span key={f} className="tagchip" style={{ fontSize: 12, padding: "3px 8px" }}>
                    {f}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn primary small"
                onClick={() => setUsageKeyModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
