import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { fmtTime, ago, toIso } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface AuditItem {
  id: number | string;
  ts: string;
  user: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  hash: string;
  prev_hash: string;
}

export interface AuditFacets {
  actions: { action: string; count: number }[];
  users: { user: string; count: number }[];
  total: number;
  first_ts: string | null;
}

export interface AuditVerifyResult {
  ok: boolean;
  rows: number;
  first_bad_id?: number | null;
}

// Action category mapping with visual tags and descriptions
const ACTION_META: Record<string, { label: string; cat: string; color: string }> = {
  login: { label: "User Login", cat: "Auth", color: "rgba(59, 130, 246, 0.12)" },
  login_fail: { label: "Failed Login", cat: "Auth", color: "rgba(239, 68, 68, 0.12)" },
  logout: { label: "User Logout", cat: "Auth", color: "rgba(100, 116, 139, 0.12)" },
  break_glass: { label: "Break-Glass Active", cat: "Emergency", color: "rgba(220, 38, 38, 0.2)" },
  break_glass_end: { label: "Break-Glass Terminated", cat: "Emergency", color: "rgba(234, 88, 12, 0.15)" },
  api_key_create: { label: "API Key Created", cat: "API", color: "rgba(16, 185, 129, 0.15)" },
  api_key_revoke: { label: "API Key Revoked", cat: "API", color: "rgba(239, 68, 68, 0.15)" },
  user_create: { label: "User Created", cat: "Access", color: "rgba(139, 92, 246, 0.15)" },
  user_update: { label: "User Modified", cat: "Access", color: "rgba(139, 92, 246, 0.12)" },
  user_delete: { label: "User Removed", cat: "Access", color: "rgba(239, 68, 68, 0.15)" },
  role_create: { label: "Role Created", cat: "Access", color: "rgba(147, 51, 234, 0.15)" },
  role_update: { label: "Role Modified", cat: "Access", color: "rgba(147, 51, 234, 0.12)" },
  permission_grant: { label: "Permission Granted", cat: "Access", color: "rgba(79, 70, 229, 0.15)" },
  permission_revoke: { label: "Permission Revoked", cat: "Access", color: "rgba(239, 68, 68, 0.15)" },
  camera_create: { label: "Camera Added", cat: "Device", color: "rgba(14, 165, 233, 0.15)" },
  camera_update: { label: "Camera Modified", cat: "Device", color: "rgba(14, 165, 233, 0.12)" },
  camera_delete: { label: "Camera Removed", cat: "Device", color: "rgba(239, 68, 68, 0.15)" },
  audit_verify: { label: "Chain Verified", cat: "Integrity", color: "rgba(16, 185, 129, 0.15)" },
  audit_export: { label: "Audit Exported", cat: "Export", color: "rgba(100, 116, 139, 0.15)" },
  export: { label: "Video Clip Export", cat: "Export", color: "rgba(6, 182, 212, 0.15)" },
  playback: { label: "Historical Playback", cat: "Media", color: "rgba(59, 130, 246, 0.12)" },
};

function getActionMeta(action: string) {
  if (ACTION_META[action]) return ACTION_META[action];
  if (action.startsWith("break_glass")) return { label: action, cat: "Emergency", color: "rgba(220, 38, 38, 0.18)" };
  if (action.includes("create")) return { label: action, cat: "Create", color: "rgba(16, 185, 129, 0.12)" };
  if (action.includes("delete") || action.includes("revoke")) return { label: action, cat: "Delete", color: "rgba(239, 68, 68, 0.12)" };
  if (action.includes("export")) return { label: action, cat: "Export", color: "rgba(6, 182, 212, 0.12)" };
  return { label: action, cat: "Event", color: "rgba(100, 116, 139, 0.1)" };
}

export default function AuditLog() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [facets, setFacets] = useState<AuditFacets>({ actions: [], users: [], total: 0, first_ts: null });

  // Filters & Sorting
  const [q, setQ] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [fromTs, setFromTs] = useState("");
  const [toTs, setToTs] = useState("");
  const [sort, setSort] = useState("ts");
  const [order, setOrder] = useState<"desc" | "asc">("desc");

  // Chain Verification State
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResult | null>(null);
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  // Inspector Modal
  const [inspectedItem, setInspectedItem] = useState<AuditItem | null>(null);

  // Load Facets (Users & Actions list with counts)
  const loadFacets = useCallback(async () => {
    try {
      const data = await api<AuditFacets>("/api/audit/facets");
      setFacets(data);
    } catch {
      // Graceful fallback
    }
  }, []);

  // Load Audit Records
  const loadAudit = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort,
      order,
    });
    if (q.trim()) qs.set("q", q.trim());
    if (userFilter) qs.set("user", userFilter);
    if (actionFilter) qs.set("action", actionFilter);
    if (fromTs) qs.set("from", toIso(fromTs));
    if (toTs) qs.set("to", toIso(toTs));

    try {
      const r = await api<{
        items: AuditItem[];
        total: number;
        page: number;
        pages: number;
      }>(`/api/audit?${qs}`);
      setItems(r.items || []);
      setTotal(r.total || 0);
      setPages(r.pages || 1);
    } catch (e: any) {
      toast(e.message || "Failed to load audit trail", "err");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sort, order, q, userFilter, actionFilter, fromTs, toTs]);

  useEffect(() => {
    loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    const t = setTimeout(loadAudit, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadAudit, q]);

  // Handle Verify Cryptographic Hash Chain
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await api<AuditVerifyResult>("/api/audit/verify");
      setVerifyResult(res);
      setShowVerifyModal(true);
      if (res.ok) {
        toast(`Hash chain intact: ${res.rows} records verified`, "ok");
      } else {
        toast(`Hash chain broken at record #${res.first_bad_id}`, "err");
      }
    } catch (e: any) {
      toast(e.message || "Chain verification failed", "err");
    } finally {
      setVerifying(false);
    }
  };

  // Handle CSV Export
  const handleExportCsv = () => {
    const qs = new URLSearchParams({ sort, order });
    if (q.trim()) qs.set("q", q.trim());
    if (userFilter) qs.set("user", userFilter);
    if (actionFilter) qs.set("action", actionFilter);
    if (fromTs) qs.set("from", toIso(fromTs));
    if (toTs) qs.set("to", toIso(toTs));

    const exportUrl = `/api/audit/export.csv?${qs}`;
    window.open(exportUrl, "_blank");
    toast("Audit log export started (audited)", "ok");
  };

  // Toggle Column Sort
  const toggleSort = (col: string) => {
    if (sort === col) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(col);
      setOrder("desc");
    }
    setPage(1);
  };

  // Check if any filter is applied
  const hasActiveFilters = Boolean(q || userFilter || actionFilter || fromTs || toTs);

  const resetFilters = () => {
    setQ("");
    setUserFilter("");
    setActionFilter("");
    setFromTs("");
    setToTs("");
    setPage(1);
  };

  // KPI calculations
  const breakGlassCount = useMemo(() => {
    const bgAction = facets.actions.find((a) => a.action.startsWith("break_glass"));
    return bgAction ? bgAction.count : 0;
  }, [facets.actions]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Tamper-Evident Audit Trail</h2>
              <p className="perm-page-desc">
                Cryptographically chained SHA-256 historical ledger of all logins, policy modifications, emergency overrides, and export activities.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => { loadAudit(); loadFacets(); }}
                disabled={loading}
                title="Refresh audit records"
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
                className="btn outline small"
                onClick={handleExportCsv}
                title="Download CSV export with cryptographic header"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export CSV
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={handleVerify}
                disabled={verifying}
                title="Verify cryptographic SHA-256 hash continuity"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 11 14 15 10" />
                </svg>
                {verifying ? "Verifying Chain..." : "Verify Hash Chain"}
              </button>
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Total Audit Records */}
            <div className="perm-kpi-card" title="Total chronological immutable event entries">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Ledger Entries</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{facets.total ? facets.total.toLocaleString("en-IN") : total.toLocaleString("en-IN")}</span>
                  <span className="kpi-sub-pill sober-pill">Immutable</span>
                </div>
                <span className="kpi-desc">Cryptographically recorded</span>
              </div>
            </div>

            {/* Cryptographic Chain Integrity */}
            <div
              className={`perm-kpi-card perm-kpi-interactive ${verifyResult?.ok ? "accent-glow" : ""}`}
              onClick={handleVerify}
              role="button"
              tabIndex={0}
              title="Click to run live SHA-256 chain verification"
            >
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: verifyResult?.ok ? "rgba(16, 185, 129, 0.12)" : verifyResult ? "rgba(239, 68, 68, 0.12)" : undefined,
                  color: verifyResult?.ok ? "#10b981" : verifyResult ? "#ef4444" : undefined,
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  {verifyResult?.ok && <polyline points="9 12 11 14 15 10" />}
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Chain Integrity</span>
                  <span className="kpi-action-link">Verify</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{verifyResult ? (verifyResult.ok ? "Intact" : "Broken") : "SHA-256"}</span>
                  <span className={`kpi-sub-pill ${verifyResult?.ok ? "sober-pill" : verifyResult ? "warn-pill" : "sober-pill"}`}>
                    {verifyResult ? `${verifyResult.rows} verified` : "CERT-In 180d"}
                  </span>
                </div>
                <span className="kpi-desc">
                  {verifyResult?.ok ? "No tampering detected" : "Tamper-evident link test"}
                </span>
              </div>
            </div>

            {/* Distinct Operators */}
            <div
              className={`perm-kpi-card perm-kpi-interactive ${userFilter ? "active-kpi-filter" : ""}`}
              onClick={() => { if (userFilter) { setUserFilter(""); setPage(1); } }}
              role="button"
              tabIndex={0}
              title={userFilter ? "Click to clear user filter" : "Active operators in audit trail"}
            >
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Active Operators</span>
                  {userFilter && <span className="kpi-action-link">Filtered</span>}
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{facets.users.length}</span>
                  <span className="kpi-sub-pill sober-pill">Identities</span>
                </div>
                <span className="kpi-desc">Distinct operators logged</span>
              </div>
            </div>

            {/* High Impact / Break Glass */}
            <div
              className={`perm-kpi-card perm-kpi-interactive ${actionFilter === "break_glass" ? "active-kpi-filter" : ""}`}
              onClick={() => {
                setActionFilter(actionFilter === "break_glass" ? "" : "break_glass");
                setPage(1);
              }}
              role="button"
              tabIndex={0}
              title="Click to toggle filter: Break-glass emergencies"
            >
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: breakGlassCount > 0 ? "rgba(245, 158, 11, 0.12)" : undefined,
                  color: breakGlassCount > 0 ? "#f59e0b" : undefined,
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Emergency Access</span>
                  {actionFilter === "break_glass" && <span className="kpi-action-link">Filtered</span>}
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{breakGlassCount}</span>
                  <span className={`kpi-sub-pill ${breakGlassCount > 0 ? "warn-pill" : "sober-pill"}`}>
                    {breakGlassCount > 0 ? "Elevated" : "Normal"}
                  </span>
                </div>
                <span className="kpi-desc">Break-glass emergency audits</span>
              </div>
            </div>
          </div>

          {/* Main Table Panel */}
          <div className="perm-panel-card">
            {/* Filter Toolbar */}
            <div className="perm-toolbar">
              <div className="perm-filter-strip">
                {/* Search Box */}
                <div className="perm-search-box">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setPage(1); }}
                    placeholder="Search by operator, action, target, IP or details…"
                    aria-label="Filter audit events"
                    className="search-input"
                  />
                  {q && (
                    <button
                      type="button"
                      className="clear-btn"
                      onClick={() => { setQ(""); setPage(1); }}
                      title="Clear search"
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* Operator / User Select */}
                <div className="perm-select-wrap">
                  <select
                    value={userFilter}
                    onChange={(e) => { setUserFilter(e.target.value); setPage(1); }}
                    aria-label="Filter by user"
                  >
                    <option value="">All Operators ({facets.users.length})</option>
                    {facets.users.map((u) => (
                      <option key={u.user} value={u.user}>
                        {u.user} ({u.count})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Action Type Select */}
                <div className="perm-select-wrap">
                  <select
                    value={actionFilter}
                    onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
                    aria-label="Filter by action"
                  >
                    <option value="">All Action Types ({facets.actions.length})</option>
                    {facets.actions.map((a) => (
                      <option key={a.action} value={a.action}>
                        {a.action} ({a.count})
                      </option>
                    ))}
                  </select>
                </div>

                {/* From Datetime */}
                <div className="perm-select-wrap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>From:</span>
                  <input
                    type="datetime-local"
                    value={fromTs}
                    onChange={(e) => { setFromTs(e.target.value); setPage(1); }}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      background: "var(--panel2)",
                      color: "var(--text)",
                      fontSize: 12,
                    }}
                  />
                </div>

                {/* To Datetime */}
                <div className="perm-select-wrap" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>To:</span>
                  <input
                    type="datetime-local"
                    value={toTs}
                    onChange={(e) => { setToTs(e.target.value); setPage(1); }}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      background: "var(--panel2)",
                      color: "var(--text)",
                      fontSize: 12,
                    }}
                  />
                </div>

                {hasActiveFilters && (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={resetFilters}
                    style={{ fontSize: 11.5, padding: "5px 10px" }}
                  >
                    Reset Filters
                  </button>
                )}
              </div>

              <div style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
                Total <strong>{total.toLocaleString("en-IN")}</strong> records
              </div>
            </div>

            {/* Audit Log Table */}
            <div className="perm-table-container">
              <table className="perm-table sober-perm-table">
                <thead>
                  <tr>
                    <th
                      style={{ width: "17%", cursor: "pointer" }}
                      onClick={() => toggleSort("ts")}
                      title="Sort by timestamp"
                    >
                      Time (IST) {sort === "ts" ? (order === "asc" ? "▲" : "▼") : ""}
                    </th>
                    <th
                      style={{ width: "13%", cursor: "pointer" }}
                      onClick={() => toggleSort("user")}
                      title="Sort by user"
                    >
                      Operator {sort === "user" ? (order === "asc" ? "▲" : "▼") : ""}
                    </th>
                    <th
                      style={{ width: "16%", cursor: "pointer" }}
                      onClick={() => toggleSort("action")}
                      title="Sort by action"
                    >
                      Action {sort === "action" ? (order === "asc" ? "▲" : "▼") : ""}
                    </th>
                    <th
                      style={{ width: "16%", cursor: "pointer" }}
                      onClick={() => toggleSort("target")}
                      title="Sort by target"
                    >
                      Target {sort === "target" ? (order === "asc" ? "▲" : "▼") : ""}
                    </th>
                    <th style={{ width: "23%" }}>Detail & Justification</th>
                    <th
                      style={{ width: "15%", cursor: "pointer", textAlign: "right" }}
                      onClick={() => toggleSort("ip")}
                      title="Sort by IP address"
                    >
                      IP / Hash {sort === "ip" ? (order === "asc" ? "▲" : "▼") : ""}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loading && items.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", padding: "48px 16px", color: "var(--muted)" }}>
                        <div style={{ display: "inline-block", marginBottom: 8 }}>
                          <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 20, maxHeight: 20 }}>
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                        </div>
                        <div>Loading audit trail records...</div>
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: "center", padding: "48px 16px", color: "var(--muted)" }}>
                        <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.6 }}>🛡️</div>
                        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>No audit records found</div>
                        <div style={{ fontSize: 12.5, marginTop: 4 }}>
                          {hasActiveFilters
                            ? "Try adjusting search terms, dates, or clearing selected filters."
                            : "No system events have been recorded yet."}
                        </div>
                        {hasActiveFilters && (
                          <button
                            type="button"
                            className="btn outline small"
                            style={{ marginTop: 12 }}
                            onClick={resetFilters}
                          >
                            Reset All Filters
                          </button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => {
                      const meta = getActionMeta(item.action);
                      const isBreakGlass = item.action.startsWith("break_glass");

                      return (
                        <tr
                          key={item.id}
                          style={{
                            background: isBreakGlass ? "rgba(239, 68, 68, 0.04)" : undefined,
                            cursor: "pointer",
                          }}
                          onClick={() => setInspectedItem(item)}
                          title="Click row to inspect cryptographic proof & full details"
                        >
                          {/* Timestamp */}
                          <td>
                            <div style={{ display: "flex", flexDirection: "column" }}>
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                                {fmtTime(item.ts)}
                              </span>
                              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                {ago(item.ts)}
                              </span>
                            </div>
                          </td>

                          {/* Operator */}
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                              <div
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: "50%",
                                  background: "var(--bg2)",
                                  border: "1px solid var(--line)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: "var(--text)",
                                  flexShrink: 0,
                                }}
                              >
                                {item.user ? item.user.slice(0, 1).toUpperCase() : "?"}
                              </div>
                              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                                {item.user || "system"}
                              </span>
                            </div>
                          </td>

                          {/* Action */}
                          <td>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span
                                className="tagchip"
                                style={{
                                  alignSelf: "flex-start",
                                  fontSize: 11,
                                  padding: "2px 7px",
                                  background: meta.color,
                                  fontWeight: 600,
                                  border: "1px solid var(--line)",
                                }}
                              >
                                {item.action}
                              </span>
                              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                                {meta.label}
                              </span>
                            </div>
                          </td>

                          {/* Target */}
                          <td>
                            <span style={{ fontSize: 12.5, color: item.target ? "var(--text)" : "var(--muted)" }}>
                              {item.target || "—"}
                            </span>
                          </td>

                          {/* Detail */}
                          <td>
                            <div
                              style={{
                                fontSize: 12,
                                color: "var(--text)",
                                maxWidth: 360,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={item.detail}
                            >
                              {item.detail || "—"}
                            </div>
                          </td>

                          {/* IP & Hash */}
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                              <span style={{ fontFamily: "monospace", fontSize: 11.5, color: "var(--text)" }}>
                                {item.ip || "internal"}
                              </span>
                              {item.hash && (
                                <span
                                  className="tagchip"
                                  style={{
                                    fontFamily: "monospace",
                                    fontSize: 10.5,
                                    padding: "1px 5px",
                                    background: "var(--bg2)",
                                    borderColor: "var(--line)",
                                    color: "var(--muted)",
                                  }}
                                  title={`Full hash: ${item.hash}`}
                                >
                                  {item.hash.slice(0, 8)}…
                                </span>
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

            {/* Pagination Controls */}
            {pages > 1 && (
              <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                <Pager
                  page={page}
                  pages={pages}
                  total={total}
                  onPage={(p) => setPage(p)}
                  size={pageSize}
                  onSize={(s) => { setPageSize(s); setPage(1); }}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* =========================================================================
          MODAL: Audit Record Inspector & Cryptographic Proof
          ========================================================================= */}
      <Modal
        open={!!inspectedItem}
        onClose={() => setInspectedItem(null)}
        wide
      >
        {inspectedItem && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                  Audit Event Record #{inspectedItem.id}
                </h3>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  Recorded on {fmtTime(inspectedItem.ts)} ({ago(inspectedItem.ts)})
                </span>
              </div>
              <span
                className="tagchip"
                style={{
                  fontSize: 12,
                  padding: "3px 8px",
                  background: getActionMeta(inspectedItem.action).color,
                  fontWeight: 600,
                }}
              >
                {inspectedItem.action}
              </span>
            </div>

            {/* Event Metadata Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, background: "var(--bg2)", padding: 14, borderRadius: 8, border: "1px solid var(--line)" }}>
              <div>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 }}>Operator User</span>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>
                  {inspectedItem.user || "system"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 }}>Target Resource</span>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>
                  {inspectedItem.target || "None (Global Operation)"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 }}>Client IP Address</span>
                <div style={{ fontSize: 13, fontFamily: "monospace", color: "var(--text)", marginTop: 2 }}>
                  {inspectedItem.ip || "internal / loopback"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 700 }}>Action Domain</span>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>
                  {getActionMeta(inspectedItem.action).cat}
                </div>
              </div>
            </div>

            {/* Event Payload & Detail */}
            <div>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text)", textTransform: "uppercase" }}>
                Event Payload & Justification
              </span>
              <pre
                style={{
                  margin: "6px 0 0 0",
                  padding: "10px 14px",
                  background: "var(--bg2)",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  fontSize: 12,
                  fontFamily: "monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: "var(--text)",
                  maxHeight: 180,
                  overflowY: "auto",
                }}
              >
                {inspectedItem.detail || "(No additional payload metadata)"}
              </pre>
            </div>

            {/* Cryptographic Hash Chain Block Proof */}
            <div style={{ background: "var(--panel)", padding: 14, borderRadius: 8, border: "1px solid rgba(59, 130, 246, 0.25)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 16, maxHeight: 16, color: "#3b82f6" }}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 11 14 15 10" />
                </svg>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
                  Cryptographic Chain Evidence (SHA-256)
                </span>
              </div>
              <p style={{ margin: "0 0 10px 0", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.4 }}>
                Each audit entry contains the SHA-256 digest of its own data combined with the previous entry's hash, forming an immutable sequence that guarantees non-repudiation.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>Previous Block Hash (prev_hash):</span>
                  <div style={{ fontFamily: "monospace", fontSize: 11.5, color: "var(--muted)", background: "var(--bg2)", padding: "4px 8px", borderRadius: 4, marginTop: 2, wordBreak: "break-all" }}>
                    {inspectedItem.prev_hash || "GENESIS (Chain Root)"}
                  </div>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>Current Block Digest (hash):</span>
                  <div style={{ fontFamily: "monospace", fontSize: 11.5, color: "var(--text)", background: "var(--bg2)", padding: "4px 8px", borderRadius: 4, marginTop: 2, wordBreak: "break-all", border: "1px solid var(--line)" }}>
                    {inspectedItem.hash || "Pending commit"}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="btn primary small"
                onClick={() => setInspectedItem(null)}
              >
                Close Record
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* =========================================================================
          MODAL: Hash Chain Verification Result
          ========================================================================= */}
      <Modal
        open={showVerifyModal}
        onClose={() => setShowVerifyModal(false)}
      >
        {verifyResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: verifyResult.ok ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  color: verifyResult.ok ? "#10b981" : "#ef4444",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ maxWidth: 22, maxHeight: 22 }}>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  {verifyResult.ok ? (
                    <polyline points="9 12 11 14 15 10" />
                  ) : (
                    <>
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </>
                  )}
                </svg>
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                  {verifyResult.ok ? "Cryptographic Chain Intact" : "Chain Integrity Compromised"}
                </h3>
                <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {verifyResult.ok
                    ? `Verified continuity across all ${verifyResult.rows.toLocaleString("en-IN")} ledger rows.`
                    : `Discrepancy detected at ledger block #${verifyResult.first_bad_id}.`}
                </span>
              </div>
            </div>

            <div
              style={{
                background: "var(--bg2)",
                padding: "12px 14px",
                borderRadius: 8,
                border: "1px solid var(--line)",
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--text)",
              }}
            >
              {verifyResult.ok ? (
                <>
                  Every record in the database matches its linked SHA-256 hash backwards to the genesis block. No events have been inserted, edited, or purged without authorization.
                </>
              ) : (
                <>
                  <strong style={{ color: "#ef4444" }}>Warning:</strong> The computed SHA-256 hash does not match the stored hash link at block #{verifyResult.first_bad_id}. This indicates potential database tampering or an interrupted write transaction.
                </>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn primary"
                onClick={() => setShowVerifyModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}
