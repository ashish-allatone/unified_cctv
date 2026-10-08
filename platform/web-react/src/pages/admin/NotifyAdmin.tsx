import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { fmtTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

export type NotifyChannel = {
  name: string;
  type: "sms" | "email" | "whatsapp" | "voice" | "webhook" | string;
  enabled: boolean;
  configured: boolean;
};

export type NotifyRoute = {
  kind: string;
  priority: string | string[];
  subkind: string;
  departments: string[];
  channel: string;
  to: string[];
  enabled: boolean;
};

export type NotifyLogItem = {
  ts: string;
  channel: string;
  recipient: string;
  kind: string;
  subject: string;
  status: string;
  detail: string;
  attempts: number;
};

export type NotifyState = {
  channels: NotifyChannel[];
  routes: NotifyRoute[];
  routes_source: "yaml" | "console";
  kinds: string[];
  log: NotifyLogItem[];
};

const KIND_LABELS: Record<string, string> = {
  alert: "Watchlist / ANPR Alerts",
  incident: "Analytics Incidents",
  camera: "Camera Health (Offline/Online)",
  device: "Devices Connected / Removed",
  detection: "AI Detection Switches",
  security: "Security & Account Lockouts",
  archival: "Archival Runs & Quotas",
  report: "Scheduled Intelligence Reports",
  geofence: "Geofence Zone Events",
  system: "System Platform Events",
};

export default function NotifyAdmin() {
  const [data, setData] = useState<NotifyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingRoutes, setSavingRoutes] = useState(false);
  const [localRoutes, setLocalRoutes] = useState<NotifyRoute[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  // Filters for Log
  const [logSearch, setLogSearch] = useState("");
  const [logChannelFilter, setLogChannelFilter] = useState("all");
  const [logStatusFilter, setLogStatusFilter] = useState("all");

  // Filter for Routes
  const [routeKindFilter, setRouteKindFilter] = useState("all");
  const [routeChannelFilter, setRouteChannelFilter] = useState("all");

  // Test Modal State
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testChannel, setTestChannel] = useState<NotifyChannel | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [sendingTest, setSendingTest] = useState(false);

  // Add Route Modal State
  const [addRouteOpen, setAddRouteOpen] = useState(false);
  const [newKind, setNewKind] = useState("alert");
  const [newPriority, setNewPriority] = useState("high");
  const [newSubkind, setNewSubkind] = useState("");
  const [newDepts, setNewDepts] = useState("");
  const [newChannel, setNewChannel] = useState("");
  const [newRecipients, setNewRecipients] = useState("");

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api<NotifyState>("/api/admin/notifications?limit=500");
      setData(res);
      setLocalRoutes(res.routes || []);
      setIsDirty(false);
      if (res.channels?.length && !newChannel) {
        setNewChannel(res.channels[0].name);
      }
    } catch (e: any) {
      toast(`Failed to load notification settings: ${e?.message || e}`, "err");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [newChannel]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Toggle Channel
  const handleToggleChannel = async (ch: NotifyChannel) => {
    try {
      await api(`/api/admin/notifications/channels/${encodeURIComponent(ch.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      toast(`${ch.name} ${ch.enabled ? "switched off" : "switched on"}`, "ok");
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to toggle channel", "err");
    }
  };

  // Open Test Modal
  const handleOpenTest = (ch: NotifyChannel) => {
    setTestChannel(ch);
    setTestRecipient("");
    setTestModalOpen(true);
  };

  // Submit Test Alert
  const handleSendTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testChannel) return;
    setSendingTest(true);
    try {
      const res = await api<{ status: string; detail?: string }>(
        `/api/admin/notifications/test?channel=${encodeURIComponent(testChannel.name)}&to=${encodeURIComponent(testRecipient.trim())}`,
        { method: "POST" }
      );
      toast(`Test alert to ${testChannel.name}: ${res.status} ${res.detail ? `(${res.detail})` : ""}`, res.status === "sent" ? "ok" : "err");
      setTestModalOpen(false);
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to send test alert", "err");
    } finally {
      setSendingTest(false);
    }
  };

  // Save All Routes
  const handleSaveRoutes = async () => {
    setSavingRoutes(true);
    try {
      const res = await api<{ routes: NotifyRoute[]; routes_source: string }>("/api/admin/notifications/routes", {
        method: "PUT",
        body: JSON.stringify({ routes: localRoutes }),
      });
      toast(`Saved ${res.routes.length} notification route(s)`, "ok");
      setIsDirty(false);
      loadData(true);
    } catch (e: any) {
      toast(e?.message || "Failed to save routes", "err");
    } finally {
      setSavingRoutes(false);
    }
  };

  // Reset Routes to YAML
  const handleResetRoutes = async () => {
    if (!window.confirm("Discard console overrides and revert routing rules to system config/notify.yaml?")) return;
    try {
      await api("/api/admin/notifications/routes", { method: "DELETE" });
      toast("Reverted routes to system YAML defaults", "ok");
      loadData(false);
    } catch (e: any) {
      toast(e?.message || "Failed to reset routes", "err");
    }
  };

  // Remove Route
  const handleRemoveRoute = (index: number) => {
    const updated = [...localRoutes];
    updated.splice(index, 1);
    setLocalRoutes(updated);
    setIsDirty(true);
  };

  // Toggle Route Enabled
  const handleToggleRoute = (index: number) => {
    const updated = [...localRoutes];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    setLocalRoutes(updated);
    setIsDirty(true);
  };

  // Add Route Submission
  const handleAddRoute = (e: React.FormEvent) => {
    e.preventDefault();
    const split = (str: string) => str.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    const routeObj: NotifyRoute = {
      kind: newKind,
      priority: newPriority,
      subkind: newSubkind,
      departments: split(newDepts),
      channel: newChannel || (data?.channels[0]?.name ?? "default"),
      to: split(newRecipients),
      enabled: true,
    };
    setLocalRoutes([routeObj, ...localRoutes]);
    setIsDirty(true);
    setAddRouteOpen(false);
    toast("Added new notification route (click 'Save Routing Changes' to commit)", "ok");
  };

  // KPI Metrics
  const kpis = useMemo(() => {
    if (!data) return null;
    const channels = data.channels || [];
    const activeChannels = channels.filter((c) => c.enabled).length;
    const routes = localRoutes || [];
    const activeRoutes = routes.filter((r) => r.enabled).length;
    const log = data.log || [];
    const successCount = log.filter((l) => ["sent", "answered"].includes(l.status)).length;
    const rate = log.length ? Math.round((successCount / log.length) * 100) : 100;
    return {
      channelsTotal: channels.length,
      activeChannels,
      routesTotal: routes.length,
      activeRoutes,
      successRate: rate,
      totalDispatches: log.length,
      routesSource: data.routes_source,
    };
  }, [data, localRoutes]);

  // Filtered Routes
  const filteredRoutes = useMemo(() => {
    return localRoutes.filter((r) => {
      if (routeKindFilter !== "all" && r.kind !== routeKindFilter) return false;
      if (routeChannelFilter !== "all" && r.channel !== routeChannelFilter) return false;
      return true;
    });
  }, [localRoutes, routeKindFilter, routeChannelFilter]);

  // Filtered Log
  const filteredLog = useMemo(() => {
    if (!data?.log) return [];
    return data.log.filter((l) => {
      if (logSearch) {
        const q = logSearch.toLowerCase();
        const m = l.recipient.toLowerCase().includes(q) ||
                  l.subject.toLowerCase().includes(q) ||
                  l.channel.toLowerCase().includes(q) ||
                  l.kind.toLowerCase().includes(q) ||
                  l.detail.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (logChannelFilter !== "all" && l.channel !== logChannelFilter) return false;
      if (logStatusFilter !== "all") {
        if (logStatusFilter === "sent" && !["sent", "answered"].includes(l.status)) return false;
        if (logStatusFilter === "failed" && ["sent", "answered"].includes(l.status)) return false;
      }
      return true;
    });
  }, [data?.log, logSearch, logChannelFilter, logStatusFilter]);

  return (
    <div className="perm-console-root">
      {/* Mini Dashboard KPI Overview Cards */}
      <div className="perm-kpis-grid">
        {/* Active Channels */}
        <div className="perm-kpi-card" title="Dispatch channels configured in system">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Active Channels</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.activeChannels ?? 0}</span>
              <span className="kpi-sub-pill sober-pill">of {kpis?.channelsTotal ?? 0} total</span>
            </div>
            <span className="kpi-desc">SMS, WhatsApp, Email, Voice IVR</span>
          </div>
        </div>

        {/* Routing Rules */}
        <div className="perm-kpi-card" title="Active alert forwarding rules">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 3 21 3 21 8" />
              <line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" />
              <line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Routing Rules</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.activeRoutes ?? 0}</span>
              <span className={`kpi-sub-pill ${kpis?.routesSource === "console" ? "warn-pill" : "sober-pill"}`}>
                {kpis?.routesSource === "console" ? "Console Override" : "System Config"}
              </span>
            </div>
            <span className="kpi-desc">Event-to-recipient bindings</span>
          </div>
        </div>

        {/* Delivery Success Rate */}
        <div className="perm-kpi-card" title="Historical delivery success rate">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Delivery Success</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.successRate ?? 100}%</span>
              <span className="kpi-sub-pill sober-pill">Reliable</span>
            </div>
            <span className="kpi-desc">Based on {kpis?.totalDispatches ?? 0} dispatches</span>
          </div>
        </div>

        {/* Dispatches Logged */}
        <div className="perm-kpi-card" title="Recent notification transmissions">
          <div className="kpi-icon-box sober-icon-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </div>
          <div className="kpi-meta">
            <div className="kpi-title-row">
              <span className="kpi-label">Audit History</span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value">{kpis?.totalDispatches ?? 0}</span>
              <span className="kpi-sub-pill sober-pill">Logged</span>
            </div>
            <span className="kpi-desc">Cryptographic dispatch ledger</span>
          </div>
        </div>
      </div>

      {/* Channels Section Card */}
      <div className="perm-panel-card">
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Dispatch Channels &amp; Gateways
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Underlying delivery providers configured via <code>config/notify.yaml</code>. Toggle gateways or send a live test message.
            </p>
          </div>

          <div className="perm-actions-group">
            <button
              type="button"
              className="btn ghost icon small refresh-btn"
              onClick={() => loadData(false)}
              title="Refresh channels"
              disabled={loading}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? "spin" : ""}>
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
          </div>
        </div>

        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "22%" }}>CHANNEL NAME</th>
                <th style={{ width: "16%" }}>MEDIA TYPE</th>
                <th style={{ width: "20%" }}>CREDENTIALS STATUS</th>
                <th style={{ width: "18%" }}>STATE</th>
                <th style={{ width: "24%", textAlign: "right" }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {!data?.channels?.length ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "24px 16px", color: "var(--muted)" }}>
                    No channels defined in config/notify.yaml.
                  </td>
                </tr>
              ) : (
                data.channels.map((ch) => (
                  <tr key={ch.name} className={`perm-row ${!ch.enabled ? "revoked-row" : ""}`}>
                    <td>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>{ch.name}</span>
                    </td>
                    <td>
                      <span className="kpi-sub-pill sober-pill" style={{ textTransform: "uppercase" }}>
                        {ch.type}
                      </span>
                    </td>
                    <td>
                      {ch.configured ? (
                        <span style={{ color: "#10b981", fontSize: 12, fontWeight: 600 }}>Configured</span>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>Missing Credentials</span>
                      )}
                    </td>
                    <td>
                      <span className={`kpi-sub-pill ${ch.enabled ? "sober-pill" : "muted-pill"}`}>
                        {ch.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div className="row-actions-group" style={{ justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => handleToggleChannel(ch)}
                          title={ch.enabled ? "Turn channel off" : "Turn channel on"}
                        >
                          {ch.enabled ? "Turn Off" : "Turn On"}
                        </button>
                        <button
                          type="button"
                          className="btn outline small"
                          onClick={() => handleOpenTest(ch)}
                          title="Send a live test alert through this channel"
                        >
                          Test
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notification Routing Rules Panel Card */}
      <div className="perm-panel-card" style={{ marginTop: 20 }}>
        <div className="perm-toolbar">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                Notification Routing Matrix
              </h3>
              {isDirty && (
                <span className="kpi-sub-pill warn-pill" style={{ color: "#f59e0b" }}>
                  Unsaved Changes
                </span>
              )}
            </div>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Controls which operators, field officers, or mobile numbers are notified when events occur.
              {kpis?.routesSource === "console" ? " (Overrides config/notify.yaml)" : " (Loaded from config/notify.yaml)"}
            </p>
          </div>

          <div className="perm-actions-group">
            {kpis?.routesSource === "console" && (
              <button
                type="button"
                className="btn ghost small"
                onClick={handleResetRoutes}
                title="Discard console changes and revert to YAML defaults"
              >
                Reset to YAML
              </button>
            )}

            <button
              type="button"
              className="btn outline small"
              onClick={() => setAddRouteOpen(true)}
              title="Add a new notification route"
            >
              + Add Route
            </button>

            {isDirty && (
              <button
                type="button"
                className="btn primary small"
                onClick={handleSaveRoutes}
                disabled={savingRoutes}
                title="Save routing changes to platform"
              >
                {savingRoutes ? "Saving..." : "Save Routing Changes"}
              </button>
            )}
          </div>
        </div>

        {/* Filter Strip */}
        <div className="perm-filter-strip">
          <div className="perm-select-wrap">
            <select
              value={routeKindFilter}
              onChange={(e) => setRouteKindFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Event Topics</option>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="perm-select-wrap">
            <select
              value={routeChannelFilter}
              onChange={(e) => setRouteChannelFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Channels</option>
              {data?.channels?.map((c) => (
                <option key={c.name} value={c.name}>
                  Channel: {c.name} ({c.type})
                </option>
              ))}
            </select>
          </div>

          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>{filteredRoutes.length} {filteredRoutes.length === 1 ? "route" : "routes"}</span>
          </div>
        </div>

        {/* Routes Table */}
        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "22%" }}>EVENT TOPIC / KIND</th>
                <th style={{ width: "16%" }}>SEVERITY &amp; SUBKIND</th>
                <th style={{ width: "15%" }}>DEPARTMENT SCOPE</th>
                <th style={{ width: "16%" }}>DISPATCH CHANNEL</th>
                <th style={{ width: "21%" }}>RECIPIENTS</th>
                <th style={{ width: "5%", textAlign: "right" }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {!filteredRoutes.length ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    No notification routes match the selected filter.
                  </td>
                </tr>
              ) : (
                filteredRoutes.map((r, i) => (
                  <tr key={i} className={`perm-row ${!r.enabled ? "revoked-row" : ""}`}>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>
                        {KIND_LABELS[r.kind] || r.kind}
                      </div>
                      <code style={{ fontSize: 10.5, color: "var(--muted)" }}>{r.kind}</code>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <span className="kpi-sub-pill sober-pill" style={{ textTransform: "capitalize" }}>
                          {Array.isArray(r.priority) ? r.priority.join(", ") : r.priority || "Any Priority"}
                        </span>
                        {r.subkind && (
                          <span className="kpi-sub-pill sober-pill">
                            {r.subkind}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {r.departments && r.departments.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.departments.map((d) => (
                            <span key={d} className="kpi-sub-pill sober-pill">
                              {d}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>All Departments (*)</span>
                      )}
                    </td>
                    <td>
                      <span style={{ fontWeight: 500, color: "var(--text)" }}>{r.channel}</span>
                    </td>
                    <td>
                      {r.to && r.to.length > 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text)", wordBreak: "break-all" }}>
                          {r.to.join(", ")}
                        </div>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>Broadcast / Default</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div className="row-actions-group" style={{ justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          className="action-btn"
                          onClick={() => handleToggleRoute(i)}
                          title={r.enabled ? "Disable route" : "Enable route"}
                          style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
                        >
                          {r.enabled ? "Active" : "Off"}
                        </button>
                        <button
                          type="button"
                          className="action-btn delete-action"
                          onClick={() => handleRemoveRoute(i)}
                          title="Remove this route"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transmission & Delivery Audit Log Card */}
      <div className="perm-panel-card" style={{ marginTop: 20 }}>
        <div className="perm-toolbar">
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Transmission &amp; Delivery Audit Log
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#64748b" }}>
              Live record of all outgoing notification dispatches across email, SMS, WhatsApp and phone call gateways.
            </p>
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
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="Search recipient, channel, topic or details…"
              className="search-input"
            />
            {logSearch && (
              <button type="button" className="clear-btn" onClick={() => setLogSearch("")} title="Clear search">
                ×
              </button>
            )}
          </div>

          <div className="perm-select-wrap">
            <select
              value={logChannelFilter}
              onChange={(e) => setLogChannelFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Channels</option>
              {data?.channels?.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="perm-select-wrap">
            <select
              value={logStatusFilter}
              onChange={(e) => setLogStatusFilter(e.target.value)}
              className="perm-select"
            >
              <option value="all">All Statuses</option>
              <option value="sent">Successful (Sent / Answered)</option>
              <option value="failed">Failed / Queued</option>
            </select>
          </div>

          <div className="perm-count-indicator">
            <span className="dot-live" />
            <span>{filteredLog.length} dispatches</span>
          </div>
        </div>

        {/* Log Table */}
        <div className="perm-table-container">
          <table className="perm-table sober-perm-table">
            <thead>
              <tr>
                <th style={{ width: "16%" }}>TIMESTAMP (IST)</th>
                <th style={{ width: "14%" }}>GATEWAY / CHANNEL</th>
                <th style={{ width: "18%" }}>RECIPIENT</th>
                <th style={{ width: "14%" }}>EVENT TOPIC</th>
                <th style={{ width: "18%" }}>SUBJECT / SUMMARY</th>
                <th style={{ width: "10%" }}>STATUS</th>
                <th style={{ width: "10%" }}>DETAILS</th>
              </tr>
            </thead>
            <tbody>
              {!filteredLog.length ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "32px 16px", color: "var(--muted)" }}>
                    No transmissions recorded in audit log.
                  </td>
                </tr>
              ) : (
                filteredLog.map((item, idx) => (
                  <tr key={idx} className="perm-row">
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>{fmtTime(item.ts)}</div>
                    </td>
                    <td>
                      <span className="kpi-sub-pill sober-pill">{item.channel}</span>
                    </td>
                    <td>
                      <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "ui-monospace, monospace" }}>
                        {item.recipient}
                      </div>
                    </td>
                    <td>
                      <span style={{ fontSize: 12, color: "var(--text2)" }}>
                        {KIND_LABELS[item.kind] || item.kind}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontSize: 12, color: "var(--text)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.subject}>
                        {item.subject}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`kpi-sub-pill ${
                          ["sent", "answered"].includes(item.status)
                            ? "sober-pill"
                            : item.status === "queued"
                            ? "warn-pill"
                            : "muted-pill"
                        }`}
                        style={{
                          color: ["sent", "answered"].includes(item.status) ? "#10b981" : item.status === "queued" ? "#f59e0b" : "#ef4444",
                          textTransform: "capitalize",
                        }}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontSize: 11.5, color: "#64748b", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.detail}>
                        {item.detail || "Delivered"}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL: Test Channel Alert */}
      {testModalOpen && testChannel && (
        <Modal open={true} onClose={() => setTestModalOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Send Test Alert: {testChannel.name} ({testChannel.type.toUpperCase()})
          </h3>
          <form onSubmit={handleSendTest} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: "#64748b", lineHeight: 1.5 }}>
              Dispatches a test notification message through <b>{testChannel.name}</b> to verify connectivity and credentials.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {testChannel.type === "voice"
                  ? "Destination Phone Number (10 digits / +91...)"
                  : testChannel.type === "email"
                  ? "Destination Email Address"
                  : testChannel.type === "sms" || testChannel.type === "whatsapp"
                  ? "Mobile Phone Number"
                  : "Recipient / Destination"}
              </label>
              <input
                type="text"
                className="search-input"
                placeholder={
                  testChannel.type === "voice" || testChannel.type === "sms" || testChannel.type === "whatsapp"
                    ? "e.g. 9811223344"
                    : testChannel.type === "email"
                    ? "e.g. admin@allatone.in"
                    : "e.g. webhook URL or target"
                }
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
                required={["voice", "email", "sms", "whatsapp"].includes(testChannel.type)}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setTestModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary small"
                disabled={sendingTest}
              >
                {sendingTest ? "Dispatching..." : "Send Test Alert"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* MODAL: Add Route */}
      {addRouteOpen && (
        <Modal open={true} onClose={() => setAddRouteOpen(false)}>
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Add Notification Routing Rule
          </h3>
          <form onSubmit={handleAddRoute} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Event Topic</label>
              <select
                className="perm-select"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
                style={{ width: "100%" }}
              >
                {Object.entries(KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label} ({k})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Priority / Severity</label>
                <select
                  className="perm-select"
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="">Any Priority</option>
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Subkind / Match Type</label>
                <select
                  className="perm-select"
                  value={newSubkind}
                  onChange={(e) => setNewSubkind(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="">Any Type</option>
                  <option value="exact">Exact Match</option>
                  <option value="fuzzy">Fuzzy / OCR Match</option>
                  <option value="rule">Rule Detection</option>
                </select>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Dispatch Channel Gateway</label>
              <select
                className="perm-select"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                style={{ width: "100%" }}
              >
                {data?.channels?.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type.toUpperCase()}{c.enabled ? "" : ", off"})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Department Filter (Optional)</label>
              <input
                type="text"
                className="search-input"
                placeholder="Leave blank for all departments, or e.g. Police, Traffic"
                value={newDepts}
                onChange={(e) => setNewDepts(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Recipients (Comma separated)</label>
              <input
                type="text"
                className="search-input"
                placeholder="e.g. 9811223344, duty-officer@police.gov.in"
                value={newRecipients}
                onChange={(e) => setNewRecipients(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setAddRouteOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary small"
              >
                Add Route to Table
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
