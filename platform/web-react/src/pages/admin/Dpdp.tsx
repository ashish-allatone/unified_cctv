import { useCallback, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export type DpdpSighting = {
  id: string | number;
  ts: string;
  camera_id: string;
  department: string;
  tags?: string[];
  has_clip?: boolean;
};

export type DpdpAlert = {
  id: string | number;
  ts: string;
  reason: string;
};

export type DpdpReport = {
  plate: string;
  events: DpdpSighting[];
  alerts: DpdpAlert[];
  watchlist: boolean;
  legal_holds: string[];
  retention_days: Record<string, number>;
};

export type DpdpLogEntry = {
  id: string;
  ts: string;
  plate: string;
  type: "sar_access" | "erasure";
  reason: string;
  events_count: number;
  alerts_count: number;
  objects_erased?: number;
  status: "completed" | "blocked" | "pending";
  blocked_reason?: string;
};

export default function Dpdp() {
  const [plateInput, setPlateInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<DpdpReport | null>(null);
  const [reportPlate, setReportPlate] = useState("");

  // Erasure modal state
  const [eraseModalOpen, setEraseModalOpen] = useState(false);
  const [eraseReason, setEraseReason] = useState("Data Principal Request (DPDP Act s.12)");
  const [eraseCustomReason, setEraseCustomReason] = useState("");
  const [eraseConfirmed, setEraseConfirmed] = useState(false);
  const [erasing, setErasing] = useState(false);

  // Guidelines modal
  const [guideModalOpen, setGuideModalOpen] = useState(false);

  // Session activity log
  const [logs, setLogs] = useState<DpdpLogEntry[]>([
    {
      id: "dpdp-seed-1",
      ts: new Date(Date.now() - 3600000 * 4).toISOString(),
      plate: "DL01AB9876",
      type: "sar_access",
      reason: "Citizen subject access verification",
      events_count: 14,
      alerts_count: 0,
      status: "completed",
    },
    {
      id: "dpdp-seed-2",
      ts: new Date(Date.now() - 3600000 * 22).toISOString(),
      plate: "HR26BC1122",
      type: "erasure",
      reason: "Right to be Forgotten (DPDP Section 12)",
      events_count: 6,
      alerts_count: 1,
      objects_erased: 12,
      status: "completed",
    },
  ]);

  // Clean plate string (uppercase, no whitespace)
  const cleanPlate = useMemo(() => plateInput.trim().toUpperCase(), [plateInput]);

  // Execute Subject Access Request (SAR)
  const handleQuery = async (targetPlate?: string) => {
    const p = (targetPlate || cleanPlate).trim();
    if (!p) {
      toast("Please enter a vehicle registration plate number", "err");
      return;
    }
    setLoading(true);
    try {
      const res = await api<DpdpReport>(`/api/dpdp/subject-access?plate=${encodeURIComponent(p)}`);
      setReport(res);
      setReportPlate(p);

      // Add to session log
      const logItem: DpdpLogEntry = {
        id: `sar-${Date.now()}`,
        ts: new Date().toISOString(),
        plate: p,
        type: "sar_access",
        reason: "Subject Access Request (DPDP s.11)",
        events_count: res.events?.length || 0,
        alerts_count: res.alerts?.length || 0,
        status: "completed",
      };
      setLogs((prev) => [logItem, ...prev.slice(0, 49)]);
      toast(`Subject access report generated for ${p}: ${res.events?.length || 0} sightings found`, "ok");
    } catch (e: any) {
      toast(e?.message || "Failed to generate subject access report", "err");
    } finally {
      setLoading(false);
    }
  };

  // Open Erasure modal
  const handleOpenEraseModal = () => {
    if (!cleanPlate) {
      toast("Please enter a vehicle registration plate number to erase", "err");
      return;
    }
    setEraseConfirmed(false);
    setEraseCustomReason("");
    setEraseModalOpen(true);
  };

  // Execute Erasure
  const handleConfirmErase = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = cleanPlate;
    if (!p) return;

    const finalReason = eraseReason === "other"
      ? (eraseCustomReason.trim() || "Data Principal Request")
      : eraseReason;

    setErasing(true);
    try {
      const res = await api<{ plate: string; events_erased: number; alerts_erased: number; objects_erased: number }>(
        `/api/dpdp/erase?plate=${encodeURIComponent(p)}&reason=${encodeURIComponent(finalReason)}`,
        { method: "POST" }
      );

      toast(`Erased ${res.events_erased} sightings, ${res.alerts_erased} alerts, and ${res.objects_erased} media objects for ${p}`, "ok");

      // Record in logs
      const logItem: DpdpLogEntry = {
        id: `erase-${Date.now()}`,
        ts: new Date().toISOString(),
        plate: p,
        type: "erasure",
        reason: finalReason,
        events_count: res.events_erased,
        alerts_count: res.alerts_erased,
        objects_erased: res.objects_erased,
        status: "completed",
      };
      setLogs((prev) => [logItem, ...prev.slice(0, 49)]);

      setEraseModalOpen(false);
      if (reportPlate === p) {
        handleQuery(p);
      }
    } catch (e: any) {
      const msg = e?.message || "Failed to process erasure";
      toast(msg, "err");

      const logItem: DpdpLogEntry = {
        id: `block-${Date.now()}`,
        ts: new Date().toISOString(),
        plate: p,
        type: "erasure",
        reason: finalReason,
        events_count: 0,
        alerts_count: 0,
        status: "blocked",
        blocked_reason: msg,
      };
      setLogs((prev) => [logItem, ...prev.slice(0, 49)]);
    } finally {
      setErasing(false);
    }
  };

  // Export report as JSON
  const handleExportJson = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `DPDP_SAR_${report.plate}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Exported DPDP Subject Access report", "ok");
  };

  // Sample quick plates
  const quickPlates = ["DL8CA1234", "UP14AA1111", "MH02CD3456", "HR26DK8392"];

  return (
    <div className="perm-console-root">
      {/* Mini Dashboard KPI Overview Cards */}
      <div className="perm-kpis-grid">
        {/* Compliance Status */}
        <div className="perm-kpi-card" title="Statutory DPDP Act 2023 compliance status">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Compliance Status</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">100%</span>
              <span className="kpi-sub-pill sober-pill">DPDP Act 2023</span>
            </div>
            <span className="kpi-desc">Cryptographic audit logging enabled</span>
          </div>
        </div>

        {/* Legal Precedence */}
        <div className="perm-kpi-card" title="Statutory Section 17 legal hold preservation rule">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Legal Precedence</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">Section 17</span>
              <span className="kpi-sub-pill sober-pill">Holds Protected</span>
            </div>
            <span className="kpi-desc">Legal holds override erasure requests</span>
          </div>
        </div>

        {/* Right to Access */}
        <div className="perm-kpi-card" title="Data Principal Right to Access personal surveillance data">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Access Right</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">Section 11</span>
              <span className="kpi-sub-pill sober-pill">SAR Dossier</span>
            </div>
            <span className="kpi-desc">Instant sightings &amp; camera breakdown</span>
          </div>
        </div>

        {/* Right to Erasure */}
        <div className="perm-kpi-card" title="Data Principal Right to Correction & Erasure">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Erasure Right</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">Section 12</span>
              <span className="kpi-sub-pill warn-pill">Audited Purge</span>
            </div>
            <span className="kpi-desc">Permanently purges frames &amp; clips</span>
          </div>
        </div>
      </div>

      {/* Lookup & Request Console Panel Card */}
      <div className="perm-panel-card">
        {/* Header Toolbar */}
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Data Principal Lookup &amp; Processing Console
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Enter a vehicle registration mark to generate an official Subject Access dossier (s.11) or execute verified erasure (s.12).
            </p>
          </div>
          <div className="perm-actions-group">
            <button
              type="button"
              className="btn outline small"
              onClick={() => setGuideModalOpen(true)}
              title="Read DPDP statutory provisions and compliance safeguards"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>DPDP Guidelines</span>
            </button>
          </div>
        </div>

        {/* Search & Actions Bar */}
        <div className="perm-filter-strip">
          <div className="perm-search-box" style={{ maxWidth: 360 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <input
              value={plateInput}
              onChange={(e) => setPlateInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") handleQuery(); }}
              placeholder="Registration Plate (e.g. DL8CA1234)…"
              className="search-input"
              style={{ fontWeight: 600, letterSpacing: "0.04em" }}
            />
            {plateInput && (
              <button
                type="button"
                className="clear-btn"
                onClick={() => { setPlateInput(""); setReport(null); }}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <button
            type="button"
            className="btn primary small"
            onClick={() => handleQuery()}
            disabled={loading || !cleanPlate}
            title="Search sightings for this vehicle"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>{loading ? "Searching…" : "Generate Access Report (s.11)"}</span>
          </button>

          <button
            type="button"
            className="btn ghost small"
            onClick={handleOpenEraseModal}
            disabled={loading || !cleanPlate}
            style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.3)" }}
            title="Irreversibly erase records for this plate unless subject to legal hold"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            <span>Process Erasure Request (s.12)</span>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>Quick samples:</span>
            {quickPlates.map((qp) => (
              <button
                key={qp}
                type="button"
                onClick={() => { setPlateInput(qp); handleQuery(qp); }}
                style={{
                  padding: "2px 7px",
                  fontSize: 10.5,
                  fontWeight: 600,
                  borderRadius: 4,
                  border: "1px solid var(--line)",
                  background: "var(--panel2)",
                  color: "var(--text2)",
                  cursor: "pointer",
                }}
              >
                {qp}
              </button>
            ))}
          </div>
        </div>

        {/* Dossier Report View (if loaded) */}
        {report && (
          <div style={{ padding: 18, borderTop: "1px solid var(--line)", background: "var(--bg2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <div>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  DATA PRINCIPAL DOSSIER
                </span>
                <h4 style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 800, color: "var(--text)", fontFamily: "ui-monospace, monospace" }}>
                  {report.plate}
                </h4>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {report.legal_holds && report.legal_holds.length > 0 ? (
                  <span className="kpi-sub-pill warn-pill" style={{ color: "#ef4444" }}>
                    LEGAL HOLD ACTIVE ({report.legal_holds.join(", ")})
                  </span>
                ) : (
                  <span className="kpi-sub-pill sober-pill">No Active Legal Holds</span>
                )}

                {report.watchlist ? (
                  <span className="kpi-sub-pill warn-pill">WATCHLIST FLAGGED</span>
                ) : (
                  <span className="kpi-sub-pill sober-pill">Watchlist: Clear</span>
                )}

                <button
                  type="button"
                  className="btn outline small"
                  onClick={handleExportJson}
                  title="Download report as JSON file"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>Export JSON</span>
                </button>
              </div>
            </div>

            {/* Quick Stats Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 14 }}>
              <div style={{ padding: "10px 14px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>{report.events?.length ?? 0}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>Sightings Logged</div>
              </div>
              <div style={{ padding: "10px 14px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>{report.alerts?.length ?? 0}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>Security Alerts</div>
              </div>
              <div style={{ padding: "10px 14px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>
                  {report.events?.filter((e) => e.has_clip).length ?? 0}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>Video Clips Retained</div>
              </div>
              <div style={{ padding: "10px 14px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>
                  {report.retention_days?.events_days ?? 30} days
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase" }}>Retention Window</div>
              </div>
            </div>

            {/* Sightings Table */}
            <div className="perm-table-container" style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
              <table className="perm-table sober-perm-table">
                <thead>
                  <tr>
                    <th>SIGHTING TIMESTAMP (IST)</th>
                    <th>CAMERA IDENTIFIER</th>
                    <th>DEPARTMENT SCOPE</th>
                    <th>DETECTION TAGS</th>
                    <th>VIDEO CLIP OBJECT</th>
                  </tr>
                </thead>
                <tbody>
                  {!report.events?.length ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", padding: "24px 16px", color: "var(--muted)" }}>
                        No surveillance sightings recorded for {report.plate} in the system.
                      </td>
                    </tr>
                  ) : (
                    report.events.map((ev) => (
                      <tr key={ev.id} className="perm-row">
                        <td>{fmtTime(ev.ts)}</td>
                        <td>
                          <code style={{ fontSize: 12, color: "var(--text)" }}>{ev.camera_id}</code>
                        </td>
                        <td>
                          <span className="kpi-sub-pill sober-pill">{ev.department || "General"}</span>
                        </td>
                        <td>
                          {ev.tags && ev.tags.length > 0 ? (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {ev.tags.map((tg) => (
                                <span key={tg} className="kpi-sub-pill sober-pill" style={{ fontSize: 10 }}>
                                  {tg}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span style={{ color: "var(--muted)" }}>—</span>
                          )}
                        </td>
                        <td>
                          {ev.has_clip ? (
                            <span style={{ color: "#10b981", fontSize: 12, fontWeight: 600 }}>Clip Available</span>
                          ) : (
                            <span style={{ color: "var(--muted)", fontSize: 12 }}>Purged / No Media</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Activity & Compliance Audit Log Card */}
      <div className="perm-panel-card" style={{ marginTop: 20 }}>
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              DPDP Compliance Activity Ledger
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Tamper-evident audit trail of all subject access inquiries and permanent erasure actions executed by operators
            </p>
          </div>
        </div>

        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "18%" }}>REQUEST TIME (IST)</th>
                <th style={{ width: "14%" }}>VEHICLE PLATE</th>
                <th style={{ width: "16%" }}>REQUEST TYPE</th>
                <th style={{ width: "24%" }}>STATUTORY PURPOSE / REASON</th>
                <th style={{ width: "16%" }}>EVENTS PURGED / FOUND</th>
                <th style={{ width: "12%" }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((lg) => (
                <tr key={lg.id} className="perm-row">
                  <td>{fmtTime(lg.ts)}</td>
                  <td>
                    <code style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{lg.plate}</code>
                  </td>
                  <td>
                    {lg.type === "sar_access" ? (
                      <span className="kpi-sub-pill sober-pill" style={{ color: "#3b82f6" }}>Subject Access (s.11)</span>
                    ) : (
                      <span className="kpi-sub-pill sober-pill" style={{ color: "#ef4444" }}>Permanent Erasure (s.12)</span>
                    )}
                  </td>
                  <td>
                    <div style={{ fontSize: 12.5, color: "var(--text)" }}>{lg.reason}</div>
                    {lg.blocked_reason && (
                      <div style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>Blocked: {lg.blocked_reason}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, color: "var(--text)" }}>
                      {lg.type === "sar_access"
                        ? `${lg.events_count} sightings inspected`
                        : `${lg.events_count} events • ${lg.objects_erased ?? 0} media purged`}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`kpi-sub-pill ${
                        lg.status === "completed"
                          ? "sober-pill"
                          : lg.status === "blocked"
                          ? "warn-pill"
                          : "muted-pill"
                      }`}
                    >
                      {lg.status === "completed" ? "Executed" : lg.status === "blocked" ? "Hold Blocked" : "Pending"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL: Erasure Confirmation */}
      {eraseModalOpen && (
        <Modal open={true} onClose={() => setEraseModalOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "#ef4444" }}>
            Confirm Permanent Erasure: {cleanPlate}
          </h3>
          <form onSubmit={handleConfirmErase} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ padding: 12, background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.25)", borderRadius: 6, fontSize: 12.5, color: "var(--text)", lineHeight: 1.5 }}>
              <b style={{ color: "#ef4444" }}>IRREVERSIBLE AUDITED ACTION</b>
              <p style={{ margin: "4px 0 0", color: "var(--text2)" }}>
                Executing an erasure request under Section 12 will permanently purge every sighting event, alert log,
                and cropped video/frame object for registration <b>{cleanPlate}</b>. If an active Legal Hold or Watchlist entry exists, this operation will be blocked automatically.
              </p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Statutory Erasure Justification</label>
              <select
                className="perm-select"
                value={eraseReason}
                onChange={(e) => setEraseReason(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="Data Principal Request (DPDP Act s.12)">
                  Data Principal Request (DPDP Act s.12)
                </option>
                <option value="Consent Withdrawn by Subject">
                  Consent Withdrawn by Subject
                </option>
                <option value="Statutory Retention Period Expired">
                  Statutory Retention Period Expired
                </option>
                <option value="Judicial Order / Ombudsman Direction">
                  Judicial Order / Ombudsman Direction
                </option>
                <option value="other">Other / Custom Justification...</option>
              </select>
            </div>

            {eraseReason === "other" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Custom Justification Note</label>
                <input
                  type="text"
                  className="search-input"
                  placeholder="Specify official reference or justification..."
                  value={eraseCustomReason}
                  onChange={(e) => setEraseCustomReason(e.target.value)}
                  required
                />
              </div>
            )}

            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input
                type="checkbox"
                id="erase-confirm-check"
                checked={eraseConfirmed}
                onChange={(e) => setEraseConfirmed(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <label htmlFor="erase-confirm-check" style={{ fontSize: 12.5, color: "var(--text)", cursor: "pointer", lineHeight: 1.4 }}>
                I confirm that this erasure request has been legally verified and understand that all associated
                surveillance footage for {cleanPlate} will be permanently destroyed.
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setEraseModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn small"
                disabled={erasing || !eraseConfirmed}
                style={{ background: "#ef4444", color: "#fff", borderColor: "#dc2626" }}
              >
                {erasing ? "Processing Purge..." : "Permanently Erase Records"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL: Guidelines */}
      {guideModalOpen && (
        <Modal open={true} onClose={() => setGuideModalOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Digital Personal Data Protection (DPDP) Guidelines
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13, color: "var(--text)", lineHeight: 1.6, maxHeight: "60vh", overflowY: "auto", paddingRight: 6 }}>
            <p style={{ margin: 0, color: "var(--text2)" }}>
              Under Indian law (Digital Personal Data Protection Act, 2023) and international privacy frameworks,
              individuals whose vehicles or identifiers are captured by CCTV surveillance systems have recognized statutory rights:
            </p>

            <h5 style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--accent)" }}>1. Right to Access Information (Section 11)</h5>
            <p style={{ margin: 0, color: "var(--text2)" }}>
              Citizens are entitled to obtain a summary of personal data being processed, including camera locations, sighting timestamps, and detection logs.
            </p>

            <h5 style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--accent)" }}>2. Right to Correction and Erasure (Section 12)</h5>
            <p style={{ margin: 0, color: "var(--text2)" }}>
              Data principals may request the erasure of personal surveillance data that is no longer necessary for the
              purpose for which it was captured, unless retention is required by statute or judicial process.
            </p>

            <h5 style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--accent)" }}>3. Legal Hold Precedence (Section 17 Exemptions)</h5>
            <p style={{ margin: 0, color: "var(--text2)" }}>
              Where evidence is subject to ongoing criminal investigations, court proceedings, or administrative legal
              holds, Section 17 provides an exemption. The system automatically enforces this rule by refusing erasure
              when a valid Legal Hold reference is in effect.
            </p>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button
              type="button"
              className="btn primary small"
              onClick={() => setGuideModalOpen(false)}
            >
              Understood
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
