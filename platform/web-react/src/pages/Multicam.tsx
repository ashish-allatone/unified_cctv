import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface MulticamSectionItem {
  id: string;
  tabKey: "cross-camera" | "route-trace" | "corridors" | "matrix";
  label: string;
  desc: string;
  iconName: "cross-camera" | "route-trace" | "corridors" | "matrix";
}

export const MULTICAM_SECTIONS: MulticamSectionItem[] = [
  {
    id: "cross-camera",
    tabKey: "cross-camera",
    label: "Cross-Camera Sightings",
    desc: "Vehicles detected across multiple cameras with route progression",
    iconName: "cross-camera",
  },
  {
    id: "route-trace",
    tabKey: "route-trace",
    label: "Vehicle Route Trace",
    desc: "Interactive map tracing, transit vectors, and chronological timeline",
    iconName: "route-trace",
  },
  {
    id: "corridors",
    tabKey: "corridors",
    label: "Corridor & Transit Times",
    desc: "Point-to-point transit duration, speed analysis, and route anomalies",
    iconName: "corridors",
  },
  {
    id: "matrix",
    tabKey: "matrix",
    label: "Multi-Camera Grid",
    desc: "Synchronized live monitoring grid across key checkpoints and gates",
    iconName: "matrix",
  },
];

export interface CameraItem {
  id: string;
  name: string;
  department?: string;
  lat?: number | null;
  lon?: number | null;
  status?: string;
  anpr_enabled?: boolean;
}

export interface RouteCamera {
  id?: string;
  name: string;
  department: string;
  sightings: number;
  first: string;
  last?: string;
}

export interface MultiCameraVehicle {
  plate: string;
  camera_count: number;
  cameras: RouteCamera[];
  first_seen: string;
  last_seen: string;
  span_min: number;
  sightings: number;
  plate_masked?: boolean;
}

export interface MultiCameraResponse {
  items: MultiCameraVehicle[];
  total: number;
  min_cameras: number;
  since: string;
  until: string;
  truncated?: boolean;
}

export interface RouteSighting {
  camera_name: string;
  department: string;
  ts: string;
  direction: string;
  confidence: number;
  plate: string;
  crop_url?: string;
  frame_url?: string;
  lat?: number | null;
  lon?: number | null;
}

export interface RouteTraceResult {
  plate: string;
  sightings: RouteSighting[];
  cameras: string[];
  departments: string[];
}

export interface OpenCaseOption {
  id: string;
  number: string;
  title: string;
}

const padZ = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${padZ(d.getMonth() + 1)}-${padZ(d.getDate())}T${padZ(d.getHours())}:${padZ(d.getMinutes())}`;
const formatSpan = (m: number) => {
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
};

export default function Multicam() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();
  const canExport = has("export");
  const canCases = has("cases");

  // Tab state mapping
  const tabFromSection = useMemo<"cross-camera" | "route-trace" | "corridors" | "matrix">(() => {
    if (!section || section === "cross-camera" || section === "vehicles" || section === "sightings") return "cross-camera";
    if (section === "route-trace" || section === "trace" || section === "route") return "route-trace";
    if (section === "corridors" || section === "transit" || section === "speed") return "corridors";
    if (section === "matrix" || section === "grid" || section === "live") return "matrix";
    return "cross-camera";
  }, [section]);

  const [tab, setTab] = useState<"cross-camera" | "route-trace" | "corridors" | "matrix">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "cross-camera" | "route-trace" | "corridors" | "matrix") => {
    setTab(nextTab);
    navigate(`/multicam/${nextTab}`);
  };

  // Cameras List
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

  // --------------------------------------------------------------------------
  // TAB 1: CROSS-CAMERA VEHICLES STATE
  // --------------------------------------------------------------------------
  const [preset, setPreset] = useState("24h");
  const [yearVal, setYearVal] = useState(new Date().getFullYear());
  const [sinceTime, setSinceTime] = useState<string>(() => {
    const d = new Date(Date.now() - 24 * 3600 * 1000);
    return toLocalInput(d);
  });
  const [untilTime, setUntilTime] = useState<string>(() => toLocalInput(new Date()));
  const [minCameras, setMinCameras] = useState(2);
  const [vehicleType, setVehicleType] = useState("");
  const [plateQuery, setPlateQuery] = useState("");
  const [selectedCamIds, setSelectedCamIds] = useState<string[]>([]);

  // Results
  const [multiResult, setMultiResult] = useState<MultiCameraResponse | null>(null);
  const [loadingMulti, setLoadingMulti] = useState(false);
  const [multiPage, setMultiPage] = useState(1);
  const [multiPageSize, setMultiPageSize] = useState(25);

  // Handle Preset Changes
  const applyPreset = (v: string, yr: number = yearVal) => {
    setPreset(v);
    const now = new Date();
    let lo = now;
    let hi = now;

    if (v === "24h") lo = new Date(now.getTime() - 24 * 3600 * 1000);
    else if (v === "7d") lo = new Date(now.getTime() - 7 * 86400 * 1000);
    else if (v === "30d") lo = new Date(now.getTime() - 30 * 86400 * 1000);
    else if (v === "90d") lo = new Date(now.getTime() - 90 * 86400 * 1000);
    else if (v === "ytd") lo = new Date(now.getFullYear(), 0, 1);
    else if (v === "lastyear") {
      lo = new Date(now.getFullYear() - 1, 0, 1);
      hi = new Date(now.getFullYear(), 0, 1);
    } else if (v === "year") {
      lo = new Date(yr, 0, 1);
      hi = yr === now.getFullYear() ? now : new Date(yr + 1, 0, 1);
    } else {
      return; // custom
    }

    setSinceTime(toLocalInput(lo));
    setUntilTime(toLocalInput(hi));
  };

  const fetchMultiCameraVehicles = useCallback(async () => {
    setLoadingMulti(true);
    try {
      const q = new URLSearchParams();
      q.set("min_cameras", String(minCameras));
      q.set("limit", "500");
      if (sinceTime) q.set("since", new Date(sinceTime).toISOString());
      if (untilTime) q.set("until", new Date(untilTime).toISOString());
      if (selectedCamIds.length > 0) q.set("cameras", selectedCamIds.join(","));
      if (vehicleType) q.set("vehicle_type", vehicleType);
      if (plateQuery.trim()) q.set("plate", plateQuery.trim());

      const data = await api<MultiCameraResponse>(`/api/vehicles/multi-camera?${q.toString()}`);
      setMultiResult(data);
      setMultiPage(1);
    } catch (e: any) {
      toast(e.message || "Failed to load multi-camera vehicles", "err");
      setMultiResult(null);
    } finally {
      setLoadingMulti(false);
    }
  }, [minCameras, sinceTime, untilTime, selectedCamIds, vehicleType, plateQuery]);

  // Initial Load for Cross-Camera
  useEffect(() => {
    fetchMultiCameraVehicles();
  }, [fetchMultiCameraVehicles]);

  // Paginated Multi-Camera Items
  const pagedMultiItems = useMemo(() => {
    if (!multiResult?.items) return [];
    const start = (multiPage - 1) * multiPageSize;
    return multiResult.items.slice(start, start + multiPageSize);
  }, [multiResult, multiPage, multiPageSize]);

  const multiTotalPages = useMemo(() => {
    if (!multiResult?.items) return 1;
    return Math.max(1, Math.ceil(multiResult.items.length / multiPageSize));
  }, [multiResult, multiPageSize]);

  // CSV Export
  const handleExportCsv = () => {
    if (!multiResult?.items || multiResult.items.length === 0) {
      toast("No data available to export", "warn");
      return;
    }
    const header = ["plate", "cameras_count", "route_cameras", "first_seen", "last_seen", "span_min", "sightings"];
    const rows = multiResult.items.map((x) => [
      x.plate,
      x.camera_count,
      x.cameras.map((c) => `${c.name} (${c.department})`).join(" > "),
      x.first_seen,
      x.last_seen,
      x.span_min,
      x.sightings,
    ]);

    const csvContent = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `multicam-vehicles-${sinceTime.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast("CSV export generated successfully", "ok");
  };

  // --------------------------------------------------------------------------
  // TAB 2: ROUTE TRACE STATE
  // --------------------------------------------------------------------------
  const [tracePlateInput, setTracePlateInput] = useState("");
  const [traceFuzzy, setTraceFuzzy] = useState(false);
  const [traceSince, setTraceSince] = useState("");
  const [traceResult, setTraceResult] = useState<RouteTraceResult | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);

  const runTrace = useCallback(async (plateToTrace?: string) => {
    const targetPlate = (plateToTrace || tracePlateInput).trim();
    if (!targetPlate) {
      toast("Please enter a vehicle license plate to trace", "warn");
      return;
    }

    setLoadingTrace(true);
    try {
      const q = new URLSearchParams();
      q.set("fuzzy", traceFuzzy ? "true" : "false");
      if (traceSince) q.set("since", new Date(traceSince).toISOString());

      const res = await api<RouteTraceResult>(
        `/api/vehicles/${encodeURIComponent(targetPlate)}/movements?${q.toString()}`
      );
      setTraceResult(res);
      setTracePlateInput(res.plate || targetPlate);
    } catch (e: any) {
      toast(e.message || "Failed to trace vehicle movement", "err");
      setTraceResult(null);
    } finally {
      setLoadingTrace(false);
    }
  }, [tracePlateInput, traceFuzzy, traceSince]);

  // Jump from Cross-Camera to Route Trace
  const handleTraceFromTable = (plate: string) => {
    setTracePlateInput(plate);
    handleTabChange("route-trace");
    runTrace(plate);
  };

  // --------------------------------------------------------------------------
  // TAB 3: CORRIDOR TRANSIT ANALYSIS
  // --------------------------------------------------------------------------
  const [corridorOrigin, setCorridorOrigin] = useState("");
  const [corridorDest, setCorridorDest] = useState("");
  const [speedThresholdMin, setSpeedThresholdMin] = useState<number>(5);

  const corridorVehicles = useMemo(() => {
    if (!multiResult?.items) return [];
    if (!corridorOrigin && !corridorDest) return multiResult.items;

    return multiResult.items.filter((v) => {
      const camNames = v.cameras.map((c) => c.name.toLowerCase());
      const origMatch = !corridorOrigin || camNames.some((n) => n.includes(corridorOrigin.toLowerCase()));
      const destMatch = !corridorDest || camNames.some((n) => n.includes(corridorDest.toLowerCase()));
      return origMatch && destMatch;
    });
  }, [multiResult, corridorOrigin, corridorDest]);

  // --------------------------------------------------------------------------
  // TAB 4: MULTI-CAMERA GRID STATE
  // --------------------------------------------------------------------------
  const [matrixGridSize, setMatrixGridSize] = useState<2 | 4 | 6>(4);
  const [matrixCamSlots, setMatrixCamSlots] = useState<string[]>([]);

  useEffect(() => {
    if (cameras.length > 0 && matrixCamSlots.length === 0) {
      setMatrixCamSlots(cameras.slice(0, 6).map((c) => c.id));
    }
  }, [cameras, matrixCamSlots.length]);

  const handleSlotCamChange = (index: number, camId: string) => {
    setMatrixCamSlots((prev) => {
      const copy = [...prev];
      copy[index] = camId;
      return copy;
    });
  };

  // --------------------------------------------------------------------------
  // MODALS: CASE FILING & IMAGE INSPECTION
  // --------------------------------------------------------------------------
  const [caseModal, setCaseModal] = useState<{
    open: boolean;
    plate: string;
    openCases: OpenCaseOption[];
    selectedCaseId: string;
    note: string;
    submitting: boolean;
  }>({
    open: false,
    plate: "",
    openCases: [],
    selectedCaseId: "",
    note: "",
    submitting: false,
  });

  const [imageModal, setImageModal] = useState<{
    open: boolean;
    url: string;
    title: string;
  }>({
    open: false,
    url: "",
    title: "",
  });

  const openCaseFiling = async (plate: string) => {
    try {
      const cases = await api<OpenCaseOption[]>("/api/cases?status=open");
      if (!cases || cases.length === 0) {
        toast("No open cases available. Please create a case under Cases first.", "warn");
        return;
      }
      setCaseModal({
        open: true,
        plate,
        openCases: cases,
        selectedCaseId: cases[0].id,
        note: `Vehicle ${plate} multi-camera movement route evidence`,
        submitting: false,
      });
    } catch (e: any) {
      toast(e.message || "Failed to load open cases", "err");
    }
  };

  const submitCaseFiling = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caseModal.selectedCaseId || !caseModal.plate) return;

    setCaseModal((m) => ({ ...m, submitting: true }));
    try {
      await api(`/api/cases/${caseModal.selectedCaseId}/items`, {
        method: "POST",
        body: JSON.stringify({
          kind: "vehicle_movement",
          ref_id: caseModal.plate,
          note: caseModal.note.trim(),
        }),
      });
      toast(`Vehicle ${caseModal.plate} route filed into case successfully`, "ok");
      setCaseModal((m) => ({ ...m, open: false }));
    } catch (e: any) {
      toast(e.message || "Failed to attach vehicle to case", "err");
      setCaseModal((m) => ({ ...m, submitting: false }));
    }
  };

  // --------------------------------------------------------------------------
  // TOP METRICS STRIP
  // --------------------------------------------------------------------------
  const kpiStats = useMemo(() => {
    const totalVehicles = multiResult?.total || multiResult?.items?.length || 0;
    const maxCams = multiResult?.items?.reduce((acc, curr) => Math.max(acc, curr.camera_count), 0) || 0;
    const avgSpan =
      multiResult?.items && multiResult.items.length > 0
        ? Math.round(multiResult.items.reduce((acc, curr) => acc + curr.span_min, 0) / multiResult.items.length)
        : 0;
    const totalSightings =
      multiResult?.items?.reduce((acc, curr) => acc + curr.sightings, 0) || 0;

    return { totalVehicles, maxCams, avgSpan, totalSightings };
  }, [multiResult]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Multi-Camera Intelligence</h2>
              <p className="perm-page-desc">
                Cross-camera license plate correlation, travel corridor transit times, and vehicle route vector mapping.
              </p>
            </div>

            <div className="perm-actions-group">
              {canExport && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={handleExportCsv}
                  title="Export current cross-camera search results to CSV"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export CSV
                </button>
              )}
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  if (tab === "cross-camera") fetchMultiCameraVehicles();
                  else if (tab === "route-trace") runTrace();
                }}
                disabled={loadingMulti || loadingTrace}
                title="Refresh vehicle sightings"
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
            <div className="perm-kpi-card" title="Vehicles detected across 2 or more cameras">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="5" width="8" height="6" rx="1.5" />
                  <rect x="13" y="5" width="8" height="6" rx="1.5" />
                  <rect x="3" y="14" width="8" height="6" rx="1.5" />
                  <path d="M17 14v6M14 17h6" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Correlated Vehicles</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.totalVehicles.toLocaleString()}</span>
                  <span className="kpi-sub-pill sober-pill">≥ {minCameras} cameras</span>
                </div>
                <span className="kpi-desc">Multi-camera detections</span>
              </div>
            </div>

            <div className="perm-kpi-card" title="Highest number of cameras crossed by a single vehicle">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 18c4-1 5-6 9-7s5 4 7 3" />
                  <circle cx="4" cy="18" r="2" />
                  <circle cx="20" cy="14" r="2" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Peak Crossings</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.maxCams}</span>
                  <span className="kpi-sub-pill sober-pill">cameras</span>
                </div>
                <span className="kpi-desc">Longest multi-node path</span>
              </div>
            </div>

            <div className="perm-kpi-card" title="Mean time span between first and last detection">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Average Transit Span</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{formatSpan(kpiStats.avgSpan)}</span>
                </div>
                <span className="kpi-desc">First to last camera delta</span>
              </div>
            </div>

            <div className="perm-kpi-card" title="Total readings across monitoring nodes">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Total Sightings</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.totalSightings.toLocaleString()}</span>
                </div>
                <span className="kpi-desc">Across active nodes</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            {MULTICAM_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`admin-tab-item ${tab === sec.tabKey ? "active" : ""}`}
                onClick={() => handleTabChange(sec.tabKey)}
                role="tab"
              >
                {sec.iconName === "cross-camera" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <rect x="3" y="5" width="8" height="6" rx="1.5" />
                    <rect x="13" y="5" width="8" height="6" rx="1.5" />
                    <rect x="3" y="14" width="8" height="6" rx="1.5" />
                    <path d="M17 14v6M14 17h6" />
                  </svg>
                )}
                {sec.iconName === "route-trace" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <path d="M4 18c4-1 5-6 9-7s5 4 7 3" />
                    <circle cx="4" cy="18" r="2" />
                    <circle cx="20" cy="14" r="2" />
                  </svg>
                )}
                {sec.iconName === "corridors" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
                {sec.iconName === "matrix" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                )}
                <span className="tab-label">{sec.label}</span>
                {sec.tabKey === "cross-camera" && multiResult && (
                  <span className="tab-tag" style={{ marginLeft: 6 }}>{multiResult.items.length}</span>
                )}
                {tab === sec.tabKey && <div className="tab-active-indicator" />}
              </button>
            ))}
          </div>

          {/* Content Area */}
          <div style={{ marginTop: 14 }}>
          {/* =========================================================================
              TAB 1: CROSS-CAMERA SIGHTINGS
             ========================================================================= */}
          {tab === "cross-camera" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Filter Form Card */}
              <div className="perm-panel-card" style={{ padding: "16px 18px" }}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    fetchMultiCameraVehicles();
                  }}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    alignItems: "flex-end",
                  }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Period</span>
                    <select
                      className="search-input"
                      style={{ height: 34, fontSize: 12, minWidth: 140 }}
                      value={preset}
                      onChange={(e) => applyPreset(e.target.value)}
                    >
                      <option value="24h">Last 24 hours</option>
                      <option value="7d">Last 7 days</option>
                      <option value="30d">Last 30 days</option>
                      <option value="90d">Last 90 days</option>
                      <option value="ytd">This year</option>
                      <option value="lastyear">Last year</option>
                      <option value="year">Pick a year…</option>
                      <option value="custom">Custom (From / To)</option>
                    </select>
                  </label>

                  {preset === "year" && (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: "var(--muted)" }}>Year</span>
                      <select
                        className="search-input"
                        style={{ height: 34, fontSize: 12, minWidth: 90 }}
                        value={yearVal}
                        onChange={(e) => {
                          const y = Number(e.target.value);
                          setYearVal(y);
                          applyPreset("year", y);
                        }}
                      >
                        {[0, 1, 2, 3, 4].map((diff) => {
                          const y = new Date().getFullYear() - diff;
                          return (
                            <option key={y} value={y}>
                              {y}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  )}

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>From (IST)</span>
                    <input
                      type="datetime-local"
                      className="search-input"
                      style={{ height: 34, fontSize: 12 }}
                      value={sinceTime}
                      onChange={(e) => {
                        setPreset("custom");
                        setSinceTime(e.target.value);
                      }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>To (IST)</span>
                    <input
                      type="datetime-local"
                      className="search-input"
                      style={{ height: 34, fontSize: 12 }}
                      value={untilTime}
                      onChange={(e) => {
                        setPreset("custom");
                        setUntilTime(e.target.value);
                      }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>At Least</span>
                    <select
                      className="search-input"
                      style={{ height: 34, fontSize: 12, minWidth: 110 }}
                      value={minCameras}
                      onChange={(e) => setMinCameras(Number(e.target.value))}
                    >
                      <option value="2">2 cameras</option>
                      <option value="3">3 cameras</option>
                      <option value="4">4 cameras</option>
                      <option value="5">5 cameras</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Vehicle Type</span>
                    <select
                      className="search-input"
                      style={{ height: 34, fontSize: 12, minWidth: 120 }}
                      value={vehicleType}
                      onChange={(e) => setVehicleType(e.target.value)}
                    >
                      <option value="">Any type</option>
                      <option value="car">Car</option>
                      <option value="two_wheeler">Two-Wheeler</option>
                      <option value="bus">Bus</option>
                      <option value="truck">Truck</option>
                      <option value="light_vehicle">Light Vehicle</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Plate Filter</span>
                    <input
                      type="text"
                      className="search-input"
                      placeholder="e.g. GJ01*, *1234"
                      style={{ height: 34, fontSize: 12, width: 140 }}
                      value={plateQuery}
                      onChange={(e) => setPlateQuery(e.target.value)}
                    />
                  </label>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="submit"
                      className="btn primary"
                      style={{ height: 34, padding: "0 16px", fontSize: 12 }}
                      disabled={loadingMulti}
                    >
                      {loadingMulti ? "Searching…" : "Find Vehicles"}
                    </button>
                    {(selectedCamIds.length > 0 || plateQuery || vehicleType) && (
                      <button
                        type="button"
                        className="btn ghost small"
                        style={{ height: 34 }}
                        onClick={() => {
                          setSelectedCamIds([]);
                          setPlateQuery("");
                          setVehicleType("");
                          applyPreset("24h");
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </form>

                {/* Specific camera filter pill selector */}
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>
                    Must Include Specific Cameras ({selectedCamIds.length} selected):
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 78, overflowY: "auto" }}>
                    {cameras.map((c) => {
                      const active = selectedCamIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`btn small ${active ? "primary" : "ghost"}`}
                          style={{
                            fontSize: 11,
                            padding: "2px 8px",
                            height: 24,
                            borderRadius: 12,
                          }}
                          onClick={() => {
                            if (active) setSelectedCamIds(selectedCamIds.filter((id) => id !== c.id));
                            else setSelectedCamIds([...selectedCamIds, c.id]);
                          }}
                        >
                          {c.name} {c.department ? `(${c.department})` : ""}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Multi-Camera Results Table */}
              <div className="perm-panel-card">
                <div
                  className="perm-panel-head"
                  style={{
                    padding: "12px 18px",
                    borderBottom: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                      Cross-Camera Vehicles Table
                    </h3>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {multiResult
                        ? `${multiResult.total} vehicles on ${
                            selectedCamIds.length
                              ? `all ${selectedCamIds.length} chosen cameras`
                              : `≥ ${minCameras} cameras`
                          }`
                        : "Querying vehicle sightings…"}
                    </span>
                  </div>
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                        <th style={{ padding: "10px 14px" }}>Plate Number</th>
                        <th style={{ padding: "10px 14px", width: 90 }}>Cameras</th>
                        <th style={{ padding: "10px 14px" }}>Route Progression (In Order)</th>
                        <th style={{ padding: "10px 14px" }}>First Seen (IST)</th>
                        <th style={{ padding: "10px 14px" }}>Last Seen (IST)</th>
                        <th style={{ padding: "10px 14px" }}>Span</th>
                        <th style={{ padding: "10px 14px" }}>Sightings</th>
                        <th style={{ padding: "10px 14px", textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingMulti ? (
                        <tr>
                          <td colSpan={8} style={{ padding: "36px", textAlign: "center", color: "var(--muted)" }}>
                            Analyzing camera correlation logs…
                          </td>
                        </tr>
                      ) : !multiResult || multiResult.items.length === 0 ? (
                        <tr>
                          <td colSpan={8} style={{ padding: "36px", textAlign: "center", color: "var(--muted)" }}>
                            No vehicles were detected across that many cameras in this time window. Try widening the period or lowering the camera threshold.
                          </td>
                        </tr>
                      ) : (
                        pagedMultiItems.map((veh) => (
                          <tr key={veh.plate} className="perm-row">
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                className="platebox plate"
                                style={{
                                  display: "inline-block",
                                  padding: "3px 8px",
                                  borderRadius: 4,
                                  fontWeight: 700,
                                  letterSpacing: "0.5px",
                                  background: "var(--panel2)",
                                  border: "1px solid var(--line)",
                                  cursor: "pointer",
                                }}
                                onClick={() => handleTraceFromTable(veh.plate)}
                                title="Click to trace route"
                              >
                                {veh.plate}
                              </span>
                            </td>
                            <td style={{ padding: "12px 14px", fontWeight: 700, color: "#3b82f6" }}>
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 24,
                                  height: 24,
                                  borderRadius: 12,
                                  background: "rgba(59, 130, 246, 0.12)",
                                  fontSize: 12,
                                }}
                              >
                                {veh.camera_count}
                              </span>
                            </td>
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                                {veh.cameras.map((c, idx) => (
                                  <span
                                    key={idx}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 4,
                                      padding: "2px 8px",
                                      borderRadius: 12,
                                      fontSize: 11,
                                      background:
                                        c.department === "Police"
                                          ? "rgba(59, 130, 246, 0.15)"
                                          : "rgba(139, 92, 246, 0.15)",
                                      color: c.department === "Police" ? "#3b82f6" : "#8b5cf6",
                                      border: "1px solid var(--line)",
                                    }}
                                    title={`${c.department} • ${c.sightings} sighting(s) • ${fmtTime(c.first)}`}
                                  >
                                    <span style={{ fontWeight: 700, opacity: 0.8 }}>{idx + 1}.</span>
                                    <span>{c.name}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                              {fmtTime(veh.first_seen)}
                            </td>
                            <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                              {fmtTime(veh.last_seen)}
                            </td>
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              {formatSpan(veh.span_min)}
                            </td>
                            <td style={{ padding: "12px 14px", color: "var(--text)" }}>
                              {veh.sightings}
                            </td>
                            <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#3b82f6" }}
                                  onClick={() => handleTraceFromTable(veh.plate)}
                                  title="Trace full route across checkpoints"
                                >
                                  Trace
                                </button>
                                {canCases && (
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => openCaseFiling(veh.plate)}
                                    title="File vehicle route into an open investigation case dossier"
                                  >
                                    File Case
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {multiResult && multiResult.items.length > 0 && (
                  <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
                    <Pager
                      page={multiPage}
                      pages={multiTotalPages}
                      total={multiResult.items.length}
                      size={multiPageSize}
                      onPage={setMultiPage}
                      onSize={(s) => {
                        setMultiPageSize(s);
                        setMultiPage(1);
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 2: VEHICLE ROUTE TRACE
             ========================================================================= */}
          {tab === "route-trace" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Search Form Card */}
              <div className="perm-panel-card" style={{ padding: "16px 18px" }}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runTrace();
                  }}
                  style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>License Plate Number</span>
                    <input
                      type="text"
                      className="search-input"
                      placeholder="e.g. DL01AB1234"
                      style={{ height: 34, fontSize: 13, width: 200, fontWeight: 700 }}
                      value={tracePlateInput}
                      onChange={(e) => setTracePlateInput(e.target.value)}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Sightings Since (Optional)</span>
                    <input
                      type="datetime-local"
                      className="search-input"
                      style={{ height: 34, fontSize: 12 }}
                      value={traceSince}
                      onChange={(e) => setTraceSince(e.target.value)}
                    />
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, height: 34, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={traceFuzzy}
                      onChange={(e) => setTraceFuzzy(e.target.checked)}
                    />
                    <span>Fuzzy ANPR OCR Match</span>
                  </label>

                  <button
                    type="submit"
                    className="btn primary"
                    style={{ height: 34, padding: "0 18px", fontSize: 12 }}
                    disabled={loadingTrace}
                  >
                    {loadingTrace ? "Tracing Route…" : "Trace Vehicle Route"}
                  </button>

                  {traceResult && canCases && (
                    <button
                      type="button"
                      className="btn outline small"
                      style={{ height: 34 }}
                      onClick={() => openCaseFiling(traceResult.plate)}
                    >
                      File Route Into Case Dossier
                    </button>
                  )}
                </form>
              </div>

              {/* Route Summary & Map & Sightings */}
              {traceResult && (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1.2fr) minmax(320px, 1fr)", gap: 16 }}>
                  {/* Left Column: Interactive SVG Route Map */}
                  <div className="perm-panel-card">
                    <div
                      className="perm-panel-head"
                      style={{
                        padding: "12px 18px",
                        borderBottom: "1px solid var(--line)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                        Corridor Route: {traceResult.plate}
                      </h3>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        {traceResult.sightings.length} sightings across {traceResult.cameras.length} cameras
                      </span>
                    </div>

                    <div style={{ padding: 16, background: "var(--panel2)", minHeight: 380, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {(() => {
                        const camsWithGeo = cameras.filter((c) => c.lat != null && c.lon != null);
                        if (camsWithGeo.length === 0) {
                          return (
                            <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>
                              <p style={{ margin: 0, fontSize: 13 }}>Camera GPS coordinates are not configured.</p>
                              <p style={{ margin: "4px 0 0", fontSize: 11 }}>Please assign Latitude/Longitude in Sources to activate geo-vector route rendering.</p>
                            </div>
                          );
                        }

                        const W = 650;
                        const H = 380;
                        const P = 45;
                        const lats = camsWithGeo.map((c) => c.lat!);
                        const lons = camsWithGeo.map((c) => c.lon!);
                        const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
                        const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];

                        const toX = (lon: number) => P + ((lon - minLon) / (maxLon - minLon || 1)) * (W - 2 * P);
                        const toY = (lat: number) => H - P - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * P);

                        const routePts = traceResult.sightings.filter((s) => s.lat != null && s.lon != null);

                        return (
                          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", maxHeight: 420 }}>
                            <defs>
                              <marker id="route-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                                <path d="M0 0L10 5L0 10z" fill="#f59e0b" />
                              </marker>
                            </defs>

                            {/* Camera Nodes */}
                            {camsWithGeo.map((c) => (
                              <g key={c.id}>
                                <circle
                                  cx={toX(c.lon!)}
                                  cy={toY(c.lat!)}
                                  r="7"
                                  fill={c.department === "Police" ? "#3b82f6" : "#8b5cf6"}
                                  stroke="#0f172a"
                                  strokeWidth="2"
                                />
                                <text
                                  x={toX(c.lon!)}
                                  y={toY(c.lat!) + 18}
                                  textAnchor="middle"
                                  fontSize="10"
                                  fill="var(--muted)"
                                >
                                  {c.name}
                                </text>
                              </g>
                            ))}

                            {/* Connecting Route Segments */}
                            {routePts.slice(1).map((pt, i) => (
                              <line
                                key={i}
                                x1={toX(routePts[i].lon!)}
                                y1={toY(routePts[i].lat!)}
                                x2={toX(pt.lon!)}
                                y2={toY(pt.lat!)}
                                stroke="#f59e0b"
                                strokeWidth="3"
                                strokeDasharray="4 2"
                                markerEnd="url(#route-arrow)"
                                opacity="0.85"
                              />
                            ))}

                            {/* Sequential Stop Pins */}
                            {routePts.map((pt, i) => (
                              <g key={`num-${i}`}>
                                <circle
                                  cx={toX(pt.lon!) + 12 + (i % 3) * 4}
                                  cy={toY(pt.lat!) - 12 - (i % 3) * 4}
                                  r="9"
                                  fill="#f59e0b"
                                />
                                <text
                                  x={toX(pt.lon!) + 12 + (i % 3) * 4}
                                  y={toY(pt.lat!) - 8 - (i % 3) * 4}
                                  textAnchor="middle"
                                  fontSize="10"
                                  fill="#000"
                                  fontWeight="800"
                                >
                                  {i + 1}
                                </text>
                              </g>
                            ))}

                            {/* Map Legend */}
                            <g fontSize="10" fill="var(--muted)">
                              <circle cx="20" cy="20" r="5" fill="#3b82f6" />
                              <text x="32" y="24">Police Camera</text>
                              <circle cx="125" cy="20" r="5" fill="#8b5cf6" />
                              <text x="137" y="24">Municipal Camera</text>
                              <line x1="240" y1="20" x2="265" y2="20" stroke="#f59e0b" strokeWidth="2" markerEnd="url(#route-arrow)" />
                              <text x="275" y="24">Transit Vector</text>
                            </g>
                          </svg>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Right Column: Chronological Sightings Timeline */}
                  <div className="perm-panel-card">
                    <div
                      className="perm-panel-head"
                      style={{
                        padding: "12px 18px",
                        borderBottom: "1px solid var(--line)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                        Chronological Sightings ({traceResult.sightings.length})
                      </h3>
                    </div>

                    <div style={{ maxHeight: 480, overflowY: "auto", padding: "12px 16px" }}>
                      {traceResult.sightings.length === 0 ? (
                        <div style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No sightings recorded for this vehicle.
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          {traceResult.sightings.map((s, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: "flex",
                                gap: 12,
                                alignItems: "center",
                                padding: "10px 12px",
                                borderRadius: 6,
                                background: "var(--panel2)",
                                border: "1px solid var(--line)",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 24,
                                  height: 24,
                                  borderRadius: 12,
                                  background: "#f59e0b",
                                  color: "#000",
                                  fontWeight: 800,
                                  fontSize: 11,
                                  flexShrink: 0,
                                }}
                              >
                                {idx + 1}
                              </div>

                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  <span style={{ fontWeight: 700, fontSize: 13 }}>{s.camera_name}</span>
                                  <span
                                    style={{
                                      fontSize: 10,
                                      padding: "1px 6px",
                                      borderRadius: 10,
                                      background:
                                        s.department === "Police" ? "rgba(59, 130, 246, 0.2)" : "rgba(139, 92, 246, 0.2)",
                                      color: s.department === "Police" ? "#3b82f6" : "#8b5cf6",
                                    }}
                                  >
                                    {s.department}
                                  </span>
                                </div>
                                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                                  {fmtTime(s.ts)} • {s.direction || "unspecified"} • {Math.round(s.confidence * 100)}% match
                                  {s.plate !== traceResult.plate && ` (read as ${s.plate})`}
                                </div>
                              </div>

                              {s.crop_url && (
                                <img
                                  src={withTok(s.crop_url)}
                                  alt="Plate crop"
                                  style={{
                                    height: 38,
                                    borderRadius: 4,
                                    border: "1px solid var(--line)",
                                    cursor: "pointer",
                                    objectFit: "cover",
                                  }}
                                  onClick={() =>
                                    setImageModal({
                                      open: true,
                                      url: s.frame_url || s.crop_url!,
                                      title: `${s.camera_name} • ${fmtTime(s.ts)}`,
                                    })
                                  }
                                  title="Click to view full evidence frame"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 3: CORRIDOR & TRANSIT TIMES
             ========================================================================= */}
          {tab === "corridors" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Corridor Search Card */}
              <div className="perm-panel-card" style={{ padding: "16px 18px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Origin Camera / Checkpoint</span>
                    <select
                      className="search-input"
                      style={{ height: 34, fontSize: 12, minWidth: 200 }}
                      value={corridorOrigin}
                      onChange={(e) => setCorridorOrigin(e.target.value)}
                    >
                      <option value="">— Any Origin Checkpoint —</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name} ({c.department})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Destination Camera / Checkpoint</span>
                    <select
                      className="search-input"
                      style={{ height: 34, fontSize: 12, minWidth: 200 }}
                      value={corridorDest}
                      onChange={(e) => setCorridorDest(e.target.value)}
                    >
                      <option value="">— Any Destination Checkpoint —</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name} ({c.department})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Speed Alert Under (min)</span>
                    <input
                      type="number"
                      className="search-input"
                      style={{ height: 34, fontSize: 12, width: 90 }}
                      value={speedThresholdMin}
                      onChange={(e) => setSpeedThresholdMin(Number(e.target.value) || 0)}
                    />
                  </label>

                  {(corridorOrigin || corridorDest) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      style={{ height: 34 }}
                      onClick={() => {
                        setCorridorOrigin("");
                        setCorridorDest("");
                      }}
                    >
                      Reset Corridors
                    </button>
                  )}
                </div>
              </div>

              {/* Corridor Table */}
              <div className="perm-panel-card">
                <div
                  className="perm-panel-head"
                  style={{
                    padding: "12px 18px",
                    borderBottom: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                    Point-to-Point Corridor Transits ({corridorVehicles.length})
                  </h3>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    Transit time calculations and speed anomaly flags
                  </span>
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                        <th style={{ padding: "10px 14px" }}>Plate Number</th>
                        <th style={{ padding: "10px 14px" }}>Corridor Route Path</th>
                        <th style={{ padding: "10px 14px" }}>First Detection</th>
                        <th style={{ padding: "10px 14px" }}>Last Detection</th>
                        <th style={{ padding: "10px 14px" }}>Transit Duration</th>
                        <th style={{ padding: "10px 14px" }}>Anomaly Status</th>
                        <th style={{ padding: "10px 14px", textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {corridorVehicles.length === 0 ? (
                        <tr>
                          <td colSpan={7} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                            No vehicles matched this specific corridor pair. Select different checkpoints or expand the time window in Cross-Camera Sightings.
                          </td>
                        </tr>
                      ) : (
                        corridorVehicles.map((v) => {
                          const isFastTransit = v.span_min <= speedThresholdMin && v.camera_count >= 2;
                          return (
                            <tr key={v.plate} className="perm-row">
                              <td style={{ padding: "12px 14px", fontWeight: 700 }}>
                                <span
                                  className="platebox plate"
                                  style={{
                                    display: "inline-block",
                                    padding: "3px 8px",
                                    borderRadius: 4,
                                    background: "var(--panel2)",
                                    border: "1px solid var(--line)",
                                    cursor: "pointer",
                                  }}
                                  onClick={() => handleTraceFromTable(v.plate)}
                                >
                                  {v.plate}
                                </span>
                              </td>
                              <td style={{ padding: "12px 14px" }}>
                                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                  {v.cameras.map((c, idx) => (
                                    <span key={idx} style={{ fontSize: 12 }}>
                                      {idx > 0 && <span style={{ color: "var(--muted)", margin: "0 4px" }}>→</span>}
                                      <b>{c.name}</b>
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
                                {fmtTime(v.first_seen)}
                              </td>
                              <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
                                {fmtTime(v.last_seen)}
                              </td>
                              <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                                {formatSpan(v.span_min)}
                              </td>
                              <td style={{ padding: "12px 14px" }}>
                                {isFastTransit ? (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      padding: "2px 8px",
                                      borderRadius: 10,
                                      fontSize: 11,
                                      background: "rgba(239, 68, 68, 0.15)",
                                      color: "#ef4444",
                                      fontWeight: 600,
                                    }}
                                  >
                                    ⚡ Rapid Transit (&le; {speedThresholdMin}m)
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 11, color: "#10b981" }}>
                                    ✓ Standard Transit
                                  </span>
                                )}
                              </td>
                              <td style={{ padding: "12px 14px", textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#3b82f6" }}
                                  onClick={() => handleTraceFromTable(v.plate)}
                                >
                                  Trace
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: MULTI-CAMERA GRID
             ========================================================================= */}
          {tab === "matrix" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Matrix Control Bar */}
              <div
                className="perm-panel-card"
                style={{
                  padding: "12px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                    Synchronized Camera Matrix
                  </h3>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--muted)" }}>
                    Observe multiple checkpoints simultaneously to monitor vehicle passage in real time
                  </p>
                </div>

                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--muted)", marginRight: 4 }}>Layout:</span>
                  <button
                    type="button"
                    className={`btn small ${matrixGridSize === 2 ? "primary" : "ghost"}`}
                    onClick={() => setMatrixGridSize(2)}
                  >
                    2 Split
                  </button>
                  <button
                    type="button"
                    className={`btn small ${matrixGridSize === 4 ? "primary" : "ghost"}`}
                    onClick={() => setMatrixGridSize(4)}
                  >
                    4 Quad
                  </button>
                  <button
                    type="button"
                    className={`btn small ${matrixGridSize === 6 ? "primary" : "ghost"}`}
                    onClick={() => setMatrixGridSize(6)}
                  >
                    6 Matrix
                  </button>
                </div>
              </div>

              {/* Grid Tiles */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    matrixGridSize === 2
                      ? "repeat(2, 1fr)"
                      : matrixGridSize === 4
                      ? "repeat(2, 1fr)"
                      : "repeat(3, 1fr)",
                  gap: 14,
                }}
              >
                {Array.from({ length: matrixGridSize }).map((_, idx) => {
                  const selectedId = matrixCamSlots[idx] || "";
                  const cam = camById[selectedId];

                  return (
                    <div
                      key={idx}
                      className="perm-panel-card"
                      style={{
                        padding: 0,
                        overflow: "hidden",
                        display: "flex",
                        flexDirection: "column",
                        background: "var(--panel)",
                      }}
                    >
                      {/* Tile Header */}
                      <div
                        style={{
                          padding: "8px 12px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          background: "var(--panel2)",
                          borderBottom: "1px solid var(--line)",
                        }}
                      >
                        <select
                          className="search-input"
                          style={{ height: 28, fontSize: 12, maxWidth: 220 }}
                          value={selectedId}
                          onChange={(e) => handleSlotCamChange(idx, e.target.value)}
                        >
                          <option value="">— Select Camera —</option>
                          {cameras.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.department})
                            </option>
                          ))}
                        </select>

                        {cam && (
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                borderRadius: 10,
                                background:
                                  cam.department === "Police"
                                    ? "rgba(59, 130, 246, 0.2)"
                                    : "rgba(139, 92, 246, 0.2)",
                                color: cam.department === "Police" ? "#3b82f6" : "#8b5cf6",
                              }}
                            >
                              {cam.department}
                            </span>
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                background: cam.status === "ok" ? "#10b981" : "#ef4444",
                              }}
                              title={cam.status === "ok" ? "Online" : "Offline"}
                            />
                          </div>
                        )}
                      </div>

                      {/* Tile Viewport */}
                      <div
                        style={{
                          aspectRatio: "16 / 9",
                          background: "#0a0e17",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          position: "relative",
                        }}
                      >
                        {cam ? (
                          <div
                            style={{
                              width: "100%",
                              height: "100%",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "var(--muted)",
                              position: "relative",
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 42, height: 42, opacity: 0.5 }}>
                              <path d="M23 7l-7 5 7 5V7z" />
                              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                            </svg>
                            <div style={{ fontSize: 12, marginTop: 8, fontWeight: 600, color: "var(--text)" }}>
                              {cam.name}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>
                              {cam.anpr_enabled ? "ANPR Automatic Vehicle Reading Active" : "Checkpoint Camera Stream"}
                            </div>

                            <button
                              type="button"
                              className="btn primary small"
                              style={{ marginTop: 12, fontSize: 11 }}
                              onClick={() => navigate(`/playback/recordings?camera=${cam.id}`)}
                            >
                              Open Timeline Archive
                            </button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>
                            Select a camera to monitor this checkpoint slot
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Case Dossier Filing Modal */}
      <Modal open={caseModal.open} onClose={() => setCaseModal((m) => ({ ...m, open: false }))}>
        <div style={{ padding: "8px 4px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 700 }}>
            File Vehicle Movement into Case Dossier
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)" }}>
            Attach cross-camera journey logs and sightings of vehicle{" "}
            <b>{caseModal.plate}</b> into an active investigation case.
          </p>

          <form onSubmit={submitCaseFiling} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Select Active Case</span>
              <select
                className="search-input"
                style={{ height: 36 }}
                value={caseModal.selectedCaseId}
                onChange={(e) => setCaseModal((m) => ({ ...m, selectedCaseId: e.target.value }))}
                required
              >
                {caseModal.openCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number} — {c.title}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Investigator Evidence Notes</span>
              <textarea
                className="search-input"
                rows={3}
                placeholder="Describe why this cross-camera route is relevant to the investigation…"
                value={caseModal.note}
                onChange={(e) => setCaseModal((m) => ({ ...m, note: e.target.value }))}
                style={{ padding: 10, resize: "vertical" }}
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setCaseModal((m) => ({ ...m, open: false }))}
                disabled={caseModal.submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={caseModal.submitting}
              >
                {caseModal.submitting ? "Attaching to Case…" : "Attach Evidence to Case"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Full Image Evidence Modal */}
      <Modal open={imageModal.open} onClose={() => setImageModal((m) => ({ ...m, open: false }))} wide>
        <div style={{ padding: "4px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>
            {imageModal.title}
          </h3>
          <div style={{ background: "#000", borderRadius: 6, overflow: "hidden", textAlign: "center" }}>
            <img
              src={imageModal.url ? withTok(imageModal.url) : ""}
              alt="High resolution evidence frame"
              style={{ maxWidth: "100%", maxHeight: "75vh", display: "inline-block" }}
            />
          </div>
        </div>
      </Modal>
        </div>
      </section>
    </main>
  );
}
