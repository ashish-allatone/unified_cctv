import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtBytes, fmtTime, fmtDay } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export type ArchivalPolicy = {
  data_class: string;
  label: string;
  detail: string;
  department: string;
  min_days: number;
  keep_days: number;
  action: "delete" | "archive";
  can_archive: boolean;
  enabled: boolean;
  source: "config" | "console";
};

export type ArchivalUsageItem = {
  rows: number;
  bytes?: number;
  oldest?: string | null;
};

export type ArchivalRun = {
  started_at: string;
  trigger: string;
  by: string;
  status: "ok" | "running" | "error";
  removed_total: number;
  removed: Record<string, number>;
  archived: Record<string, number>;
  held: number;
  detail?: string;
};

export type ArchivalSchedule = {
  hour_ist: number;
  enabled: boolean;
  cold_prefix?: string;
  cold_class?: string;
};

export type ArchivalState = {
  policies: ArchivalPolicy[];
  usage: Record<string, ArchivalUsageItem>;
  schedule: ArchivalSchedule;
  runs: ArchivalRun[];
  preview: Record<string, { due: number }>;
  running: boolean;
  actions: string[];
};

export default function Archival() {
  const [data, setData] = useState<ArchivalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");

  // Modals & form state
  const [schedModalOpen, setSchedModalOpen] = useState(false);
  const [schedHour, setSchedHour] = useState(2);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [savingSched, setSavingSched] = useState(false);

  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<ArchivalPolicy | null>(null);
  const [overrideDept, setOverrideDept] = useState("");
  const [overrideDays, setOverrideDays] = useState(30);
  const [overrideAction, setOverrideAction] = useState<"delete" | "archive">("delete");
  const [savingOverride, setSavingOverride] = useState(false);

  const [runningJob, setRunningJob] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<ArchivalPolicy | null>(null);
  const [editDays, setEditDays] = useState(30);
  const [editAction, setEditAction] = useState<"delete" | "archive">("delete");
  const [editEnabled, setEditEnabled] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api<ArchivalState>("/api/archival");
      setData(res);
      if (res.schedule) {
        setSchedHour(res.schedule.hour_ist ?? 2);
        setSchedEnabled(!!res.schedule.enabled);
      }
    } catch (e: any) {
      toast(`Failed to load archival policies: ${e?.message || e}`, "err");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Periodic poll if archival run is executing
  useEffect(() => {
    if (!data?.running) return;
    const interval = setInterval(() => {
      loadData(true);
    }, 3500);
    return () => clearInterval(interval);
  }, [data?.running, loadData]);

  // Trigger manual run
  const handleRunNow = async () => {
    if (!window.confirm("Execute archival run now? Records older than their retention threshold will be purged or moved to cold storage. Active legal holds will be safely preserved.")) {
      return;
    }
    setRunningJob(true);
    try {
      await api("/api/archival/run", { method: "POST" });
      toast("Archival job triggered successfully. Processing records in background...", "ok");
      setTimeout(() => loadData(true), 2000);
    } catch (e: any) {
      toast(e?.message || "Failed to trigger archival run", "err");
    } finally {
      setRunningJob(false);
    }
  };

  // Save schedule
  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSched(true);
    try {
      await api("/api/archival/schedule", {
        method: "PUT",
        body: JSON.stringify({ hour_ist: Number(schedHour), enabled: Boolean(schedEnabled) }),
      });
      toast("Archival schedule updated", "ok");
      setSchedModalOpen(false);
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to update schedule", "err");
    } finally {
      setSavingSched(false);
    }
  };

  // Open edit modal for a policy
  const handleOpenEdit = (p: ArchivalPolicy) => {
    setEditingPolicy(p);
    setEditDays(p.keep_days);
    setEditAction(p.action);
    setEditEnabled(p.enabled);
  };

  // Save policy updates
  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPolicy) return;
    if (editDays < editingPolicy.min_days) {
      toast(`Retention period cannot be less than statutory minimum of ${editingPolicy.min_days} days`, "err");
      return;
    }
    setSavingPolicy(true);
    try {
      await api(`/api/archival/policies/${editingPolicy.data_class}`, {
        method: "PUT",
        body: JSON.stringify({
          keep_days: Number(editDays),
          action: editAction,
          enabled: Boolean(editEnabled),
          department: editingPolicy.department,
        }),
      });
      toast(`${editingPolicy.label} policy updated: ${editDays} days (${editAction})`, "ok");
      setEditingPolicy(null);
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to save policy", "err");
    } finally {
      setSavingPolicy(false);
    }
  };

  // Reset console override
  const handleResetPolicy = async (p: ArchivalPolicy) => {
    if (!window.confirm(`Reset "${p.label}" for department "${p.department}" back to the system default policy?`)) return;
    try {
      await api(`/api/archival/policies/${p.data_class}?department=${encodeURIComponent(p.department)}`, {
        method: "DELETE",
      });
      toast(`Reset "${p.label}" to system default`, "ok");
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to reset policy", "err");
    }
  };

  // Open department override modal
  const handleOpenOverride = (p: ArchivalPolicy) => {
    setOverrideTarget(p);
    setOverrideDept("");
    setOverrideDays(p.keep_days);
    setOverrideAction(p.action);
    setOverrideModalOpen(true);
  };

  // Save department override
  const handleSaveOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overrideTarget || !overrideDept.trim()) {
      toast("Please specify a department name", "err");
      return;
    }
    if (overrideDays < overrideTarget.min_days) {
      toast(`Retention period cannot be less than statutory minimum of ${overrideTarget.min_days} days`, "err");
      return;
    }
    setSavingOverride(true);
    try {
      await api(`/api/archival/policies/${overrideTarget.data_class}`, {
        method: "PUT",
        body: JSON.stringify({
          keep_days: Number(overrideDays),
          action: overrideAction,
          enabled: true,
          department: overrideDept.trim(),
        }),
      });
      toast(`Created custom ${overrideTarget.label} override for "${overrideDept.trim()}"`, "ok");
      setOverrideModalOpen(false);
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to create department override", "err");
    } finally {
      setSavingOverride(false);
    }
  };

  // Aggregated KPI numbers
  const kpis = useMemo(() => {
    if (!data) return null;
    const totalDue = Object.values(data.preview || {}).reduce((acc, curr) => acc + (curr?.due || 0), 0);
    const u = data.usage || {};
    const lastRun = data.runs?.[0];
    const overridesCount = (data.policies || []).filter((p) => p.source === "console").length;
    return {
      totalDue,
      eventsRows: u.events?.rows ?? 0,
      eventsBytes: u.events?.bytes ?? 0,
      eventsOldest: u.events?.oldest,
      recRows: u.recordings?.rows ?? 0,
      recBytes: u.recordings?.bytes ?? 0,
      uploadsRows: u.uploads?.rows ?? 0,
      uploadsBytes: u.uploads?.bytes ?? 0,
      auditRows: u.audit?.rows ?? 0,
      lastRun,
      overridesCount,
      coldClass: data.schedule?.cold_class || "COLD_VAULT",
      coldPrefix: data.schedule?.cold_prefix || "cctv-archive",
    };
  }, [data]);

  // Unique departments in policies
  const deptOptions = useMemo(() => {
    if (!data?.policies) return [];
    const depts = new Set<string>();
    data.policies.forEach((p) => {
      if (p.department && p.department !== "*") depts.add(p.department);
    });
    return Array.from(depts);
  }, [data?.policies]);

  // Filtered policies
  const filteredPolicies = useMemo(() => {
    if (!data?.policies) return [];
    return data.policies.filter((p) => {
      if (search) {
        const q = search.toLowerCase();
        const m = p.label.toLowerCase().includes(q) ||
                  p.data_class.toLowerCase().includes(q) ||
                  p.detail.toLowerCase().includes(q) ||
                  p.department.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (deptFilter !== "all") {
        if (deptFilter === "global" && p.department !== "*") return false;
        if (deptFilter !== "global" && p.department !== deptFilter) return false;
      }
      if (actionFilter !== "all" && p.action !== actionFilter) {
        return false;
      }
      return true;
    });
  }, [data?.policies, search, deptFilter, actionFilter]);

  return (
    <div className="perm-console-root">
      {/* Mini Dashboard KPI Overview Cards */}
      <div className="perm-kpis-grid">
        {/* Due Now */}
        <div
          className={`perm-kpi-card ${kpis?.totalDue ? "accent-glow" : ""}`}
          title="Records past retention threshold awaiting purge"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Due for Purge</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.totalDue.toLocaleString("en-IN") ?? "0"}</span>
              <span className={`kpi-sub-pill ${kpis?.totalDue ? "warn-pill" : "sober-pill"}`}>
                {kpis?.totalDue ? "Overdue" : "Compliant"}
              </span>
            </div>
            <span className="kpi-desc">
              {kpis?.totalDue ? "Ready for archival cycle" : "No overdue records pending"}
            </span>
          </div>
        </div>

        {/* ANPR Sighting Events */}
        <div className="perm-kpi-card" title="Plate recognition events stored on local storage">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Plate Sightings</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.eventsRows.toLocaleString("en-IN") ?? "0"}</span>
              <span className="kpi-sub-pill sober-pill">{fmtBytes(kpis?.eventsBytes)}</span>
            </div>
            <span className="kpi-desc">
              {kpis?.eventsOldest ? `Oldest: ${fmtDay(kpis.eventsOldest)}` : "ANPR sightings volume"}
            </span>
          </div>
        </div>

        {/* Video Recordings */}
        <div className="perm-kpi-card" title="Continuous video segments retained">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">CCTV Footage</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.recRows.toLocaleString("en-IN") ?? "0"}</span>
              <span className="kpi-sub-pill sober-pill">{fmtBytes(kpis?.recBytes)}</span>
            </div>
            <span className="kpi-desc">Continuous H.264/H.265 files</span>
          </div>
        </div>

        {/* Uploads & Audit */}
        <div className="perm-kpi-card" title="Investigative uploads and tamper-evident audit records">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Evidence Uploads</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.uploadsRows.toLocaleString("en-IN") ?? "0"}</span>
              <span className="kpi-sub-pill sober-pill">{fmtBytes(kpis?.uploadsBytes)}</span>
            </div>
            <span className="kpi-desc">
              {kpis?.auditRows.toLocaleString("en-IN")} cryptographic audit rows
            </span>
          </div>
        </div>

        {/* Schedule & Last Run */}
        <div
          className="perm-kpi-card perm-kpi-interactive"
          onClick={() => setSchedModalOpen(true)}
          role="button"
          tabIndex={0}
          title="Click to configure automated execution schedule"
        >
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Nightly Run</span>
              <span className="kpi-action-link">Configure</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">
                {data?.schedule?.enabled ? `${String(data.schedule.hour_ist).padStart(2, "0")}:00` : "Paused"}
              </span>
              <span className={`kpi-sub-pill ${data?.schedule?.enabled ? "sober-pill" : "warn-pill"}`}>
                {data?.schedule?.enabled ? "IST Active" : "Paused"}
              </span>
            </div>
            <span className="kpi-desc">
              {kpis?.lastRun ? `Last: ${kpis.lastRun.removed_total} purged (${kpis.lastRun.status})` : `Cold target: ${kpis?.coldPrefix}/`}
            </span>
          </div>
        </div>
      </div>

      {/* Main Table Container Card */}
      <div className="perm-panel-card">
        {/* Header Toolbar */}
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Retention &amp; Archival Policies
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Configure statutory retention limits, storage tiers and cloud cold-storage offloading by data class and department.
            </p>
          </div>

          <div className="perm-actions-group">
            <button
              type="button"
              className="btn ghost icon small refresh-btn"
              onClick={() => loadData(false)}
              title="Refresh retention policies"
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
              className="btn outline small"
              onClick={() => setSchedModalOpen(true)}
              title="Configure automated archival execution schedule"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Schedule: {data?.schedule?.enabled ? `${String(data.schedule.hour_ist).padStart(2, "0")}:00 IST` : "Paused"}</span>
            </button>

            <button
              type="button"
              className="btn primary perm-grant-btn"
              onClick={handleRunNow}
              disabled={data?.running || runningJob}
              title="Trigger an archival and purge execution cycle now"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="btn-ico">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>{data?.running || runningJob ? "Running Archival..." : "Run Archival Now"}</span>
            </button>
          </div>
        </div>

        {/* Filter Strip */}
        <div className="perm-filter-strip">
          <div className="perm-search-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by policy name, data class or department…"
              className="search-input"
            />
            {search && (
              <button type="button" className="clear-btn" onClick={() => setSearch("")} title="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="perm-select-wrap">
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Scopes</option>
              <option value="global">Global Rules (*)</option>
              {deptOptions.map((d) => (
                <option key={d} value={d}>
                  Dept: {d}
                </option>
              ))}
            </select>
          </div>

          <div className="perm-select-wrap">
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Actions</option>
              <option value="delete">Purge / Delete</option>
              <option value="archive">Archive to Cold</option>
            </select>
          </div>

          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>{filteredPolicies.length} {filteredPolicies.length === 1 ? "policy" : "policies"}</span>
          </div>
        </div>

        {/* Info Note Strip */}
        <div style={{ padding: "8px 18px", fontSize: 12, color: "#64748b", background: "var(--bg2)", borderBottom: "1px solid var(--line)" }}>
          <b>Cold Storage Target:</b> Object storage destination is configured under <code>{data?.schedule?.cold_prefix || "cctv-archive"}/</code> ({data?.schedule?.cold_class || "COLD_VAULT"} class). Active Legal Holds take precedence and strictly preserve evidence against automated purge.
        </div>

        {/* Policies Data Table */}
        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "24%" }}>DATA CLASS / PURPOSE</th>
                <th style={{ width: "16%" }}>CURRENT VOLUME</th>
                <th style={{ width: "13%" }}>RETENTION LIMIT</th>
                <th style={{ width: "16%" }}>LIFECYCLE ACTION</th>
                <th style={{ width: "9%" }}>STATUS</th>
                <th style={{ width: "9%" }}>DUE FOR PURGE</th>
                <th style={{ width: "8%" }}>ORIGIN</th>
                <th style={{ width: "5%", textAlign: "right" }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    Loading retention schedules...
                  </td>
                </tr>
              ) : filteredPolicies.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    No retention policies match the selected filters.
                  </td>
                </tr>
              ) : (
                filteredPolicies.map((p) => {
                  const usage = p.department === "*" ? data?.usage?.[p.data_class] : null;
                  const due = p.department === "*" ? data?.preview?.[p.data_class]?.due ?? 0 : null;
                  const isOverride = p.source === "console";

                  return (
                    <tr key={`${p.data_class}-${p.department}`} className={`perm-row ${!p.enabled ? "revoked-row" : ""}`}>
                      {/* Data Class */}
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 600, color: "var(--text)" }}>{p.label}</span>
                          {p.department !== "*" && (
                            <span className="kpi-sub-pill sober-pill" style={{ fontSize: 10 }}>
                              Dept: {p.department}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>{p.detail}</div>
                        <code style={{ fontSize: 10.5, color: "var(--muted)" }}>{p.data_class}</code>
                      </td>

                      {/* Current Volume */}
                      <td>
                        {usage ? (
                          <div>
                            <div style={{ fontWeight: 600, color: "var(--text)" }}>{(usage.rows ?? 0).toLocaleString("en-IN")} rows</div>
                            {usage.bytes ? (
                              <div style={{ fontSize: 11.5, color: "#64748b" }}>{fmtBytes(usage.bytes)}</div>
                            ) : null}
                            {usage.oldest && (
                              <div style={{ fontSize: 10.5, color: "var(--muted)" }}>Oldest: {fmtDay(usage.oldest)}</div>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>

                      {/* Retention Limit */}
                      <td>
                        <div style={{ display: "inline-flex", alignItems: "baseline", gap: 3, padding: "2px 8px", background: "var(--panel2)", borderRadius: 5, border: "1px solid var(--line)" }}>
                          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>{p.keep_days}</span>
                          <span style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase" }}>days</span>
                        </div>
                        {p.min_days > 0 && (
                          <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>Min {p.min_days}d statutory</div>
                        )}
                      </td>

                      {/* Expiration Action */}
                      <td>
                        {p.action === "archive" ? (
                          <span className="kpi-sub-pill sober-pill" style={{ color: "#3b82f6", borderColor: "rgba(59, 130, 246, 0.3)" }}>
                            Archive to Cold, then delete
                          </span>
                        ) : (
                          <span className="kpi-sub-pill sober-pill" style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.3)" }}>
                            Purge from Disk
                          </span>
                        )}
                      </td>

                      {/* Status */}
                      <td>
                        <span className={`kpi-sub-pill ${p.enabled ? "sober-pill" : "muted-pill"}`}>
                          {p.enabled ? "Active" : "Disabled"}
                        </span>
                      </td>

                      {/* Due for Purge */}
                      <td>
                        {due !== null ? (
                          <span className={`kpi-sub-pill ${due > 0 ? "warn-pill" : "sober-pill"}`}>
                            {due.toLocaleString("en-IN")}
                          </span>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>

                      {/* Origin */}
                      <td>
                        <span className="kpi-sub-pill sober-pill" style={{ fontSize: 10 }}>
                          {isOverride ? "Override" : "Default"}
                        </span>
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: "right" }}>
                        <div className="row-actions-group" style={{ justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="action-btn edit-action"
                            onClick={() => handleOpenEdit(p)}
                            title="Edit retention policy rule"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>

                          {isOverride && (
                            <button
                              type="button"
                              className="action-btn delete-action"
                              onClick={() => handleResetPolicy(p)}
                              title="Reset back to system default"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="1 4 1 10 7 10" />
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                              </svg>
                            </button>
                          )}

                          {p.department === "*" && (
                            <button
                              type="button"
                              className="action-btn"
                              onClick={() => handleOpenOverride(p)}
                              title="Add custom retention rule for a specific department"
                              style={{ width: "auto", padding: "0 6px", fontSize: 11, fontWeight: 700 }}
                            >
                              +Dept
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

      {/* Execution Run History Section */}
      <div className="perm-panel-card" style={{ marginTop: 20 }}>
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Recent Archival Execution History
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Audit log of automated nightly runs and on-demand manual archival executions
            </p>
          </div>
        </div>

        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "18%" }}>STARTED AT (IST)</th>
                <th style={{ width: "10%" }}>TRIGGER</th>
                <th style={{ width: "12%" }}>INITIATOR</th>
                <th style={{ width: "10%" }}>STATUS</th>
                <th style={{ width: "15%" }}>REMOVED / PURGED</th>
                <th style={{ width: "15%" }}>ARCHIVED TO COLD</th>
                <th style={{ width: "10%" }}>HELD (LEGAL)</th>
                <th style={{ width: "10%" }}>DETAILS</th>
              </tr>
            </thead>
            <tbody>
              {!data?.runs?.length ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    No archival runs recorded yet. Click "Run Archival Now" or wait for the nightly schedule.
                  </td>
                </tr>
              ) : (
                data.runs.map((r, idx) => (
                  <tr key={r.started_at || idx} className="perm-row">
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>{fmtTime(r.started_at)}</div>
                    </td>
                    <td>
                      <span className="kpi-sub-pill sober-pill" style={{ textTransform: "capitalize" }}>{r.trigger}</span>
                    </td>
                    <td>
                      <code style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.by}</code>
                    </td>
                    <td>
                      <span className={`kpi-sub-pill ${r.status === "ok" ? "sober-pill" : r.status === "running" ? "warn-pill" : "muted-pill"}`}>
                        {r.status === "ok" ? "Success" : r.status === "running" ? "Running" : "Failed"}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>{r.removed_total.toLocaleString("en-IN")}</div>
                      {r.removed && Object.keys(r.removed).length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {Object.entries(r.removed).map(([k, v]) => `${k}: ${v}`).join(", ")}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>
                        {r.archived && Object.keys(r.archived).length > 0
                          ? Object.entries(r.archived).map(([k, v]) => `${k}: ${v}`).join(", ")
                          : "—"}
                      </div>
                    </td>
                    <td>
                      <span className={`kpi-sub-pill ${r.held > 0 ? "sober-pill" : "muted-pill"}`}>
                        {r.held} protected
                      </span>
                    </td>
                    <td>
                      <div style={{ fontSize: 11.5, color: "#64748b", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.detail}>
                        {r.detail ? r.detail.split("\n")[0] : "Completed successfully"}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL: Configure Schedule */}
      {schedModalOpen && (
        <Modal open={true} onClose={() => setSchedModalOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Configure Automated Archival Schedule
          </h3>
          <form onSubmit={handleSaveSchedule} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: "#64748b", lineHeight: 1.5 }}>
              Unified CCTV runs automated archival cycles to enforce data retention limits and migrate older video clips
              to cold object storage.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Execution Time (IST)</label>
              <select
                className="perm-select"
                value={schedHour}
                onChange={(e) => setSchedHour(Number(e.target.value))}
                style={{ width: "100%" }}
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00 IST ({h === 2 ? "Recommended: 02:00 AM off-peak" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="sched-enabled-check"
                checked={schedEnabled}
                onChange={(e) => setSchedEnabled(e.target.checked)}
              />
              <label htmlFor="sched-enabled-check" style={{ fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
                Enable automated daily execution
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setSchedModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary small"
                disabled={savingSched}
              >
                {savingSched ? "Saving..." : "Save Schedule"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL: Edit Policy */}
      {editingPolicy && (
        <Modal open={true} onClose={() => setEditingPolicy(null)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Edit Retention Policy: {editingPolicy.label}
          </h3>
          <form onSubmit={handleSavePolicy} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Data Class</label>
              <input type="text" className="search-input" value={editingPolicy.data_class} disabled />
            </div>

            {editingPolicy.department !== "*" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Department Scope</label>
                <input type="text" className="search-input" value={editingPolicy.department} disabled />
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                Retention Period (Days)
                {editingPolicy.min_days > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>
                    (Statutory Minimum: {editingPolicy.min_days} days)
                  </span>
                )}
              </label>
              <input
                type="number"
                min={editingPolicy.min_days || 1}
                max={3650}
                className="search-input"
                value={editDays}
                onChange={(e) => setEditDays(Number(e.target.value))}
                required
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Expiration Action</label>
              <select
                className="perm-select"
                value={editAction}
                onChange={(e) => setEditAction(e.target.value as "delete" | "archive")}
                style={{ width: "100%" }}
              >
                <option value="delete">Purge / Delete permanently from disk</option>
                {editingPolicy.can_archive && (
                  <option value="archive">Archive to Cold Object Storage, then delete from local disk</option>
                )}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                id="edit-enabled-check"
                checked={editEnabled}
                onChange={(e) => setEditEnabled(e.target.checked)}
              />
              <label htmlFor="edit-enabled-check" style={{ fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
                Enable policy enforcement for this data class
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setEditingPolicy(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary small"
                disabled={savingPolicy}
              >
                {savingPolicy ? "Saving..." : "Save Policy"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL: Department Override */}
      {overrideModalOpen && overrideTarget && (
        <Modal open={true} onClose={() => setOverrideModalOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Add Department Override for {overrideTarget.label}
          </h3>
          <form onSubmit={handleSaveOverride} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: "#64748b", lineHeight: 1.5 }}>
              Create a custom retention duration for a specific department (e.g. Police, Traffic, Central Security)
              that differs from the global {overrideTarget.label} policy.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Department Name</label>
              <input
                type="text"
                className="search-input"
                placeholder="e.g. Police, Traffic, Terminal 1"
                value={overrideDept}
                onChange={(e) => setOverrideDept(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                Retention Period for Department (Days)
                {overrideTarget.min_days > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>
                    (Minimum: {overrideTarget.min_days} days)
                  </span>
                )}
              </label>
              <input
                type="number"
                min={overrideTarget.min_days || 1}
                max={3650}
                className="search-input"
                value={overrideDays}
                onChange={(e) => setOverrideDays(Number(e.target.value))}
                required
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Expiration Action</label>
              <select
                className="perm-select"
                value={overrideAction}
                onChange={(e) => setOverrideAction(e.target.value as "delete" | "archive")}
                style={{ width: "100%" }}
              >
                <option value="delete">Purge / Delete permanently from disk</option>
                {overrideTarget.can_archive && (
                  <option value="archive">Archive to Cold Object Storage, then delete from local disk</option>
                )}
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setOverrideModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary small"
                disabled={savingOverride}
              >
                {savingOverride ? "Saving..." : "Create Override"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
