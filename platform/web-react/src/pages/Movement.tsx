import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface MovementSectionItem {
  id: string;
  tabKey: "trace" | "stitch" | "trips" | "patterns";
  label: string;
  desc: string;
  iconName: "trace" | "stitch" | "trips" | "patterns";
}

export const MOVEMENT_SECTIONS: MovementSectionItem[] = [
  {
    id: "trace",
    tabKey: "trace",
    label: "Route Trace & Map",
    desc: "Trace vehicle route, chronological sightings, and interactive geo-vectors",
    iconName: "trace",
  },
  {
    id: "stitch",
    tabKey: "stitch",
    label: "Stitch Video Clips",
    desc: "Stitch archived camera clips into a single chronological MP4 dossier",
    iconName: "stitch",
  },
  {
    id: "trips",
    tabKey: "trips",
    label: "Trip Legs & Dwell Times",
    desc: "Segment-by-segment transit legs, stopovers, and parking dwell analysis",
    iconName: "trips",
  },
  {
    id: "patterns",
    tabKey: "patterns",
    label: "Frequent Route Patterns",
    desc: "Repeated commutes, recurring vehicle paths, and regular patrol routes",
    iconName: "patterns",
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

export interface MovementSighting {
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

export interface MovementTraceResponse {
  plate: string;
  sightings: MovementSighting[];
  cameras: string[];
  departments: string[];
}

export interface OpenCaseOption {
  id: string;
  number: string;
  title: string;
}

export interface TripLeg {
  fromCamera: string;
  toCamera: string;
  departureTime: string;
  arrivalTime: string;
  durationSec: number;
  dwellSec: number;
}

const padZ = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${padZ(d.getMonth() + 1)}-${padZ(d.getDate())}T${padZ(d.getHours())}:${padZ(d.getMinutes())}`;

const formatDuration = (sec: number) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export default function Movement() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();
  const canExport = has("export");
  const canCases = has("cases");

  // Tab mapping
  const tabFromSection = useMemo<"trace" | "stitch" | "trips" | "patterns">(() => {
    if (!section || section === "trace" || section === "route" || section === "map") return "trace";
    if (section === "stitch" || section === "video" || section === "export") return "stitch";
    if (section === "trips" || section === "dwell" || section === "legs") return "trips";
    if (section === "patterns" || section === "frequent" || section === "corridors") return "patterns";
    return "trace";
  }, [section]);

  const [tab, setTab] = useState<"trace" | "stitch" | "trips" | "patterns">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "trace" | "stitch" | "trips" | "patterns") => {
    setTab(nextTab);
    navigate(`/movement/${nextTab}`);
  };

  // Cameras List
  const [cameras, setCameras] = useState<CameraItem[]>([]);

  useEffect(() => {
    api<CameraItem[]>("/api/cameras")
      .then((res) => {
        setCameras(Array.isArray(res) ? res : []);
      })
      .catch(() => {});
  }, []);

  // Open Cases List
  const [openCases, setOpenCases] = useState<OpenCaseOption[]>([]);
  useEffect(() => {
    if (canCases) {
      api<OpenCaseOption[]>("/api/cases?status=open")
        .then((res) => setOpenCases(Array.isArray(res) ? res : []))
        .catch(() => {});
    }
  }, [canCases]);

  // --------------------------------------------------------------------------
  // TAB 1: ROUTE TRACE STATE
  // --------------------------------------------------------------------------
  const [plateInput, setPlateInput] = useState<string>("");
  const [fuzzy, setFuzzy] = useState<boolean>(false);
  const [sinceTime, setSinceTime] = useState<string>("");
  const [untilTime, setUntilTime] = useState<string>("");
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");

  const [traceResult, setTraceResult] = useState<MovementTraceResponse | null>(null);
  const [loadingTrace, setLoadingTrace] = useState<boolean>(false);

  // Sightings Pagination
  const [sightingPage, setSightingPage] = useState<number>(1);
  const [sightingPageSize, setSightingPageSize] = useState<number>(20);

  // Execute Trace
  const runVehicleTrace = useCallback(async (plateOverride?: string) => {
    const targetPlate = (plateOverride || plateInput).trim();
    if (!targetPlate) {
      toast("Please enter a vehicle license plate number", "warn");
      return;
    }

    setLoadingTrace(true);
    try {
      const q = new URLSearchParams();
      q.set("fuzzy", fuzzy ? "true" : "false");
      if (sinceTime) q.set("since", new Date(sinceTime).toISOString());
      if (untilTime) q.set("until", new Date(untilTime).toISOString());

      const res = await api<MovementTraceResponse>(
        `/api/vehicles/${encodeURIComponent(targetPlate)}/movements?${q.toString()}`
      );
      setTraceResult(res);
      setPlateInput(res.plate || targetPlate);
      setSightingPage(1);

      if (!res.sightings || res.sightings.length === 0) {
        toast(`No sightings found for vehicle ${targetPlate}`, "warn");
      }
    } catch (e: any) {
      toast(e.message || "Failed to trace vehicle movements", "err");
      setTraceResult(null);
    } finally {
      setLoadingTrace(false);
    }
  }, [plateInput, fuzzy, sinceTime, untilTime]);

  // Paginated Sightings
  const pagedSightings = useMemo(() => {
    if (!traceResult?.sightings) return [];
    const start = (sightingPage - 1) * sightingPageSize;
    return traceResult.sightings.slice(start, start + sightingPageSize);
  }, [traceResult, sightingPage, sightingPageSize]);

  const totalSightingPages = useMemo(() => {
    if (!traceResult?.sightings) return 1;
    return Math.max(1, Math.ceil(traceResult.sightings.length / sightingPageSize));
  }, [traceResult, sightingPageSize]);

  // Calculated Trip Legs & Dwell Times
  const tripLegs = useMemo<TripLeg[]>(() => {
    if (!traceResult?.sightings || traceResult.sightings.length < 2) return [];
    const sorted = [...traceResult.sightings].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );

    const legs: TripLeg[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const nxt = sorted[i + 1];
      const curTime = new Date(cur.ts).getTime() / 1000;
      const nxtTime = new Date(nxt.ts).getTime() / 1000;
      const diff = Math.max(0, nxtTime - curTime);

      legs.push({
        fromCamera: cur.camera_name,
        toCamera: nxt.camera_name,
        departureTime: cur.ts,
        arrivalTime: nxt.ts,
        durationSec: diff,
        dwellSec: diff > 900 ? diff : 0, // > 15 mins considered stop/dwell
      });
    }
    return legs;
  }, [traceResult]);

  // --------------------------------------------------------------------------
  // TAB 2: STITCH VIDEO STATE
  // --------------------------------------------------------------------------
  const [stitchPlate, setStitchPlate] = useState<string>("");
  const [stitchSince, setStitchSince] = useState<string>("");
  const [stitchUntil, setStitchUntil] = useState<string>("");
  const [stitchCaseId, setStitchCaseId] = useState<string>("");
  const [stitching, setStitching] = useState<boolean>(false);

  // Sync plate input to stitch tab
  useEffect(() => {
    if (plateInput && !stitchPlate) {
      setStitchPlate(plateInput);
    }
  }, [plateInput, stitchPlate]);

  const handleStitchClips = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const p = (stitchPlate || plateInput).trim();
    if (!p) {
      toast("Please enter a vehicle license plate number first", "warn");
      return;
    }

    const q = new URLSearchParams();
    if (stitchSince || sinceTime) q.set("since", new Date(stitchSince || sinceTime).toISOString());
    if (stitchUntil || untilTime) q.set("until", new Date(stitchUntil || untilTime).toISOString());
    if (stitchCaseId || selectedCaseId) q.set("case_id", stitchCaseId || selectedCaseId);

    setStitching(true);
    toast(`Preparing stitched timeline video for ${p}… download will start shortly`, "ok");

    const dlUrl = withTok(`/api/vehicles/${encodeURIComponent(p)}/stitch?${q.toString()}`);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = `stitched-route-${p}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => {
      setStitching(false);
    }, 2500);
  };

  // --------------------------------------------------------------------------
  // MODALS: CASE ATTACHMENT & IMAGE EVIDENCE
  // --------------------------------------------------------------------------
  const [caseModal, setCaseModal] = useState<{
    open: boolean;
    plate: string;
    selectedCaseId: string;
    note: string;
    submitting: boolean;
  }>({
    open: false,
    plate: "",
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

  const openCaseDialog = (plate: string) => {
    if (openCases.length === 0) {
      toast("No open cases available. Please create a case under Cases first.", "warn");
      return;
    }
    setCaseModal({
      open: true,
      plate,
      selectedCaseId: openCases[0].id,
      note: `Vehicle ${plate} complete movement path and chronological timeline evidence`,
      submitting: false,
    });
  };

  const submitAttachToCase = async (e: React.FormEvent) => {
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
      toast(`Route of vehicle ${caseModal.plate} filed into case dossier`, "ok");
      setCaseModal((m) => ({ ...m, open: false }));
    } catch (e: any) {
      toast(e.message || "Failed to attach route to case", "err");
      setCaseModal((m) => ({ ...m, submitting: false }));
    }
  };

  // --------------------------------------------------------------------------
  // SUMMARY KPIS
  // --------------------------------------------------------------------------
  const kpiStats = useMemo(() => {
    if (!traceResult || !traceResult.sightings) {
      return { sightings: 0, cameras: 0, departments: 0, timeSpan: "–" };
    }
    const count = traceResult.sightings.length;
    const camsCount = traceResult.cameras.length;
    const deptsCount = traceResult.departments.length;

    let timeSpan = "–";
    if (count >= 2) {
      const times = traceResult.sightings.map((s) => new Date(s.ts).getTime());
      const minT = Math.min(...times);
      const maxT = Math.max(...times);
      const deltaSec = (maxT - minT) / 1000;
      timeSpan = formatDuration(deltaSec);
    } else if (count === 1) {
      timeSpan = "Single point";
    }

    return { sightings: count, cameras: camsCount, departments: deptsCount, timeSpan };
  }, [traceResult]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Vehicle Movement & Route Intelligence</h2>
              <p className="perm-page-desc">
                Trace vehicle movements across checkpoints, render interactive journey maps, and stitch video evidence dossiers.
              </p>
            </div>

            <div className="perm-actions-group">
              {traceResult && canExport && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => handleStitchClips()}
                  disabled={stitching}
                  title="Stitch all camera video clips of this vehicle into one MP4"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <path d="M23 7l-7 5 7 5V7z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                  {stitching ? "Stitching…" : "Stitch Video Clips"}
                </button>
              )}
              {traceResult && canCases && (
                <button
                  type="button"
                  className="btn outline small"
                  onClick={() => openCaseDialog(traceResult.plate)}
                  title="File this route into an active investigation case dossier"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <rect x="3" y="7" width="18" height="13" rx="2" />
                    <path d="M8 7V5h8v2M3 12h18" />
                  </svg>
                  File into Case
                </button>
              )}
              <button
                type="button"
                className="btn primary small"
                onClick={() => runVehicleTrace()}
                disabled={loadingTrace || !plateInput.trim()}
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
            {/* Total Sightings */}
            <div className="perm-kpi-card" title="Total chronological license plate readings">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Total Sightings</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.sightings}</span>
                  {traceResult && (
                    <span className="kpi-sub-pill sober-pill">{traceResult.plate}</span>
                  )}
                </div>
                <span className="kpi-desc">Verified OCR detections</span>
              </div>
            </div>

            {/* Cameras Traversed */}
            <div className="perm-kpi-card" title="Unique cameras that captured this vehicle">
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
                  <span className="kpi-label">Cameras Crossed</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.cameras}</span>
                  <span className="kpi-sub-pill sober-pill">monitoring nodes</span>
                </div>
                <span className="kpi-desc">Checkpoints on route</span>
              </div>
            </div>

            {/* Departments Traversed */}
            <div className="perm-kpi-card" title="Administrative departments covering this journey">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Jurisdictions</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.departments}</span>
                  <span className="kpi-sub-pill sober-pill">depts</span>
                </div>
                <span className="kpi-desc">Police / Municipal coverage</span>
              </div>
            </div>

            {/* Route Duration */}
            <div className="perm-kpi-card" title="Total journey duration from first sighting to last">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 14 10" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Journey Span</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpiStats.timeSpan}</span>
                </div>
                <span className="kpi-desc">First to last camera span</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            {MOVEMENT_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`admin-tab-item ${tab === sec.tabKey ? "active" : ""}`}
                onClick={() => handleTabChange(sec.tabKey)}
                role="tab"
              >
                {sec.iconName === "trace" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <path d="M4 18c4-1 5-6 9-7s5 4 7 3" />
                    <circle cx="4" cy="18" r="2" />
                    <circle cx="20" cy="14" r="2" />
                  </svg>
                )}
                {sec.iconName === "stitch" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <path d="M23 7l-7 5 7 5V7z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                )}
                {sec.iconName === "trips" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                )}
                {sec.iconName === "patterns" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                )}
                <span className="tab-label">{sec.label}</span>
                {sec.tabKey === "trace" && traceResult && (
                  <span className="tab-tag" style={{ marginLeft: 6 }}>{traceResult.sightings.length}</span>
                )}
                {sec.tabKey === "trips" && tripLegs.length > 0 && (
                  <span className="tab-tag" style={{ marginLeft: 6 }}>{tripLegs.length}</span>
                )}
                {tab === sec.tabKey && <div className="tab-active-indicator" />}
              </button>
            ))}
          </div>

          {/* Content Area */}
          <div style={{ marginTop: 14 }}>
            {/* =========================================================================
                TAB 1: ROUTE TRACE & SIGHTINGS MAP
               ========================================================================= */}
            {tab === "trace" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Search Filter Panel */}
                <div className="perm-panel-card" style={{ padding: "16px 20px" }}>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      runVehicleTrace();
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 200px", minWidth: 160, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>Vehicle Plate Number</span>
                      <input
                        type="text"
                        className="search-input"
                        placeholder="e.g. MH12AB1234, DL01*"
                        style={{ height: 34, fontSize: 13, fontWeight: 700 }}
                        value={plateInput}
                        onChange={(e) => setPlateInput(e.target.value)}
                        required
                      />
                    </label>

                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>From (IST)</span>
                      <input
                        type="datetime-local"
                        className="search-input"
                        style={{ height: 34, fontSize: 12 }}
                        value={sinceTime}
                        onChange={(e) => setSinceTime(e.target.value)}
                      />
                    </label>

                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>To (IST)</span>
                      <input
                        type="datetime-local"
                        className="search-input"
                        style={{ height: 34, fontSize: 12 }}
                        value={untilTime}
                        onChange={(e) => setUntilTime(e.target.value)}
                      />
                    </label>

                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, height: 34, cursor: "pointer", userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={fuzzy}
                        onChange={(e) => setFuzzy(e.target.checked)}
                      />
                      <span>Include 1-char OCR variants</span>
                    </label>

                    <button
                      type="submit"
                      className="btn primary"
                      style={{ height: 34, padding: "0 18px", fontSize: 13 }}
                      disabled={loadingTrace || !plateInput.trim()}
                    >
                      {loadingTrace ? "Tracing Route…" : "Trace Vehicle"}
                    </button>

                    {(sinceTime || untilTime || fuzzy) && (
                      <button
                        type="button"
                        className="btn ghost small"
                        style={{ height: 34 }}
                        onClick={() => {
                          setSinceTime("");
                          setUntilTime("");
                          setFuzzy(false);
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </form>
                </div>

                {/* Main Visuals Split: Map on Left, Timeline on Right */}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1.25fr) minmax(320px, 1fr)", gap: 16 }}>
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
                        {traceResult ? `Route Map: ${traceResult.plate}` : "Checkpoint Route Map"}
                      </h3>
                      {traceResult && (
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          {traceResult.sightings.length} stops across {traceResult.cameras.length} cameras
                        </span>
                      )}
                    </div>

                    <div style={{ padding: 16, background: "var(--panel2)", minHeight: 420, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {(() => {
                        const camsWithGeo = cameras.filter((c) => c.lat != null && c.lon != null);
                        if (camsWithGeo.length === 0) {
                          return (
                            <div style={{ textAlign: "center", color: "var(--muted)", padding: 32 }}>
                              <p style={{ margin: 0, fontSize: 14 }}>Camera GPS coordinates are not configured.</p>
                              <p style={{ margin: "6px 0 0", fontSize: 12 }}>Assign latitude and longitude in Sources to enable route vector rendering.</p>
                            </div>
                          );
                        }

                        const W = 680;
                        const H = 420;
                        const P = 45;
                        const lats = camsWithGeo.map((c) => c.lat!);
                        const lons = camsWithGeo.map((c) => c.lon!);
                        const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
                        const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];

                        const toX = (lon: number) => P + ((lon - minLon) / (maxLon - minLon || 1)) * (W - 2 * P);
                        const toY = (lat: number) => H - P - ((lat - minLat) / (maxLat - minLat || 1)) * (H - 2 * P);

                        const routePts = (traceResult?.sightings || []).filter((s) => s.lat != null && s.lon != null);

                        return (
                          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", maxHeight: 460 }}>
                            <defs>
                              <marker id="move-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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

                            {/* Sequential Connecting Vectors */}
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
                                markerEnd="url(#move-arr)"
                                opacity="0.9"
                              />
                            ))}

                            {/* Numbered Stops */}
                            {routePts.map((pt, i) => (
                              <g key={`num-${i}`}>
                                <circle
                                  cx={toX(pt.lon!) + 14 + (i % 3) * 4}
                                  cy={toY(pt.lat!) - 14 - (i % 3) * 4}
                                  r="9"
                                  fill="#f59e0b"
                                />
                                <text
                                  x={toX(pt.lon!) + 14 + (i % 3) * 4}
                                  y={toY(pt.lat!) - 10 - (i % 3) * 4}
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
                              <line x1="240" y1="20" x2="265" y2="20" stroke="#f59e0b" strokeWidth="2" markerEnd="url(#move-arr)" />
                              <text x="275" y="24">Transit Vector</text>
                            </g>
                          </svg>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Right Column: Chronological Sightings List */}
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
                        Chronological Timeline ({traceResult?.sightings.length || 0})
                      </h3>
                      {traceResult && canCases && (
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => openCaseDialog(traceResult.plate)}
                          style={{ fontSize: 11 }}
                        >
                          + Case
                        </button>
                      )}
                    </div>

                    <div style={{ maxHeight: 460, overflowY: "auto", padding: "12px 16px" }}>
                      {!traceResult ? (
                        <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--muted)" }}>
                          Enter a vehicle license plate above and click &ldquo;Trace Vehicle&rdquo; to load movement logs.
                        </div>
                      ) : traceResult.sightings.length === 0 ? (
                        <div style={{ padding: "40px 16px", textAlign: "center", color: "var(--muted)" }}>
                          No sightings recorded for this vehicle. Try enabling OCR variants or selecting a wider date range.
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {pagedSightings.map((s, idx) => {
                            const globalIdx = (sightingPage - 1) * sightingPageSize + idx + 1;
                            return (
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
                                  {globalIdx}
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
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {traceResult && traceResult.sightings.length > sightingPageSize && (
                      <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
                        <Pager
                          page={sightingPage}
                          pages={totalSightingPages}
                          total={traceResult.sightings.length}
                          size={sightingPageSize}
                          onPage={setSightingPage}
                          onSize={(sz) => {
                            setSightingPageSize(sz);
                            setSightingPage(1);
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 2: STITCH VIDEO CLIPS
               ========================================================================= */}
            {tab === "stitch" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="perm-panel-card" style={{ padding: "20px 24px" }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700 }}>
                    Chronological Multi-Camera Video Stitching
                  </h3>
                  <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--muted)" }}>
                    Concatenate camera archive segments of vehicle movements into a single court-ready MP4 file. Each clip includes timestamp overlays and camera identification captions.
                  </p>

                  <form onSubmit={handleStitchClips} style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>Vehicle Plate Number</span>
                      <input
                        type="text"
                        className="search-input"
                        placeholder="e.g. MH12AB1234"
                        style={{ height: 36, fontWeight: 700 }}
                        value={stitchPlate}
                        onChange={(e) => setStitchPlate(e.target.value)}
                        required
                      />
                    </label>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>From Timestamp (IST)</span>
                        <input
                          type="datetime-local"
                          className="search-input"
                          style={{ height: 36 }}
                          value={stitchSince}
                          onChange={(e) => setStitchSince(e.target.value)}
                        />
                      </label>

                      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>To Timestamp (IST)</span>
                        <input
                          type="datetime-local"
                          className="search-input"
                          style={{ height: 36 }}
                          value={stitchUntil}
                          onChange={(e) => setStitchUntil(e.target.value)}
                        />
                      </label>
                    </div>

                    {canCases && (
                      <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>File Stitched Evidence into Case (Optional)</span>
                        <select
                          className="search-input"
                          style={{ height: 36 }}
                          value={stitchCaseId}
                          onChange={(e) => setStitchCaseId(e.target.value)}
                        >
                          <option value="">— None (Download only) —</option>
                          {openCases.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.number} — {c.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={stitching || !stitchPlate.trim()}
                        style={{ height: 36, padding: "0 22px" }}
                      >
                        {stitching ? "Preparing Video Download…" : "Generate Stitched MP4"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 3: TRIP LEGS & DWELL TIMES
               ========================================================================= */}
            {tab === "trips" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="perm-panel-card">
                  <div
                    className="perm-panel-head"
                    style={{
                      padding: "14px 18px",
                      borderBottom: "1px solid var(--line)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                        Trip Legs & Dwell Times ({tripLegs.length} segments)
                      </h3>
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--muted)" }}>
                        Calculated travel times between consecutive checkpoints and parking/dwell detection
                      </p>
                    </div>
                  </div>

                  <div style={{ overflowX: "auto" }}>
                    <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                          <th style={{ padding: "10px 14px" }}>Segment #</th>
                          <th style={{ padding: "10px 14px" }}>Origin Checkpoint</th>
                          <th style={{ padding: "10px 14px" }}>Destination Checkpoint</th>
                          <th style={{ padding: "10px 14px" }}>Departure Time (IST)</th>
                          <th style={{ padding: "10px 14px" }}>Arrival Time (IST)</th>
                          <th style={{ padding: "10px 14px" }}>Transit Time</th>
                          <th style={{ padding: "10px 14px" }}>Stop / Dwell Flag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tripLegs.length === 0 ? (
                          <tr>
                            <td colSpan={7} style={{ padding: "36px", textAlign: "center", color: "var(--muted)" }}>
                              {traceResult
                                ? "At least 2 chronological sightings are required to compute transit legs and dwell times."
                                : "Trace a vehicle plate under &ldquo;Route Trace & Map&rdquo; to analyze trip legs."}
                            </td>
                          </tr>
                        ) : (
                          tripLegs.map((leg, idx) => (
                            <tr key={idx} className="perm-row">
                              <td style={{ padding: "12px 14px", fontWeight: 700, color: "var(--muted)" }}>
                                Leg {idx + 1}
                              </td>
                              <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                                {leg.fromCamera}
                              </td>
                              <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                                {leg.toCamera}
                              </td>
                              <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
                                {fmtTime(leg.departureTime)}
                              </td>
                              <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
                                {fmtTime(leg.arrivalTime)}
                              </td>
                              <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                                {formatDuration(leg.durationSec)}
                              </td>
                              <td style={{ padding: "12px 14px" }}>
                                {leg.dwellSec > 0 ? (
                                  <span
                                    style={{
                                      display: "inline-block",
                                      padding: "2px 8px",
                                      borderRadius: 10,
                                      fontSize: 11,
                                      background: "rgba(245, 158, 11, 0.15)",
                                      color: "#f59e0b",
                                      fontWeight: 600,
                                    }}
                                  >
                                    🅿 Dwell Stop ({formatDuration(leg.dwellSec)})
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 11, color: "#10b981" }}>
                                    ✓ Direct Transit
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 4: FREQUENT ROUTE PATTERNS
               ========================================================================= */}
            {tab === "patterns" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="perm-panel-card" style={{ padding: "20px 24px" }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700 }}>
                    Recurring Vehicle Commute Corridors
                  </h3>
                  <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)" }}>
                    Detect recurrent travel habits, routine delivery patterns, and repeated city entrance/exit corridors.
                  </p>

                  <div style={{ padding: "28px", textAlign: "center", background: "var(--panel2)", borderRadius: 8 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 44, height: 44, color: "var(--muted)", margin: "0 auto 12px" }}>
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                    </svg>
                    <h4 style={{ margin: "0 0 6px", fontSize: 15 }}>Recurring Route Pattern Engine</h4>
                    <p style={{ margin: "0 auto", maxWidth: 480, fontSize: 13, color: "var(--muted)" }}>
                      When multiple trips are recorded across consecutive days, recurring corridor models correlate departure schedules and transit trajectories.
                    </p>
                    <button
                      type="button"
                      className="btn primary small"
                      style={{ marginTop: 16 }}
                      onClick={() => handleTabChange("trace")}
                    >
                      Return to Route Trace
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Case Attachment Modal */}
      <Modal open={caseModal.open} onClose={() => setCaseModal((m) => ({ ...m, open: false }))}>
        <div style={{ padding: "8px 4px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 18, fontWeight: 700 }}>
            File Vehicle Movement into Case Dossier
          </h3>
          <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)" }}>
            Attach chronological route timeline and camera evidence of vehicle{" "}
            <b>{caseModal.plate}</b> into an open investigation case.
          </p>

          <form onSubmit={submitAttachToCase} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Select Active Case</span>
              <select
                className="search-input"
                style={{ height: 36 }}
                value={caseModal.selectedCaseId}
                onChange={(e) => setCaseModal((m) => ({ ...m, selectedCaseId: e.target.value }))}
                required
              >
                {openCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.number} — {c.title}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Evidence Note</span>
              <textarea
                className="search-input"
                rows={3}
                placeholder="State the significance of this journey to the case dossier…"
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
                {caseModal.submitting ? "Attaching to Case…" : "Attach to Case Dossier"}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      {/* Full Evidence Frame Modal */}
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
    </main>
  );
}
