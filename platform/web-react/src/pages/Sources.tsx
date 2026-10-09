import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime, fmtBytes } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface SourceSubmenuItem {
  id: string;
  tabKey: "sources" | "devices" | "capacity" | "sla" | "archive";
  label: string;
  desc: string;
  iconName: "gateways" | "devices" | "capacity" | "sla" | "archive";
}

export const SOURCES_SECTIONS: SourceSubmenuItem[] = [
  {
    id: "gateways",
    tabKey: "sources",
    label: "Ingestion Gateways",
    desc: "Upstream video relays & RTSP adapters",
    iconName: "gateways",
  },
  {
    id: "devices",
    tabKey: "devices",
    label: "Connected Devices",
    desc: "Hardware NVRs, DVRs & cameras",
    iconName: "devices",
  },
  {
    id: "capacity",
    tabKey: "capacity",
    label: "Department Capacity",
    desc: "Bandwidth quotas & relay health",
    iconName: "capacity",
  },
  {
    id: "sla",
    tabKey: "sla",
    label: "Stream SLA & Quality",
    desc: "Stream uptime SLA & video quality",
    iconName: "sla",
  },
  {
    id: "archive",
    tabKey: "archive",
    label: "Video Archive",
    desc: "Footage storage, segments & retention",
    iconName: "archive",
  },
];

export interface SourceItem {
  id: string;
  name: string;
  department: string;
  status: "ok" | "degraded" | "offline";
  adapter: string;
  cameras: number;
  active_pulls: number;
  max_concurrent_pulls: number;
  viewers: number;
  detail: string;
  checked_at?: string | null;
}

export interface DeviceItem {
  id: string;
  name: string;
  department: string;
  adapter: string;
  cameras: number;
  channels: number;
  status: "ok" | "error" | "connecting";
  status_detail?: string;
  config: {
    vendor?: string;
    host?: string;
    rtsp_port?: number;
    onvif_port?: number;
    main?: string;
    sub?: string;
    streams?: { main?: string; sub?: string }[];
    site?: { host?: string; rtsp_port?: number; vendor?: string };
    [key: string]: any;
  };
}

export interface DeviceTypesData {
  types: Record<string, { label: string }>;
  vendors: Record<string, { adapter: string }>;
}

export interface CapacityData {
  relays: Record<string, { healthy: boolean; [key: string]: any }>;
  record_mode: string;
  departments: {
    department: string;
    cameras: number;
    online: number;
    anpr_channels: number;
    recorded: number;
    pulls: number;
    pull_cap: number;
    viewers: number;
    events_24h: number;
    archive_gb: number;
    archive_gb_per_day: number;
    storage_estimate_gb_per_day: number;
    relays: Record<string, number>;
  }[];
}

export interface SlaData {
  fleet_uptime_pct: number;
  days: number;
  cameras: {
    id: string;
    name: string;
    department: string;
    status: "ok" | "offline" | "degraded";
    uptime_pct: number;
    outages: number;
    downtime_min: number;
    longest_outage_min: number;
    quality?: {
      verdict: "ok" | "blur" | "dark";
      sharpness: number;
      brightness: number;
    };
    sla_met: boolean;
  }[];
}

export interface ArchiveStats {
  storage: string;
  record_mode: string;
  departments: {
    department: string;
    segments: number;
    bytes: number;
    clips: number;
    from: string | null;
    to: string | null;
  }[];
}

export default function Sources() {
  const { has } = useAuth();
  const isAdmin = has("admin");
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

  // Tab Navigation derived from route parameter
  const tabFromSection = useMemo<"sources" | "devices" | "capacity" | "sla" | "archive">(() => {
    if (!section || section === "gateways" || section === "sources") return "sources";
    if (section === "devices") return "devices";
    if (section === "capacity") return "capacity";
    if (section === "sla") return "sla";
    if (section === "archive") return "archive";
    return "sources";
  }, [section]);

  const [tab, setTab] = useState<"sources" | "devices" | "capacity" | "sla" | "archive">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "sources" | "devices" | "capacity" | "sla" | "archive") => {
    setTab(nextTab);
    const target = nextTab === "sources" ? "gateways" : nextTab;
    navigate(`/sources/${target}`);
  };

  // Data states
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [capacity, setCapacity] = useState<CapacityData | null>(null);
  const [sla, setSla] = useState<SlaData | null>(null);
  const [archive, setArchive] = useState<ArchiveStats | null>(null);
  const [slaDays, setSlaDays] = useState(7);
  const [loading, setLoading] = useState(false);

  // Search & Filters
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");

  // Device modal
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceItem | null>(null);
  const [deviceTypes, setDeviceTypes] = useState<DeviceTypesData | null>(null);
  const [savingDevice, setSavingDevice] = useState(false);

  // Device form states
  const [devName, setDevName] = useState("");
  const [devDept, setDevDept] = useState("");
  const [devType, setDevType] = useState("nvr");
  const [devVendor, setDevVendor] = useState("");
  const [devHost, setDevHost] = useState("");
  const [devRtspPort, setDevRtspPort] = useState(554);
  const [devOnvifPort, setDevOnvifPort] = useState(80);
  const [devChannels, setDevChannels] = useState(4);
  const [devUsername, setDevUsername] = useState("");
  const [devPassword, setDevPassword] = useState("");
  const [devMainTemplate, setDevMainTemplate] = useState("");

  // Scan modal / state
  const [scanningSourceId, setScanningSourceId] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<any>(null);

  // Fetch all sources data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [srcRes, devRes, capRes, slaRes, arcRes] = await Promise.all([
        api<SourceItem[]>("/api/sources").catch(() => []),
        api<DeviceItem[]>("/api/devices").catch(() => []),
        api<CapacityData>("/api/capacity").catch(() => null),
        api<SlaData>(`/api/health/sla?days=${slaDays}`).catch(() => null),
        api<ArchiveStats>("/api/archive/stats").catch(() => null),
      ]);
      setSources(srcRes || []);
      setDevices(devRes || []);
      setCapacity(capRes);
      setSla(slaRes);
      setArchive(arcRes);
    } catch (e: any) {
      toast(e.message || "Failed to load sources", "err");
    } finally {
      setLoading(false);
    }
  }, [slaDays]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load Device Types when opening modal
  const openConnectDevice = async (existing: DeviceItem | null = null) => {
    try {
      if (!deviceTypes) {
        const dt = await api<DeviceTypesData>("/api/devices/types");
        setDeviceTypes(dt);
      }
    } catch {
      // Fallback
    }

    if (existing) {
      setEditingDevice(existing);
      setDevName(existing.name || "");
      setDevDept(existing.department || "");
      setDevType(existing.config?.adapter === "push" ? "push" : existing.config?.vendor ? "nvr" : "template");
      setDevVendor(existing.config?.vendor || "");
      setDevHost(existing.config?.host || existing.config?.site?.host || "");
      setDevRtspPort(existing.config?.rtsp_port || 554);
      setDevOnvifPort(existing.config?.onvif_port || 80);
      setDevChannels(existing.channels || 4);
      setDevUsername(existing.config?.username || "");
      setDevPassword("");
      setDevMainTemplate(existing.config?.main || "");
    } else {
      setEditingDevice(null);
      setDevName("");
      setDevDept("");
      setDevType("nvr");
      setDevVendor("hikvision");
      setDevHost("");
      setDevRtspPort(554);
      setDevOnvifPort(80);
      setDevChannels(4);
      setDevUsername("");
      setDevPassword("");
      setDevMainTemplate("");
    }
    setShowDeviceModal(true);
  };

  // Submit Device form
  const handleSaveDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!devName.trim() || !devDept.trim()) {
      toast("Please fill in device name and department", "warn");
      return;
    }

    setSavingDevice(true);
    const body: any = {
      name: devName.trim(),
      department: devDept.trim(),
      type: devType,
      vendor: devVendor,
      host: devHost.trim(),
      rtsp_port: Number(devRtspPort),
      onvif_port: Number(devOnvifPort),
      channels: Number(devChannels),
      username: devUsername.trim(),
    };
    if (devPassword) body.password = devPassword;
    if (devMainTemplate) body.main_template = devMainTemplate.trim();

    try {
      if (editingDevice) {
        await api(`/api/devices/${editingDevice.id}`, { method: "PUT", body: JSON.stringify(body) });
        toast(`Device "${devName}" updated`, "ok");
      } else {
        await api("/api/devices", { method: "POST", body: JSON.stringify(body) });
        toast(`Device "${devName}" connected`, "ok");
      }
      setShowDeviceModal(false);
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to save device", "err");
    } finally {
      setSavingDevice(false);
    }
  };

  // Delete/Disconnect Device
  const handleDisconnectDevice = async (dev: DeviceItem) => {
    if (!confirm(`Disconnect "${dev.name}"? Associated cameras will leave the video wall and registry.`)) return;
    try {
      const res = await api<{ cameras_removed: number }>(`/api/devices/${dev.id}`, { method: "DELETE" });
      toast(`Disconnected: ${res.cameras_removed} camera(s) removed`, "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to disconnect device", "err");
    }
  };

  // Probe Source channels
  const handleScanSource = async (sid: string) => {
    setScanningSourceId(sid);
    try {
      const res = await api(`/api/sources/${sid}/scan`, { method: "POST" });
      setScanResult(res);
      toast("Channel probe finished", "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Channel probe failed", "err");
    } finally {
      setScanningSourceId(null);
    }
  };

  // Derived KPIs
  const kpis = useMemo(() => {
    const totalSources = sources.length;
    const okSources = sources.filter((s) => s.status === "ok").length;
    const totalPulls = sources.reduce((acc, s) => acc + (s.active_pulls || 0), 0);
    const maxPulls = sources.reduce((acc, s) => acc + (s.max_concurrent_pulls || 0), 0);
    const totalViewers = sources.reduce((acc, s) => acc + (s.viewers || 0), 0);
    const fleetUptime = sla ? sla.fleet_uptime_pct : 100;

    return {
      totalSources,
      okSources,
      totalPulls,
      maxPulls: maxPulls || 1,
      totalViewers,
      fleetUptime,
    };
  }, [sources, sla]);

  // Departments list for filter
  const departmentsList = useMemo(() => {
    const set = new Set<string>();
    sources.forEach((s) => s.department && set.add(s.department));
    devices.forEach((d) => d.department && set.add(d.department));
    (sla?.cameras || []).forEach((c) => c.department && set.add(c.department));
    return Array.from(set).sort();
  }, [sources, devices, sla]);

  // SLA Filters & Pagination state
  const [slaPage, setSlaPage] = useState(1);
  const [slaPageSize, setSlaPageSize] = useState(25);
  const [slaStatusFilter, setSlaStatusFilter] = useState<"all" | "met" | "breached">("all");

  useEffect(() => {
    setSlaPage(1);
  }, [search, deptFilter, slaStatusFilter, slaDays]);

  // Filtered Sources
  const filteredSources = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sources.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !s.adapter.toLowerCase().includes(q)) return false;
      if (deptFilter !== "all" && s.department !== deptFilter) return false;
      return true;
    });
  }, [sources, search, deptFilter]);

  // Filtered Devices
  const filteredDevices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return devices.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q) && !d.adapter.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q)) return false;
      if (deptFilter !== "all" && d.department !== deptFilter) return false;
      return true;
    });
  }, [devices, search, deptFilter]);

  // Filtered SLA Cameras & Pagination
  const filteredCameras = useMemo(() => {
    const list = sla?.cameras || [];
    const q = search.trim().toLowerCase();
    return list.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.department.toLowerCase().includes(q)) return false;
      if (deptFilter !== "all" && c.department !== deptFilter) return false;
      if (slaStatusFilter === "met" && !c.sla_met) return false;
      if (slaStatusFilter === "breached" && c.sla_met) return false;
      return true;
    });
  }, [sla, search, deptFilter, slaStatusFilter]);

  const slaTotalPages = Math.max(1, Math.ceil(filteredCameras.length / slaPageSize));

  const pagedCameras = useMemo(() => {
    const start = (slaPage - 1) * slaPageSize;
    return filteredCameras.slice(start, start + slaPageSize);
  }, [filteredCameras, slaPage, slaPageSize]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Video Sources & Ingestion Telemetry</h2>
              <p className="perm-page-desc">
                High-throughput RTSP relays, camera hardware NVR connectors, departmental bandwidth quotas, and 24/7 SLA stream health.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={loadData}
                disabled={loading}
                title="Refresh sources and health telemetry"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => openConnectDevice(null)}
                  title="Onboard an NVR, RTSP gateway or ONVIF camera"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Connect Device
                </button>
              )}
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Gateways Active */}
            <div className="perm-kpi-card" title="Total video source gateways and relay adapters">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Ingest Gateways</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.okSources} / {kpis.totalSources}</span>
                  <span className="kpi-sub-pill sober-pill">Online</span>
                </div>
                <span className="kpi-desc">Healthy upstream video adapters</span>
              </div>
            </div>

            {/* Fleet Uptime SLA */}
            <div className="perm-kpi-card" title="Cumulative camera stream uptime SLA compliance">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: kpis.fleetUptime >= 99 ? "rgba(16, 185, 129, 0.12)" : "rgba(245, 158, 11, 0.12)",
                  color: kpis.fleetUptime >= 99 ? "#10b981" : "#f59e0b",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Fleet Uptime</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.fleetUptime}%</span>
                  <span className={`kpi-sub-pill ${kpis.fleetUptime >= 99 ? "sober-pill" : "warn-pill"}`}>
                    {kpis.fleetUptime >= 99 ? "SLA Met" : "Warning"}
                  </span>
                </div>
                <span className="kpi-desc">Availability over {slaDays} days</span>
              </div>
            </div>

            {/* Ingest Pull Capacity */}
            <div className="perm-kpi-card" title="Current active RTSP stream pulls vs maximum throughput limit">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Active Ingest Pulls</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalPulls} / {kpis.maxPulls}</span>
                  <span className="kpi-sub-pill sober-pill">
                    {Math.round((kpis.totalPulls / kpis.maxPulls) * 100)}% Cap
                  </span>
                </div>
                <span className="kpi-desc">Concurrent feeds pulled from sites</span>
              </div>
            </div>

            {/* Operators Served */}
            <div className="perm-kpi-card" title="Concurrent operators viewing feeds via relay without loading original devices">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Viewers Served</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalViewers}</span>
                  <span className="kpi-sub-pill sober-pill">Relayed</span>
                </div>
                <span className="kpi-desc">Zero extra load on NVRs</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "sources" ? "active" : ""}`}
              onClick={() => handleTabChange("sources")}
              role="tab"
            >
              <span>Ingestion Gateways</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{sources.length}</span>
              {tab === "sources" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "devices" ? "active" : ""}`}
              onClick={() => handleTabChange("devices")}
              role="tab"
            >
              <span>Connected Devices</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{devices.length}</span>
              {tab === "devices" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "capacity" ? "active" : ""}`}
              onClick={() => handleTabChange("capacity")}
              role="tab"
            >
              <span>Department Capacity</span>
              {tab === "capacity" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "sla" ? "active" : ""}`}
              onClick={() => handleTabChange("sla")}
              role="tab"
            >
              <span>Stream SLA & Quality</span>
              {tab === "sla" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "archive" ? "active" : ""}`}
              onClick={() => handleTabChange("archive")}
              role="tab"
            >
              <span>Video Archive</span>
              {tab === "archive" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TAB 1: Ingestion Sources Gateways
              ========================================================================= */}
          {tab === "sources" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Filter bar */}
              <div className="perm-panel-card" style={{ padding: "12px 16px" }}>
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
                      placeholder="Search gateway adapters by name or integration…"
                      className="search-input"
                    />
                    {search && (
                      <button type="button" className="clear-btn" onClick={() => setSearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
                      <option value="all">All Departments</option>
                      {departmentsList.map((d) => (
                        <option key={d} value={d}>Department: {d}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Source Cards Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                {filteredSources.length === 0 ? (
                  <div className="perm-panel-card" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                    No ingestion sources match criteria.
                  </div>
                ) : (
                  filteredSources.map((s) => {
                    const pullPercent = s.max_concurrent_pulls > 0
                      ? Math.min(100, Math.round((s.active_pulls / s.max_concurrent_pulls) * 100))
                      : 0;

                    return (
                      <div
                        key={s.id}
                        className="perm-panel-card"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 12,
                          padding: 16,
                          border: s.status === "ok" ? "1px solid var(--line)" : "1px solid rgba(239, 68, 68, 0.3)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span className="tagchip" style={{ fontWeight: 700, fontSize: 11.5 }}>
                            {s.department || "General"}
                          </span>
                          <span className={s.status === "ok" ? "ok-chip" : "bad-chip"} style={{ fontSize: 11.5 }}>
                            ● {s.status.toUpperCase()}
                          </span>
                        </div>

                        <div>
                          <h3 style={{ margin: "0 0 2px 0", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                            {s.name}
                          </h3>
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>
                            Adapter: <strong>{s.adapter}</strong>
                          </span>
                        </div>

                        {/* Stream pull usage meter */}
                        <div style={{ background: "var(--bg2)", padding: 10, borderRadius: 6, border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                            <span style={{ color: "var(--muted)" }}>Active RTSP Pulls:</span>
                            <strong>{s.active_pulls} / {s.max_concurrent_pulls} ({pullPercent}%)</strong>
                          </div>
                          <div style={{ width: "100%", height: 6, background: "var(--panel)", borderRadius: 3, overflow: "hidden" }}>
                            <div
                              style={{
                                width: `${pullPercent}%`,
                                height: "100%",
                                background: pullPercent > 80 ? "#ef4444" : "#3b82f6",
                                transition: "width 0.3s ease",
                              }}
                            />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                            <span>Cameras: {s.cameras}</span>
                            <span>Relayed Viewers: {s.viewers}</span>
                          </div>
                        </div>

                        <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.4 }}>
                          {s.detail}
                          {s.checked_at && (
                            <div style={{ marginTop: 2, fontSize: 11 }}>Last checked {fmtTime(s.checked_at)}</div>
                          )}
                        </div>

                        {/* Actions for rtsp_template */}
                        {s.adapter === "rtsp_template" && isAdmin && (
                          <div style={{ display: "flex", gap: 8, marginTop: 4, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={() => handleScanSource(s.id)}
                              disabled={scanningSourceId === s.id}
                              style={{ fontSize: 11.5 }}
                              title="Probe the next channel numbers on this gateway"
                            >
                              {scanningSourceId === s.id ? "Probing..." : "Find new cameras"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 2: Connected Devices (NVRs / Cameras)
              ========================================================================= */}
          {tab === "devices" && (
            <div className="perm-panel-card">
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
                      placeholder="Search devices by name, IP, or ID…"
                      className="search-input"
                    />
                    {search && (
                      <button type="button" className="clear-btn" onClick={() => setSearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
                      <option value="all">All Departments</option>
                      {departmentsList.map((d) => (
                        <option key={d} value={d}>Department: {d}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  Total <strong>{devices.length}</strong> devices connected
                </div>
              </div>

              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "16%" }}>Device ID</th>
                      <th style={{ width: "18%" }}>Name</th>
                      <th style={{ width: "14%" }}>Department</th>
                      <th style={{ width: "12%" }}>Type / Vendor</th>
                      <th style={{ width: "16%" }}>Host / Endpoint</th>
                      <th style={{ width: "10%" }}>Channels</th>
                      <th style={{ width: "14%", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDevices.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No devices connected yet. Click <strong>Connect Device</strong> above.
                        </td>
                      </tr>
                    ) : (
                      filteredDevices.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <code style={{ fontFamily: "monospace", fontSize: 11.5, background: "var(--bg2)", padding: "2px 6px", borderRadius: 4 }}>
                              {d.id}
                            </code>
                          </td>
                          <td>
                            <strong>{d.name}</strong>
                          </td>
                          <td>
                            <span className="tagchip" style={{ fontSize: 11.5 }}>
                              {d.department}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, textTransform: "capitalize" }}>
                              {d.config?.vendor || d.adapter}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--muted)" }}>
                              {d.config?.host || (d.config?.streams || [])[0]?.main || "—"}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                              {d.cameras} / {d.channels}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "inline-flex", gap: 6 }}>
                              {d.adapter === "push" && (
                                <a
                                  href={`/api/devices/${d.id}/site-connector.zip`}
                                  className="btn ghost small"
                                  style={{ padding: "3px 8px", fontSize: 11.5 }}
                                  title="Download docker-compose site connector zip"
                                >
                                  Bundle ⤓
                                </a>
                              )}
                              {isAdmin && (
                                <>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => openConnectDevice(d)}
                                    style={{ padding: "3px 8px", fontSize: 11.5 }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => handleDisconnectDevice(d)}
                                    style={{ padding: "3px 8px", fontSize: 11.5, color: "#ef4444" }}
                                  >
                                    Disconnect
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 3: Department Capacity & Relays
              ========================================================================= */}
          {tab === "capacity" && (
            <div className="perm-panel-card">
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                    Department Bandwidth & Storage Quota
                  </h3>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    Record Mode: <strong>{capacity?.record_mode || "anpr"}</strong> · Relays:{" "}
                    {Object.entries(capacity?.relays || {}).map(([n, r]) => `${n} (${r.healthy ? "✓" : "✗"})`).join(", ")}
                  </span>
                </div>
              </div>

              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "16%" }}>Department</th>
                      <th style={{ width: "14%" }}>Cameras Online</th>
                      <th style={{ width: "12%" }}>ANPR Channels</th>
                      <th style={{ width: "12%" }}>Recorded</th>
                      <th style={{ width: "12%" }}>Pulls / Cap</th>
                      <th style={{ width: "10%" }}>Viewers</th>
                      <th style={{ width: "12%" }}>Events (24h)</th>
                      <th style={{ width: "12%", textAlign: "right" }}>Archive (GB)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!capacity || capacity.departments.length === 0) ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No capacity statistics available.
                        </td>
                      </tr>
                    ) : (
                      capacity.departments.map((d) => (
                        <tr key={d.department}>
                          <td>
                            <strong>{d.department}</strong>
                          </td>
                          <td>
                            <span style={{ fontWeight: 600 }}>{d.online}</span>
                            <span style={{ color: "var(--muted)", fontSize: 11.5 }}> / {d.cameras}</span>
                          </td>
                          <td>{d.anpr_channels}</td>
                          <td>{d.recorded}</td>
                          <td>{d.pulls} / {d.pull_cap}</td>
                          <td>{d.viewers}</td>
                          <td>{d.events_24h.toLocaleString("en-IN")}</td>
                          <td style={{ textAlign: "right" }}>
                            <strong>{d.archive_gb} GB</strong>
                            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                              +{d.archive_gb_per_day} GB/day
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: Camera SLA & Stream Quality
              ========================================================================= */}
          {tab === "sla" && (
            <div className="perm-panel-card">
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                    Camera Stream SLA & Video Quality
                  </h3>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    Fleet uptime: <strong>{sla?.fleet_uptime_pct ?? 100}%</strong> over {slaDays} days · Total evaluated: <strong>{filteredCameras.length}</strong> cameras
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>Evaluation Window:</span>
                  <div className="perm-select-wrap">
                    <select
                      value={slaDays}
                      onChange={(e) => setSlaDays(Number(e.target.value))}
                      style={{ padding: "4px 8px", fontSize: 12 }}
                    >
                      <option value={1}>24 Hours</option>
                      <option value={7}>7 Days</option>
                      <option value={30}>30 Days</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* SLA Filter Strip */}
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
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
                      placeholder="Search camera by name or department…"
                      className="search-input"
                    />
                    {search && (
                      <button type="button" className="clear-btn" onClick={() => setSearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
                      <option value="all">All Departments</option>
                      {departmentsList.map((d) => (
                        <option key={d} value={d}>Department: {d}</option>
                      ))}
                    </select>
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={slaStatusFilter}
                      onChange={(e) => setSlaStatusFilter(e.target.value as any)}
                    >
                      <option value="all">All SLA Statuses</option>
                      <option value="met">SLA Compliant (≥ 99%)</option>
                      <option value="breached">SLA Breached (&lt; 99%)</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "20%" }}>Camera Name</th>
                      <th style={{ width: "14%" }}>Department</th>
                      <th style={{ width: "10%" }}>Status</th>
                      <th style={{ width: "12%" }}>Uptime %</th>
                      <th style={{ width: "10%" }}>Outages</th>
                      <th style={{ width: "12%" }}>Total Downtime</th>
                      <th style={{ width: "12%" }}>Video Quality</th>
                      <th style={{ width: "10%", textAlign: "right" }}>SLA (&ge; 99%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!sla || filteredCameras.length === 0) ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No camera SLA telemetry matching criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedCameras.map((c) => (
                        <tr key={c.id}>
                          <td><strong>{c.name}</strong></td>
                          <td><span className="tagchip" style={{ fontSize: 11 }}>{c.department}</span></td>
                          <td>
                            <span className={c.status === "offline" ? "bad-chip" : "ok-chip"} style={{ fontSize: 11 }}>
                              {c.status}
                            </span>
                          </td>
                          <td><strong>{c.uptime_pct}%</strong></td>
                          <td>{c.outages}</td>
                          <td>{c.downtime_min} min</td>
                          <td>
                            {c.quality ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                <span className={c.quality.verdict === "ok" ? "ok-chip" : "warn-chip"} style={{ alignSelf: "flex-start", fontSize: 10.5 }}>
                                  {c.quality.verdict}
                                </span>
                                <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
                                  Sharp: {c.quality.sharpness} · Bright: {c.quality.brightness}
                                </span>
                              </div>
                            ) : (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>No sample</span>
                            )}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <span className={c.sla_met ? "ok-chip" : "bad-chip"} style={{ fontSize: 11 }}>
                              {c.sla_met ? "✓ Met" : "✗ Breach"}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {filteredCameras.length > 0 && (
                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                  <Pager
                    page={slaPage}
                    pages={slaTotalPages}
                    total={filteredCameras.length}
                    onPage={(p) => setSlaPage(p)}
                    size={slaPageSize}
                    onSize={(s) => {
                      setSlaPageSize(s);
                      setSlaPage(1);
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 5: Video Archive
              ========================================================================= */}
          {tab === "archive" && (
            <div className="perm-panel-card">
              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
                  Object Storage Video Archive
                </h3>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  Backend: <strong>{archive?.storage || "Object Storage"}</strong> · Mode: <strong>{archive?.record_mode || "anpr"}</strong>
                </span>
              </div>

              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "20%" }}>Department</th>
                      <th style={{ width: "16%" }}>Segments Stored</th>
                      <th style={{ width: "16%" }}>Total Volume</th>
                      <th style={{ width: "16%" }}>Event Clips</th>
                      <th style={{ width: "16%" }}>Oldest Video</th>
                      <th style={{ width: "16%", textAlign: "right" }}>Newest Video</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!archive || archive.departments.length === 0) ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No video recordings archived yet.
                        </td>
                      </tr>
                    ) : (
                      archive.departments.map((d) => (
                        <tr key={d.department}>
                          <td><strong>{d.department}</strong></td>
                          <td>{d.segments.toLocaleString("en-IN")}</td>
                          <td><strong>{fmtBytes(d.bytes)}</strong></td>
                          <td>{d.clips.toLocaleString("en-IN")}</td>
                          <td><span style={{ fontSize: 12, color: "var(--muted)" }}>{d.from ? fmtTime(d.from) : "—"}</span></td>
                          <td style={{ textAlign: "right" }}><span style={{ fontSize: 12, color: "var(--muted)" }}>{d.to ? fmtTime(d.to) : "—"}</span></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Architectural Principles Card */}
          <div className="perm-panel-card" style={{ marginTop: 18, padding: "16px 20px", background: "var(--bg2)", border: "1px solid var(--line)" }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>
              Enterprise Isolation Guarantee
            </h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
              <li><strong>Zero Additional Load:</strong> Relays pull each RTSP stream exactly once regardless of operator count. Streams terminate automatically 10 seconds after the last viewer leaves.</li>
              <li><strong>Strict Concurrency Quotas:</strong> Each source gateway enforces an agreed capacity ceiling, guaranteeing network bandwidth stability.</li>
              <li><strong>Read-Only Accounts:</strong> Hardware connectors operate strictly via read-only credentials, preventing any upstream administrative modifications.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* =========================================================================
          MODAL: Connect / Edit Device
          ========================================================================= */}
      <Modal
        open={showDeviceModal}
        onClose={() => !savingDevice && setShowDeviceModal(false)}
        wide
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            {editingDevice ? `Edit Device · ${editingDevice.name}` : "Connect Hardware Device"}
          </h3>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
            Provide a read-only account on the hardware NVR, DVR, or ONVIF camera. Credentials are encrypted and securely stored.
          </p>

          <form onSubmit={handleSaveDevice} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Device Name *</label>
                <input
                  type="text"
                  value={devName}
                  onChange={(e) => setDevName(e.target.value)}
                  placeholder="e.g. Traffic Core NVR 01"
                  required
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Department *</label>
                <input
                  type="text"
                  value={devDept}
                  onChange={(e) => setDevDept(e.target.value)}
                  placeholder="e.g. Police, Traffic, Smart City"
                  required
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Device Type</label>
                <select
                  value={devType}
                  onChange={(e) => setDevType(e.target.value)}
                  disabled={!!editingDevice}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                >
                  <option value="nvr">Multi-channel NVR</option>
                  <option value="onvif">ONVIF Camera</option>
                  <option value="template">RTSP URL Template</option>
                  <option value="push">Push Connector</option>
                </select>
              </div>

              {(devType === "nvr" || devType === "push") && (
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Vendor Preset</label>
                  <select
                    value={devVendor}
                    onChange={(e) => setDevVendor(e.target.value)}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                  >
                    <option value="hikvision">Hikvision</option>
                    <option value="dahua">Dahua</option>
                    <option value="uniview">Uniview</option>
                    <option value="cpplus">CP Plus</option>
                    <option value="axis">Axis Communications</option>
                    <option value="hanwha">Hanwha Techwin</option>
                    <option value="generic">Generic ONVIF</option>
                  </select>
                </div>
              )}

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Total Channels</label>
                <input
                  type="number"
                  min="1"
                  max="512"
                  value={devChannels}
                  onChange={(e) => setDevChannels(Math.max(1, parseInt(e.target.value) || 1))}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Host / IP Address</label>
                <input
                  type="text"
                  value={devHost}
                  onChange={(e) => setDevHost(e.target.value)}
                  placeholder="10.20.30.40 or nvr.city.gov.in"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>RTSP Port</label>
                <input
                  type="number"
                  value={devRtspPort}
                  onChange={(e) => setDevRtspPort(parseInt(e.target.value) || 554)}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>ONVIF Port</label>
                <input
                  type="number"
                  value={devOnvifPort}
                  onChange={(e) => setDevOnvifPort(parseInt(e.target.value) || 80)}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Read-Only Username</label>
                <input
                  type="text"
                  value={devUsername}
                  onChange={(e) => setDevUsername(e.target.value)}
                  placeholder="viewer_service"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                  Password {editingDevice ? "(leave blank to keep)" : ""}
                </label>
                <input
                  type="password"
                  value={devPassword}
                  onChange={(e) => setDevPassword(e.target.value)}
                  placeholder={editingDevice ? "••••••••" : "Password"}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13 }}
                />
              </div>
            </div>

            {devType === "template" && (
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>Stream Template (RTSP)</label>
                <input
                  type="text"
                  value={devMainTemplate}
                  onChange={(e) => setDevMainTemplate(e.target.value)}
                  placeholder="rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg2)", color: "var(--text)", fontSize: 13, fontFamily: "monospace" }}
                />
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <button
                type="button"
                className="btn outline"
                onClick={() => setShowDeviceModal(false)}
                disabled={savingDevice}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={savingDevice}
              >
                {savingDevice ? "Saving..." : editingDevice ? "Update Device" : "Connect Device"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* =========================================================================
          MODAL: Channel Scan Results
          ========================================================================= */}
      <Modal
        open={!!scanResult}
        onClose={() => setScanResult(null)}
      >
        {scanResult && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Channel Discovery Results
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.45 }}>
              Probed RTSP channels on gateway. Added responding video streams to the camera catalog.
            </p>
            <pre style={{ margin: 0, padding: 12, background: "var(--bg2)", borderRadius: 6, border: "1px solid var(--line)", fontSize: 12, fontFamily: "monospace", overflowX: "auto" }}>
              {JSON.stringify(scanResult, null, 2)}
            </pre>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" onClick={() => setScanResult(null)}>
                Done
              </button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}
