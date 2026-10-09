import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import { useWsMessage } from "../lib/ws";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface AlertSectionItem {
  id: string;
  tabKey: "live" | "history" | "incidents" | "dispatch";
  label: string;
  desc: string;
  iconName: "live" | "history" | "incidents" | "dispatch";
}

export const ALERTS_SECTIONS: AlertSectionItem[] = [
  {
    id: "live",
    tabKey: "live",
    label: "Live Watchlist Hits",
    desc: "Real-time alerts triggered by vehicles of interest on cameras with audio dispatch",
    iconName: "live",
  },
  {
    id: "history",
    tabKey: "history",
    label: "Alerts History & Log",
    desc: "Historical audit log of acknowledged and archived watchlist hits",
    iconName: "history",
  },
  {
    id: "incidents",
    tabKey: "incidents",
    label: "Zone & Perimeter Incidents",
    desc: "Automated perimeter breaches, wrong-way, speed, and safety zone triggers",
    iconName: "incidents",
  },
  {
    id: "dispatch",
    tabKey: "dispatch",
    label: "Dispatch & Escalation Rules",
    desc: "Notification routing policies, audio announcer options, and alert channels",
    iconName: "dispatch",
  },
];

export interface CameraItem {
  id: string;
  name: string;
  department?: string;
  status?: string;
  anpr_enabled?: boolean;
}

export interface WatchlistAlert {
  id: string;
  event_id?: string;
  plate: string;
  watchlist_plate?: string;
  match?: string;
  camera_id: string;
  department?: string;
  ts: string;
  priority?: "high" | "medium" | "low" | string;
  reason?: string;
  ack_by?: string | null;
  ack_at?: string | null;
  crop_url?: string;
  frame_url?: string;
}

export interface ZoneIncident {
  id: string;
  ts: string;
  kind: string;
  zone?: any;
  camera_id: string;
  plate?: string;
  detail?: any;
  status: "open" | "ack" | "closed" | string;
  snapshot_url?: string;
  confidence?: number;
  ack_by?: string | null;
}

const formatDetail = (val: any): string => {
  if (!val) return "Automated threshold trigger";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    if ("persons" in val) {
      return `Persons: ${val.persons}${val.max !== undefined ? ` (limit: ${val.max})` : ""}`;
    }
    if ("vehicles" in val) {
      return `Vehicles: ${val.vehicles}${val.max !== undefined ? ` (limit: ${val.max})` : ""}`;
    }
    if ("speed" in val) {
      return `Speed: ${val.speed} km/h${val.limit ? ` (limit: ${val.limit})` : ""}`;
    }
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === "bbox" || k === "crops") continue;
      clean[k] = v;
    }
    const str = Object.entries(clean)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(", ");
    return str || JSON.stringify(val);
  }
  return String(val);
};

const formatZone = (z: any): string => {
  if (!z) return "Default Zone";
  if (typeof z === "string") return z;
  if (typeof z === "object" && z.name) return String(z.name);
  return typeof z === "object" ? JSON.stringify(z) : String(z);
};

export interface CaseOption {
  id: string;
  number: string;
  title: string;
}

export interface NotificationRoute {
  kind: string;
  priority: string;
  subkind?: string;
  channel: string;
  to: string[];
  enabled: boolean;
}

export default function Alerts() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has, user } = useAuth();

  const canAck = has("alerts_ack") || user?.role === "admin" || user?.role === "supervisor";
  const canCases = has("cases");

  // Tab mapping
  const tabFromSection = useMemo<"live" | "history" | "incidents" | "dispatch">(() => {
    if (!section || section === "live" || section === "open" || section === "active") return "live";
    if (section === "history" || section === "archive" || section === "log") return "history";
    if (section === "incidents" || section === "zones" || section === "perimeter") return "incidents";
    if (section === "dispatch" || section === "rules" || section === "channels") return "dispatch";
    return "live";
  }, [section]);

  const [tab, setTab] = useState<"live" | "history" | "incidents" | "dispatch">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "live" | "history" | "incidents" | "dispatch") => {
    setTab(nextTab);
    navigate(`/alerts/${nextTab}`);
  };

  // Shared Cameras
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [camById, setCamById] = useState<Record<string, CameraItem>>({});

  useEffect(() => {
    api<CameraItem[]>("/api/cameras")
      .then((res) => {
        const sorted = (Array.isArray(res) ? res : []).slice().sort((a, b) => a.name.localeCompare(b.name));
        setCameras(sorted);
        const map: Record<string, CameraItem> = {};
        sorted.forEach((c) => {
          map[c.id] = c;
        });
        setCamById(map);
      })
      .catch(() => {});
  }, []);

  // Audio Speech Announcer state
  const [audioSpeak, setAudioSpeak] = useState<boolean>(() => {
    try {
      return localStorage.getItem("uvp-speak") === "1";
    } catch {
      return false;
    }
  });

  const toggleAudioSpeak = () => {
    setAudioSpeak((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("uvp-speak", next ? "1" : "0");
      } catch {}
      if (next) {
        speakAlertText("Watchlist audio alert announcer is now active");
      }
      return next;
    });
  };

  const speakAlertText = (txt: string) => {
    if (!window.speechSynthesis) return;
    try {
      const utterance = new SpeechSynthesisUtterance(txt);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {}
  };

  // --------------------------------------------------------------------------
  // TAB 1 & 2: WATCHLIST ALERTS STATE
  // --------------------------------------------------------------------------
  const [alerts, setAlerts] = useState<WatchlistAlert[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState<boolean>(false);

  // Filters for Live Hits (Tab 1)
  const [liveSearch, setLiveSearch] = useState<string>("");
  const [liveCamera, setLiveCamera] = useState<string>("");
  const [livePriority, setLivePriority] = useState<string>("");
  const [liveMatch, setLiveMatch] = useState<string>("");
  const [livePage, setLivePage] = useState<number>(1);
  const [livePageSize, setLivePageSize] = useState<number>(20);

  // Filters for Alerts History (Tab 2)
  const [histSearch, setHistSearch] = useState<string>("");
  const [histCamera, setHistCamera] = useState<string>("");
  const [histPriority, setHistPriority] = useState<string>("");
  const [histPage, setHistPage] = useState<number>(1);
  const [histPageSize, setHistPageSize] = useState<number>(25);

  const loadAlerts = useCallback(async () => {
    setLoadingAlerts(true);
    try {
      const res = await api<WatchlistAlert[]>("/api/alerts?open_only=false&limit=1000");
      setAlerts(Array.isArray(res) ? res : []);
    } catch (e: any) {
      toast(e.message || "Failed to load alerts", "err");
    } finally {
      setLoadingAlerts(false);
    }
  }, []);

  useEffect(() => {
    loadAlerts();
    const interval = setInterval(loadAlerts, 20000);
    return () => clearInterval(interval);
  }, [loadAlerts]);

  // Live WebSocket alert listener
  useWsMessage(
    "alert",
    useCallback(
      (m: any) => {
        // Prepend new alert to alerts list
        if (m && m.id) {
          setAlerts((prev) => [m, ...prev.filter((a) => a.id !== m.id)]);
        } else {
          loadAlerts();
        }

        const alertPlate = m?.plate || "Vehicle";
        const camLabel = camById[m?.camera_id]?.name || m?.camera_id || "Camera";
        toast(`🚨 Watchlist Alert: ${alertPlate} detected at ${camLabel}`, "err");

        if (audioSpeak) {
          speakAlertText(`Alert. Watchlist hit: plate ${alertPlate} on ${camLabel}`);
        }
      },
      [camById, audioSpeak, loadAlerts]
    )
  );

  // Acknowledge single alert
  const handleAckAlert = async (aid: string, plateStr: string) => {
    try {
      await api(`/api/alerts/${aid}/ack`, { method: "POST" });
      toast(`Alert acknowledged for vehicle ${plateStr}`, "ok");
      setAlerts((prev) =>
        prev.map((a) => (a.id === aid ? { ...a, ack_by: user?.username || "You", ack_at: new Date().toISOString() } : a))
      );
    } catch (e: any) {
      toast(e.message || "Failed to acknowledge alert", "err");
    }
  };

  // Acknowledge all open alerts
  const handleAckAllOpen = async () => {
    const openItems = alerts.filter((a) => !a.ack_by);
    if (openItems.length === 0) {
      toast("No open alerts to acknowledge", "warn");
      return;
    }

    try {
      await Promise.all(openItems.map((a) => api(`/api/alerts/${a.id}/ack`, { method: "POST" }).catch(() => {})));
      toast(`Successfully acknowledged ${openItems.length} open alerts`, "ok");
      loadAlerts();
    } catch {
      loadAlerts();
    }
  };

  // Filtered & Paginated Live Alerts (Tab 1: Open Only or all active)
  const openAlerts = useMemo(() => {
    return alerts.filter((a) => !a.ack_by);
  }, [alerts]);

  const filteredLiveAlerts = useMemo(() => {
    return openAlerts.filter((a) => {
      if (liveCamera && a.camera_id !== liveCamera) return false;
      if (livePriority && a.priority !== livePriority) return false;
      if (liveMatch && a.match !== liveMatch) return false;
      if (liveSearch) {
        const q = liveSearch.toUpperCase();
        const matchesPlate = a.plate.includes(q);
        const matchesWp = (a.watchlist_plate || "").includes(q);
        const matchesReason = (a.reason || "").toUpperCase().includes(q);
        if (!matchesPlate && !matchesWp && !matchesReason) return false;
      }
      return true;
    });
  }, [openAlerts, liveCamera, livePriority, liveMatch, liveSearch]);

  const pagedLiveAlerts = useMemo(() => {
    const start = (livePage - 1) * livePageSize;
    return filteredLiveAlerts.slice(start, start + livePageSize);
  }, [filteredLiveAlerts, livePage, livePageSize]);

  const totalLivePages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredLiveAlerts.length / livePageSize));
  }, [filteredLiveAlerts, livePageSize]);

  // Filtered & Paginated History Alerts (Tab 2: Acknowledged or all historical)
  const historyAlerts = useMemo(() => {
    return alerts.filter((a) => Boolean(a.ack_by));
  }, [alerts]);

  const filteredHistAlerts = useMemo(() => {
    return historyAlerts.filter((a) => {
      if (histCamera && a.camera_id !== histCamera) return false;
      if (histPriority && a.priority !== histPriority) return false;
      if (histSearch) {
        const q = histSearch.toUpperCase();
        const matchesPlate = a.plate.includes(q);
        const matchesWp = (a.watchlist_plate || "").includes(q);
        const matchesReason = (a.reason || "").toUpperCase().includes(q);
        const matchesUser = (a.ack_by || "").toUpperCase().includes(q);
        if (!matchesPlate && !matchesWp && !matchesReason && !matchesUser) return false;
      }
      return true;
    });
  }, [historyAlerts, histCamera, histPriority, histSearch]);

  const pagedHistAlerts = useMemo(() => {
    const start = (histPage - 1) * histPageSize;
    return filteredHistAlerts.slice(start, start + histPageSize);
  }, [filteredHistAlerts, histPage, histPageSize]);

  const totalHistPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredHistAlerts.length / histPageSize));
  }, [filteredHistAlerts, histPageSize]);

  // --------------------------------------------------------------------------
  // TAB 3: ZONE & PERIMETER INCIDENTS STATE
  // --------------------------------------------------------------------------
  const [incidents, setIncidents] = useState<ZoneIncident[]>([]);
  const [loadingIncidents, setLoadingIncidents] = useState<boolean>(false);
  const [incFilterOpen, setIncFilterOpen] = useState<boolean>(true);
  const [incFilterKind, setIncFilterKind] = useState<string>("");
  const [incFilterCamera, setIncFilterCamera] = useState<string>("");
  const [incPage, setIncPage] = useState<number>(1);
  const [incPageSize, setIncPageSize] = useState<number>(20);

  const loadIncidents = useCallback(async () => {
    setLoadingIncidents(true);
    try {
      const q = new URLSearchParams();
      if (incFilterOpen) q.set("open_only", "true");
      if (incFilterKind) q.set("kind", incFilterKind);
      if (incFilterCamera) q.set("camera", incFilterCamera);
      q.set("limit", "500");

      const res = await api<ZoneIncident[]>(`/api/incidents?${q.toString()}`);
      setIncidents(Array.isArray(res) ? res : []);
      setIncPage(1);
    } catch (e: any) {
      toast(e.message || "Failed to load incidents", "err");
      setIncidents([]);
    } finally {
      setLoadingIncidents(false);
    }
  }, [incFilterOpen, incFilterKind, incFilterCamera]);

  useEffect(() => {
    if (tab === "incidents") {
      loadIncidents();
    }
  }, [tab, loadIncidents]);

  const handleAckIncident = async (iid: string) => {
    try {
      await api(`/api/incidents/${iid}/ack`, { method: "POST" });
      toast("Incident marked as acknowledged", "ok");
      setIncidents((prev) =>
        prev.map((i) => (i.id === iid ? { ...i, status: "ack", ack_by: user?.username || "You" } : i))
      );
    } catch (e: any) {
      toast(e.message || "Failed to acknowledge incident", "err");
    }
  };

  const pagedIncidents = useMemo(() => {
    const start = (incPage - 1) * incPageSize;
    return incidents.slice(start, start + incPageSize);
  }, [incidents, incPage, incPageSize]);

  const totalIncPages = useMemo(() => {
    return Math.max(1, Math.ceil(incidents.length / incPageSize));
  }, [incidents, incPageSize]);

  // --------------------------------------------------------------------------
  // TAB 4: DISPATCH & NOTIFICATION ROUTES STATE
  // --------------------------------------------------------------------------
  const [routes, setRoutes] = useState<NotificationRoute[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState<boolean>(false);

  const loadRoutes = useCallback(async () => {
    setLoadingRoutes(true);
    try {
      const res = await api<{ routes: NotificationRoute[] }>("/api/admin/notifications/routes");
      setRoutes(res.routes || []);
    } catch {
      // Default fallback routes
      setRoutes([
        { kind: "alert", priority: "high", subkind: "exact", channel: "control_room", to: ["supervisor", "dispatch"], enabled: true },
        { kind: "alert", priority: "medium", subkind: "fuzzy", channel: "operator_desk", to: ["operator"], enabled: true },
        { kind: "incident", priority: "high", subkind: "perimeter", channel: "security_patrol", to: ["patrol_alpha"], enabled: true },
      ]);
    } finally {
      setLoadingRoutes(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "dispatch") {
      loadRoutes();
    }
  }, [tab, loadRoutes]);

  // --------------------------------------------------------------------------
  // MODALS STATE
  // --------------------------------------------------------------------------
  // 1. Preview Crop & Frame Modal
  const [previewAlert, setPreviewAlert] = useState<WatchlistAlert | null>(null);

  // 2. File into Case Modal
  const [caseTargetAlert, setCaseTargetAlert] = useState<WatchlistAlert | null>(null);
  const [caseList, setCaseList] = useState<CaseOption[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");
  const [caseNote, setCaseNote] = useState<string>("");
  const [savingCaseItem, setSavingCaseItem] = useState<boolean>(false);

  const openCaseModal = async (a: WatchlistAlert) => {
    setCaseTargetAlert(a);
    setCaseNote(`Watchlist hit for vehicle ${a.plate} on camera ${camById[a.camera_id]?.name || a.camera_id}`);
    try {
      const res = await api<{ cases: CaseOption[] }>("/api/cases?mine=false");
      const list = res.cases || [];
      setCaseList(list);
      if (list.length > 0 && !selectedCaseId) {
        setSelectedCaseId(list[0].id);
      }
    } catch {}
  };

  const handleSaveCaseItem = async () => {
    if (!caseTargetAlert || !selectedCaseId) {
      toast("Please select an investigation case", "warn");
      return;
    }

    setSavingCaseItem(true);
    try {
      await api(`/api/cases/${selectedCaseId}/items`, {
        method: "POST",
        body: JSON.stringify({
          kind: "event",
          ref_id: caseTargetAlert.event_id || caseTargetAlert.id,
          note: caseNote,
        }),
      });
      toast("Alert sighting successfully filed into investigation dossier", "ok");
      setCaseTargetAlert(null);
    } catch (e: any) {
      toast(e.message || "Failed to file alert into case", "err");
    } finally {
      setSavingCaseItem(false);
    }
  };

  // KPI calculations
  const kpiStats = useMemo(() => {
    const openCount = openAlerts.length;
    const ackCount = historyAlerts.length;
    const highCount = alerts.filter((a) => a.priority === "high" || a.priority === "critical").length;
    const incidentsCount = incidents.filter((i) => i.status === "open").length;

    return {
      openCount,
      ackCount,
      highCount,
      incidentsCount,
    };
  }, [openAlerts, historyAlerts, alerts, incidents]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header Action Row */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: 26, height: 26, color: "#ef4444" }}>
                  <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
                  <path d="M10 20a2 2 0 0 0 4 0" />
                </svg>
                Security Alerts & Incident Console
              </h2>
              <p className="perm-subtitle">
                Real-time watchlist plate detections, perimeter zone alarms, automated acoustic speech announcements, and multi-channel dispatch
              </p>
            </div>

            <div className="perm-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* Audio Speech Toggle Button */}
              <button
                type="button"
                className={`btn small ${audioSpeak ? "primary" : "ghost"}`}
                onClick={toggleAudioSpeak}
                title={audioSpeak ? "Speech synthesizer is active: announcements are spoken" : "Enable spoken audio alert announcer"}
                style={audioSpeak ? { background: "#10b981", borderColor: "#10b981", color: "#fff" } : undefined}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  {audioSpeak ? (
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  ) : (
                    <line x1="23" y1="9" x2="17" y2="15" />
                  )}
                </svg>
                {audioSpeak ? "Audio Announcer: ON" : "Audio Announcer: OFF"}
              </button>

              {canAck && openAlerts.length > 0 && tab === "live" && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={handleAckAllOpen}
                  title="Acknowledge all pending open alerts at once"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Acknowledge All ({openAlerts.length})
                </button>
              )}

              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  loadAlerts();
                  if (tab === "incidents") loadIncidents();
                  if (tab === "dispatch") loadRoutes();
                }}
                disabled={loadingAlerts}
                title="Refresh alerts immediately"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Refresh
              </button>
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid" style={{ marginBottom: 16 }}>
            {/* Open Watchlist Alerts */}
            <div className="perm-kpi-card" title="Active watchlist alarms requiring officer acknowledgement">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(239, 68, 68, 0.12)", color: "#ef4444" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
                  <path d="M10 20a2 2 0 0 0 4 0" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Open Alerts</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ color: kpiStats.openCount > 0 ? "#ef4444" : undefined }}>
                    {kpiStats.openCount}
                  </span>
                  {kpiStats.openCount > 0 && <span className="kpi-sub-pill sober-pill" style={{ color: "#ef4444" }}>Pending</span>}
                </div>
                <span className="kpi-desc">Awaiting operator disposition</span>
              </div>
            </div>

            {/* Acknowledged History */}
            <div className="perm-kpi-card" title="Total acknowledged and handled security alarms">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Handled & Logged</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.ackCount}</span>
                </div>
                <span className="kpi-desc">Acknowledged records in history</span>
              </div>
            </div>

            {/* High & Critical Hits */}
            <div className="perm-kpi-card" title="High and critical priority hits">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">High Priority</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.highCount}</span>
                </div>
                <span className="kpi-desc">Severe hotlist matches</span>
              </div>
            </div>

            {/* Zone Security Incidents */}
            <div className="perm-kpi-card" title="Zone alarms such as perimeter breaches, wrong-way, speed">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Zone Incidents</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.incidentsCount}</span>
                </div>
                <span className="kpi-desc">Automated AI perimeter alarms</span>
              </div>
            </div>

            {/* Audio Dispatch Announcer */}
            <div className="perm-kpi-card" title="Live speech synthesis audio alert status">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: audioSpeak ? "rgba(16, 185, 129, 0.12)" : "rgba(148, 163, 184, 0.12)",
                  color: audioSpeak ? "#10b981" : "#94a3b8",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Speech Dispatch</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ fontSize: 18, color: audioSpeak ? "#10b981" : undefined }}>
                    {audioSpeak ? "Voice Active" : "Disabled"}
                  </span>
                </div>
                <span className="kpi-desc">Acoustic control-room speech</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            {ALERTS_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`admin-tab-item ${tab === sec.tabKey ? "active" : ""}`}
                onClick={() => handleTabChange(sec.tabKey)}
                role="tab"
              >
                {sec.iconName === "live" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                )}
                {sec.iconName === "history" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
                {sec.iconName === "incidents" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                )}
                {sec.iconName === "dispatch" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
                <span className="tab-label">{sec.label}</span>
                {sec.id === "live" && openAlerts.length > 0 && (
                  <span
                    style={{
                      background: "#ef4444",
                      color: "#fff",
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: 10,
                      marginLeft: 4,
                    }}
                  >
                    {openAlerts.length}
                  </span>
                )}
                {tab === sec.tabKey && <span className="tab-active-indicator" />}
              </button>
            ))}
          </div>

          {/* ========================================================================= */}
          {/* TAB 1: LIVE WATCHLIST HITS */}
          {/* ========================================================================= */}
          {tab === "live" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Search Plate / Reason</span>
                    <input
                      placeholder="e.g. MH12AB1234, FIR 123…"
                      value={liveSearch}
                      onChange={(e) => {
                        setLiveSearch(e.target.value);
                        setLivePage(1);
                      }}
                      style={{ textTransform: "uppercase", fontSize: 12 }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Camera Location</span>
                    <select
                      value={liveCamera}
                      onChange={(e) => {
                        setLiveCamera(e.target.value);
                        setLivePage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All cameras ({cameras.length})</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.department ? `(${c.department})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Priority</span>
                    <select
                      value={livePriority}
                      onChange={(e) => {
                        setLivePriority(e.target.value);
                        setLivePage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All priorities</option>
                      <option value="high">High priority</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Match Type</span>
                    <select
                      value={liveMatch}
                      onChange={(e) => {
                        setLiveMatch(e.target.value);
                        setLivePage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All matches</option>
                      <option value="exact">Exact match</option>
                      <option value="fuzzy">Fuzzy match</option>
                      <option value="wildcard">Wildcard</option>
                    </select>
                  </label>

                  {(liveSearch || liveCamera || livePriority || liveMatch) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        setLiveSearch("");
                        setLiveCamera("");
                        setLivePriority("");
                        setLiveMatch("");
                        setLivePage(1);
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              </div>

              {/* Live Alerts Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {loadingAlerts ? (
                      "Loading live alerts…"
                    ) : filteredLiveAlerts.length > 0 ? (
                      `${filteredLiveAlerts.length} active open alerts`
                    ) : (
                      "No active watchlist alerts"
                    )}
                  </h3>
                  <span className="small muted">
                    Showing page {livePage} of {totalLivePages} ({filteredLiveAlerts.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>Time (IST)</th>
                        <th style={{ width: 120 }}>Plate Read</th>
                        <th style={{ width: 80 }}>Crop</th>
                        <th>Watchlist Target</th>
                        <th style={{ width: 90 }}>Match</th>
                        <th>Camera & Dept</th>
                        <th>Reason / Incident Note</th>
                        <th style={{ width: 85 }}>Priority</th>
                        <th style={{ textAlign: "right", minWidth: 160 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedLiveAlerts.length > 0 ? (
                        pagedLiveAlerts.map((a) => {
                          const camName = camById[a.camera_id]?.name || a.camera_id;
                          const isHigh = a.priority === "high" || a.priority === "critical";

                          return (
                            <tr key={a.id} style={isHigh ? { background: "rgba(239, 68, 68, 0.04)" } : undefined}>
                              {/* Time */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{fmtTime(a.ts)}</span>
                              </td>

                              {/* Plate Pill */}
                              <td>
                                <span
                                  className="platebox plate"
                                  onClick={() => navigate(`/movement?plate=${encodeURIComponent(a.plate)}`)}
                                  title="Click to trace vehicle route movements"
                                  style={{ fontFamily: "monospace", fontWeight: 700, cursor: "pointer" }}
                                >
                                  {a.plate}
                                </span>
                              </td>

                              {/* Crop Image */}
                              <td>
                                {a.crop_url ? (
                                  <img
                                    className="crop"
                                    src={withTok(a.crop_url)}
                                    alt="Plate"
                                    onClick={() => setPreviewAlert(a)}
                                    style={{ height: 28, borderRadius: 4, cursor: "zoom-in", border: "1px solid var(--line)" }}
                                  />
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Target Plate */}
                              <td>
                                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>
                                  {a.watchlist_plate || a.plate}
                                </span>
                              </td>

                              {/* Match Type */}
                              <td>
                                <span
                                  className={`tagchip ${a.match === "exact" ? "watchlist" : ""}`}
                                  style={{ textTransform: "capitalize" }}
                                >
                                  {a.match || "match"}
                                </span>
                              </td>

                              {/* Camera & Dept */}
                              <td>
                                <div style={{ fontWeight: 500 }}>{camName}</div>
                                {a.department && (
                                  <span className={`dept-${a.department}`} style={{ fontSize: 11 }}>
                                    {a.department}
                                  </span>
                                )}
                              </td>

                              {/* Reason */}
                              <td>
                                <span style={{ fontSize: 12 }}>{formatDetail(a.reason) || "Monitored hotlist plate"}</span>
                              </td>

                              {/* Priority Chip */}
                              <td>
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    textTransform: "uppercase",
                                    padding: "2px 6px",
                                    borderRadius: 4,
                                    background: isHigh ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)",
                                    color: isHigh ? "#ef4444" : "#f59e0b",
                                  }}
                                >
                                  {a.priority || "normal"}
                                </span>
                              </td>

                              {/* Actions */}
                              <td style={{ textAlign: "right" }}>
                                <div style={{ display: "inline-flex", gap: 6 }}>
                                  {canAck && (
                                    <button
                                      type="button"
                                      className="btn primary small"
                                      onClick={() => handleAckAlert(a.id, a.plate)}
                                      title="Acknowledge this alert hit"
                                    >
                                      Acknowledge
                                    </button>
                                  )}

                                  {canCases && (
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      onClick={() => openCaseModal(a)}
                                      title="File this sighting into an investigation case"
                                    >
                                      + Case
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "36px 16px" }}>
                            {loadingAlerts
                              ? "Checking for live security alerts…"
                              : "No open watchlist alerts! All triggers have been acknowledged."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={livePage}
                    pages={totalLivePages}
                    total={filteredLiveAlerts.length}
                    onPage={setLivePage}
                    size={livePageSize}
                    onSize={setLivePageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 2: ALERTS HISTORY & LOG */}
          {/* ========================================================================= */}
          {tab === "history" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Search Plate / Officer</span>
                    <input
                      placeholder="Filter history records…"
                      value={histSearch}
                      onChange={(e) => {
                        setHistSearch(e.target.value);
                        setHistPage(1);
                      }}
                      style={{ textTransform: "uppercase", fontSize: 12 }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Camera Location</span>
                    <select
                      value={histCamera}
                      onChange={(e) => {
                        setHistCamera(e.target.value);
                        setHistPage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All cameras</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.department ? `(${c.department})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Priority</span>
                    <select
                      value={histPriority}
                      onChange={(e) => {
                        setHistPriority(e.target.value);
                        setHistPage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All priorities</option>
                      <option value="high">High priority</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>

                  {(histSearch || histCamera || histPriority) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        setHistSearch("");
                        setHistCamera("");
                        setHistPriority("");
                        setHistPage(1);
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              </div>

              {/* History Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {filteredHistAlerts.length} Historical Acknowledged Records
                  </h3>
                  <span className="small muted">
                    Showing page {histPage} of {totalHistPages} ({filteredHistAlerts.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>Time (IST)</th>
                        <th style={{ width: 120 }}>Plate</th>
                        <th style={{ width: 80 }}>Crop</th>
                        <th>Target Plate</th>
                        <th>Camera Location</th>
                        <th>Reason</th>
                        <th style={{ width: 80 }}>Priority</th>
                        <th>Acknowledged By</th>
                        <th style={{ textAlign: "right", minWidth: 120 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedHistAlerts.length > 0 ? (
                        pagedHistAlerts.map((a) => {
                          const camName = camById[a.camera_id]?.name || a.camera_id;
                          return (
                            <tr key={a.id}>
                              {/* Time */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{fmtTime(a.ts)}</span>
                              </td>

                              {/* Plate */}
                              <td>
                                <span
                                  className="platebox plate"
                                  onClick={() => navigate(`/movement?plate=${encodeURIComponent(a.plate)}`)}
                                  title="Trace route"
                                  style={{ fontFamily: "monospace", fontWeight: 700 }}
                                >
                                  {a.plate}
                                </span>
                              </td>

                              {/* Crop */}
                              <td>
                                {a.crop_url ? (
                                  <img
                                    className="crop"
                                    src={withTok(a.crop_url)}
                                    alt="Plate"
                                    onClick={() => setPreviewAlert(a)}
                                    style={{ height: 28, borderRadius: 4, cursor: "zoom-in", border: "1px solid var(--line)" }}
                                  />
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Target Plate */}
                              <td>
                                <span style={{ fontFamily: "monospace" }}>{a.watchlist_plate || a.plate}</span>
                              </td>

                              {/* Camera */}
                              <td>
                                <div style={{ fontWeight: 500 }}>{camName}</div>
                                {a.department && <span className={`dept-${a.department}`} style={{ fontSize: 11 }}>{a.department}</span>}
                              </td>

                              {/* Reason */}
                              <td>
                                <span style={{ fontSize: 12 }}>{formatDetail(a.reason) || "—"}</span>
                              </td>

                              {/* Priority */}
                              <td>
                                <span style={{ fontSize: 11, fontWeight: 600, textTransform: "capitalize" }}>
                                  {a.priority || "normal"}
                                </span>
                              </td>

                              {/* Acknowledged By */}
                              <td>
                                <span style={{ fontSize: 12, fontWeight: 500, color: "#10b981" }}>
                                  ✓ {a.ack_by || "Acknowledged"}
                                </span>
                              </td>

                              {/* Actions */}
                              <td style={{ textAlign: "right" }}>
                                {canCases && (
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => openCaseModal(a)}
                                    title="Add to investigation case"
                                  >
                                    + Case
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "32px 16px" }}>
                            No acknowledged historical alert records found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* History Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={histPage}
                    pages={totalHistPages}
                    total={filteredHistAlerts.length}
                    onPage={setHistPage}
                    size={histPageSize}
                    onSize={setHistPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 3: ZONE & PERIMETER INCIDENTS */}
          {/* ========================================================================= */}
          {tab === "incidents" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label className="check" style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={incFilterOpen}
                      onChange={(e) => setIncFilterOpen(e.target.checked)}
                    />
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Open incidents only</span>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Incident Kind</span>
                    <select value={incFilterKind} onChange={(e) => setIncFilterKind(e.target.value)} style={{ fontSize: 12 }}>
                      <option value="">All incident kinds</option>
                      <option value="wrong_way">wrong_way</option>
                      <option value="over_speed">over_speed</option>
                      <option value="red_light">red_light</option>
                      <option value="loitering">loitering</option>
                      <option value="perimeter_breach">perimeter_breach</option>
                      <option value="person_match">person_match</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Camera</span>
                    <select value={incFilterCamera} onChange={(e) => setIncFilterCamera(e.target.value)} style={{ fontSize: 12 }}>
                      <option value="">All cameras</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="btn primary small"
                    onClick={loadIncidents}
                    disabled={loadingIncidents}
                  >
                    Apply Filters
                  </button>
                </div>
              </div>

              {/* Incidents Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {loadingIncidents ? "Loading incidents…" : `${incidents.length} security zone alarms`}
                  </h3>
                  <span className="small muted">
                    Showing page {incPage} of {totalIncPages} ({incidents.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>Time (IST)</th>
                        <th style={{ width: 130 }}>Kind</th>
                        <th>Zone / Perimeter</th>
                        <th>Camera</th>
                        <th style={{ width: 120 }}>Plate</th>
                        <th>Detail</th>
                        <th style={{ width: 90 }}>Status</th>
                        <th style={{ textAlign: "right", minWidth: 120 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedIncidents.length > 0 ? (
                        pagedIncidents.map((inc) => {
                          const camName = camById[inc.camera_id]?.name || inc.camera_id;
                          const isOpen = inc.status === "open";

                          return (
                            <tr key={inc.id}>
                              {/* Time */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{fmtTime(inc.ts)}</span>
                              </td>

                              {/* Kind */}
                              <td>
                                <span className={`tagchip ${isOpen ? "watchlist" : ""}`} style={{ fontWeight: 600 }}>
                                  {inc.kind}
                                </span>
                              </td>

                              {/* Zone */}
                              <td>
                                <b>{formatZone(inc.zone)}</b>
                              </td>

                              {/* Camera */}
                              <td>
                                <span>{camName}</span>
                              </td>

                              {/* Plate */}
                              <td>
                                {inc.plate ? (
                                  <span className="platebox plate" style={{ fontFamily: "monospace", fontSize: 11 }}>
                                    {typeof inc.plate === "object" ? JSON.stringify(inc.plate) : inc.plate}
                                  </span>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Detail */}
                              <td>
                                <span style={{ fontSize: 12 }}>{formatDetail(inc.detail)}</span>
                              </td>

                              {/* Status */}
                              <td>
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: isOpen ? "#ef4444" : "#10b981",
                                    textTransform: "uppercase",
                                  }}
                                >
                                  {inc.status}
                                </span>
                              </td>

                              {/* Action */}
                              <td style={{ textAlign: "right" }}>
                                {canAck && isOpen && (
                                  <button
                                    type="button"
                                    className="btn primary small"
                                    onClick={() => handleAckIncident(inc.id)}
                                    title="Acknowledge incident"
                                  >
                                    Acknowledge
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={8} className="muted" style={{ textAlign: "center", padding: "32px 16px" }}>
                            {loadingIncidents ? "Loading zone alarms…" : "No zone alarms matching criteria."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Incidents Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={incPage}
                    pages={totalIncPages}
                    total={incidents.length}
                    onPage={setIncPage}
                    size={incPageSize}
                    onSize={setIncPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: DISPATCH & ESCALATION RULES */}
          {/* ========================================================================= */}
          {tab === "dispatch" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Audio Announcer Settings Card */}
              <div className="panel" style={{ padding: "20px 24px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 14 }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Acoustic Alert Announcer (Speech Synthesis)</h3>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    Synthesizes clear voice announcements over control-room speakers when watchlist plates and security breaches trigger in real time.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8 }}>
                  <button
                    type="button"
                    className={`btn ${audioSpeak ? "primary" : "ghost"}`}
                    onClick={toggleAudioSpeak}
                    style={audioSpeak ? { background: "#10b981", borderColor: "#10b981", color: "#fff" } : undefined}
                  >
                    {audioSpeak ? "Speech Announcer Active (Click to Mute)" : "Enable Speech Announcer"}
                  </button>

                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => speakAlertText("Testing alert broadcast audio. Unified CCTV alert system operational.")}
                  >
                    Test Voice Broadcast
                  </button>
                </div>
              </div>

              {/* Notification Routing Policies */}
              <div className="panel" style={{ padding: "20px 24px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Automated Escalation & Dispatch Routing</h3>
                    <p className="small muted" style={{ marginTop: 4 }}>
                      Target channels (SMS, Telegram, Email, Webhooks, Desktop Notifications) receiving immediate alerts.
                    </p>
                  </div>
                  <button type="button" className="btn ghost small" onClick={loadRoutes} disabled={loadingRoutes}>
                    {loadingRoutes ? "Loading…" : "Refresh Rules"}
                  </button>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Event Kind</th>
                        <th>Priority Trigger</th>
                        <th>Sub-kind Match</th>
                        <th>Channel Target</th>
                        <th>Recipients / Roles</th>
                        <th style={{ width: 80 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routes.map((r, i) => (
                        <tr key={i}>
                          <td>
                            <b style={{ textTransform: "capitalize" }}>{r.kind}</b>
                          </td>
                          <td>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: "uppercase",
                                color: r.priority === "high" ? "#ef4444" : "#f59e0b",
                              }}
                            >
                              {r.priority}
                            </span>
                          </td>
                          <td>{r.subkind || "*"}</td>
                          <td>
                            <code>{r.channel}</code>
                          </td>
                          <td>
                            <span>{(r.to || []).join(", ") || "All officers"}</span>
                          </td>
                          <td>
                            <span style={{ color: r.enabled ? "#10b981" : "#94a3b8", fontWeight: 700, fontSize: 11 }}>
                              {r.enabled ? "ACTIVE" : "OFF"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="small muted" style={{ marginTop: 14 }}>
                  Notification connectors and webhook URLs can also be configured under <a href="/admin/integrations">Admin → Integrations</a>.
                </p>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* MODAL 1: CROP & FULL FRAME PREVIEW */}
          {/* ========================================================================= */}
          <Modal open={Boolean(previewAlert)} onClose={() => setPreviewAlert(null)} wide>
            {previewAlert && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
                    Watchlist Hit Snapshot:
                    <span className="platebox plate" style={{ fontFamily: "monospace", fontWeight: 700 }}>
                      {previewAlert.plate}
                    </span>
                  </h3>
                  <button type="button" className="btn ghost small" onClick={() => setPreviewAlert(null)}>
                    Close
                  </button>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    minHeight: 280,
                    background: "#0f172a",
                    borderRadius: 8,
                    overflow: "hidden",
                    marginBottom: 14,
                  }}
                >
                  {previewAlert.crop_url ? (
                    <img
                      src={withTok(previewAlert.crop_url)}
                      alt="Crop"
                      style={{ maxWidth: "100%", maxHeight: "55vh", objectFit: "contain", transform: "scale(1.15)" }}
                    />
                  ) : (
                    <span className="muted">No media snapshot stored</span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, fontSize: 12 }}>
                  <div>
                    <span className="muted">Captured:</span> <b>{fmtTime(previewAlert.ts)}</b>
                  </div>
                  <div>
                    <span className="muted">Camera:</span> <b>{camById[previewAlert.camera_id]?.name || previewAlert.camera_id}</b>
                  </div>
                  <div>
                    <span className="muted">Target:</span> <b>{previewAlert.watchlist_plate || previewAlert.plate}</b>
                  </div>
                  <div>
                    <span className="muted">Reason:</span> <b>{previewAlert.reason || "Hotlist vehicle"}</b>
                  </div>
                </div>
              </div>
            )}
          </Modal>

          {/* ========================================================================= */}
          {/* MODAL 2: FILE ALERT INTO CASE */}
          {/* ========================================================================= */}
          <Modal open={Boolean(caseTargetAlert)} onClose={() => setCaseTargetAlert(null)}>
            {caseTargetAlert && (
              <div>
                <h3 style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                  File Alert Hit into Investigation Case
                </h3>

                <p className="small muted" style={{ marginBottom: 14 }}>
                  Add watchlist hit for vehicle <b style={{ fontFamily: "monospace" }}>{caseTargetAlert.plate}</b> to an active case dossier evidence chain.
                </p>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSaveCaseItem();
                  }}
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Target Case</span>
                    <select
                      value={selectedCaseId}
                      onChange={(e) => setSelectedCaseId(e.target.value)}
                    >
                      {caseList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.number} · {c.title}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Evidence Note</span>
                    <textarea
                      rows={3}
                      value={caseNote}
                      onChange={(e) => setCaseNote(e.target.value)}
                      placeholder="Why this sighting matters to the case…"
                      style={{ fontSize: 13, padding: 8, borderRadius: 6, border: "1px solid var(--line)" }}
                    />
                  </label>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn ghost" onClick={() => setCaseTargetAlert(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn primary" disabled={savingCaseItem || !selectedCaseId}>
                      {savingCaseItem ? "Filing…" : "Add Evidence to Case"}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </Modal>
        </div>
      </section>
    </main>
  );
}
