import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface SearchSectionItem {
  id: string;
  tabKey: "events" | "lookup" | "review" | "analytics";
  label: string;
  desc: string;
  iconName: "events" | "lookup" | "review" | "analytics";
}

export const SEARCH_SECTIONS: SearchSectionItem[] = [
  {
    id: "events",
    tabKey: "events",
    label: "ANPR Event Search",
    desc: "Search vehicle sightings by plate, camera, date, tag, and vehicle characteristics",
    iconName: "events",
  },
  {
    id: "lookup",
    tabKey: "lookup",
    label: "Vahan & Sarathi Lookup",
    desc: "Vehicle registration and driving licence queries from national registries",
    iconName: "lookup",
  },
  {
    id: "review",
    tabKey: "review",
    label: "Human Review Queue",
    desc: "Verify low-confidence OCR reads and train accuracy models",
    iconName: "review",
  },
  {
    id: "analytics",
    tabKey: "analytics",
    label: "Accuracy & Throughput",
    desc: "Hourly read rates, OCR accuracy reports, and camera traffic distributions",
    iconName: "analytics",
  },
];

export interface CameraItem {
  id: string;
  name: string;
  department?: string;
  status?: string;
  anpr_enabled?: boolean;
}

export interface AnprEvent {
  id: string;
  camera_id: string;
  department: string;
  ts: string;
  plate: string;
  plate_raw?: string;
  plate_valid?: boolean;
  plate_masked?: boolean;
  confidence: number;
  reads: number;
  direction?: string;
  crop_url?: string;
  frame_url?: string;
  tags?: string[];
  vehicle_type?: string;
  vehicle_colour?: string;
  plate_colour?: string;
  make_model?: string;
}

export interface SearchStats {
  events: number;
  unique_plates: number;
  alerts_open: number;
  watchlist: number;
  cameras_online: number;
  cameras: number;
  anpr_cameras: number;
  per_minute?: Record<string, number>;
}

export interface CaseOption {
  id: string;
  number: string;
  title: string;
}

export interface LookupResult {
  ok: boolean;
  ms: number;
  value: string;
  cached?: boolean;
  rows: [string, string][];
  data?: any;
}

export interface WeeklyCameraStat {
  camera_id: string;
  camera_name?: string;
  department?: string;
  reads: number;
  reviewed: number;
  accuracy: number;
  mean_confidence: number;
  low_confidence: number;
  invalid: number;
  night: number;
  top_reasons?: string[];
}

const padZ = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${padZ(d.getMonth() + 1)}-${padZ(d.getDate())}T${padZ(d.getHours())}:${padZ(d.getMinutes())}`;

export default function Search() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();

  const canExport = has("export");
  const canCases = has("cases");
  const canPlateSearch = has("plate_search");

  // Tab mapping
  const tabFromSection = useMemo<"events" | "lookup" | "review" | "analytics">(() => {
    if (!section || section === "events" || section === "search" || section === "sightings") return "events";
    if (section === "lookup" || section === "vahan" || section === "sarathi") return "lookup";
    if (section === "review" || section === "queue") return "review";
    if (section === "analytics" || section === "accuracy" || section === "traffic") return "analytics";
    return "events";
  }, [section]);

  const [tab, setTab] = useState<"events" | "lookup" | "review" | "analytics">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "events" | "lookup" | "review" | "analytics") => {
    setTab(nextTab);
    navigate(`/search/${nextTab}`);
  };

  // --------------------------------------------------------------------------
  // SHARED CAMERAS & SYSTEM STATS
  // --------------------------------------------------------------------------
  const [cameras, setCameras] = useState<CameraItem[]>([]);
  const [camById, setCamById] = useState<Record<string, CameraItem>>({});
  const [stats, setStats] = useState<SearchStats | null>(null);

  const loadCameras = useCallback(async () => {
    try {
      const res = await api<CameraItem[]>("/api/cameras");
      const list = (Array.isArray(res) ? res : []).slice().sort((a, b) => a.name.localeCompare(b.name));
      setCameras(list);
      const map: Record<string, CameraItem> = {};
      list.forEach((c) => {
        map[c.id] = c;
      });
      setCamById(map);
    } catch {
      // Keep silent
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const st = await api<SearchStats>("/api/stats?hours=24");
      setStats(st);
    } catch {
      // Keep silent
    }
  }, []);

  useEffect(() => {
    loadCameras();
    loadStats();
    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, [loadCameras, loadStats]);

  // --------------------------------------------------------------------------
  // TAB 1: ANPR EVENT SEARCH
  // --------------------------------------------------------------------------
  const [plate, setPlate] = useState<string>("");
  const [fuzzy, setFuzzy] = useState<boolean>(false);
  const [selectedCameras, setSelectedCameras] = useState<string[]>([]);
  const [tag, setTag] = useState<string>("");
  const [vehicleType, setVehicleType] = useState<string>("");
  const [colour, setColour] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [until, setUntil] = useState<string>("");

  const [events, setEvents] = useState<AnprEvent[]>([]);
  const [searching, setSearching] = useState<boolean>(false);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [showRateChart, setShowRateChart] = useState<boolean>(true);

  // Quick Time Presets
  const setTimePreset = (minutes: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60 * 1000);
    setSince(toLocalInput(start));
    setUntil(toLocalInput(end));
  };

  const setTodayPreset = () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    setSince(toLocalInput(start));
    setUntil(toLocalInput(end));
  };

  const clearTimePreset = () => {
    setSince("");
    setUntil("");
  };

  const runSearch = useCallback(async () => {
    setSearching(true);
    try {
      const p = new URLSearchParams();
      if (plate.trim()) p.set("plate", plate.trim().toUpperCase());
      if (fuzzy) p.set("fuzzy", "true");
      if (selectedCameras.length > 0) p.set("camera", selectedCameras.join(","));
      if (tag) p.set("tag", tag);
      if (vehicleType) p.set("vehicle_type", vehicleType);
      if (colour) p.set("colour", colour);
      if (since) p.set("since", new Date(since).toISOString());
      if (until) p.set("until", new Date(until).toISOString());
      p.set("limit", "1000");

      const res = await api<{ events: AnprEvent[]; count: number }>(`/api/events?${p.toString()}`);
      setEvents(res.events || []);
      setTotalCount(res.count ?? (res.events ? res.events.length : 0));
      setPage(1);
    } catch (e: any) {
      toast(e.message || "Failed to search vehicle events", "err");
      setEvents([]);
      setTotalCount(0);
    } finally {
      setSearching(false);
    }
  }, [plate, fuzzy, selectedCameras, tag, vehicleType, colour, since, until]);

  // Initial auto search on first load
  useEffect(() => {
    runSearch();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pagedEvents = useMemo(() => {
    const start = (page - 1) * pageSize;
    return events.slice(start, start + pageSize);
  }, [events, page, pageSize]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(events.length / pageSize));
  }, [events, pageSize]);

  // Download signed CSV export
  const handleExportCsv = () => {
    const p = new URLSearchParams();
    if (plate.trim()) p.set("plate", plate.trim().toUpperCase());
    if (selectedCameras.length > 0) p.set("camera", selectedCameras.join(","));
    if (tag) p.set("tag", tag);
    if (since) p.set("since", new Date(since).toISOString());
    if (until) p.set("until", new Date(until).toISOString());
    p.set("limit", "5000");

    window.open(withTok(`/api/events/export.csv?${p.toString()}`), "_blank");
    toast("Preparing signed CSV evidence export…", "ok");
  };

  // --------------------------------------------------------------------------
  // TAB 2: VAHAN & SARATHI LOOKUP STATE
  // --------------------------------------------------------------------------
  const [lookupKind, setLookupKind] = useState<"vahan" | "sarathi">("vahan");
  const [lookupQuery, setLookupQuery] = useState<string>("");
  const [lookupLoading, setLookupLoading] = useState<boolean>(false);
  const [lookupData, setLookupData] = useState<LookupResult | null>(null);
  const [recentLookups, setRecentLookups] = useState<{ kind: "vahan" | "sarathi"; value: string }[]>([
    { kind: "vahan", value: "GJ01AB1234" },
    { kind: "vahan", value: "MH12DE1420" },
    { kind: "sarathi", value: "DL-0420110012345" },
  ]);

  const runLookup = async (kindToUse = lookupKind, valToUse = lookupQuery) => {
    const val = valToUse.trim().toUpperCase();
    if (!val) {
      toast("Please enter a registration plate or driving licence number", "warn");
      return;
    }

    setLookupLoading(true);
    try {
      const res = await api<LookupResult>(`/api/lookup/${kindToUse}/${encodeURIComponent(val)}`);
      setLookupData(res);
      setLookupQuery(val);
      setLookupKind(kindToUse);

      // Add to recent
      setRecentLookups((prev) => {
        const filtered = prev.filter((x) => !(x.kind === kindToUse && x.value === val));
        return [{ kind: kindToUse, value: val }, ...filtered].slice(0, 8);
      });
      toast(`${kindToUse === "vahan" ? "Vehicle" : "Licence"} details retrieved (${res.ms} ms)`, "ok");
    } catch (e: any) {
      toast(e.message || "Lookup failed or API not configured", "err");
      setLookupData(null);
    } finally {
      setLookupLoading(false);
    }
  };

  const handleLookupSearchSightings = (targetPlate: string) => {
    setPlate(targetPlate);
    setTab("events");
    navigate("/search/events");
    setTimeout(() => {
      runSearch();
    }, 100);
  };

  // --------------------------------------------------------------------------
  // TAB 3: HUMAN REVIEW QUEUE STATE
  // --------------------------------------------------------------------------
  const [reviewQueue, setReviewQueue] = useState<AnprEvent[]>([]);
  const [loadingReview, setLoadingReview] = useState<boolean>(false);
  const [reviewPage, setReviewPage] = useState<number>(1);
  const [reviewPageSize, setReviewPageSize] = useState<number>(20);
  const [reviewFilterCamera, setReviewFilterCamera] = useState<string>("");
  const [reviewSearchPlate, setReviewSearchPlate] = useState<string>("");

  const filteredReviewQueue = useMemo(() => {
    return reviewQueue.filter((r) => {
      if (reviewFilterCamera && r.camera_id !== reviewFilterCamera) return false;
      if (reviewSearchPlate && !r.plate.includes(reviewSearchPlate.toUpperCase())) return false;
      return true;
    });
  }, [reviewQueue, reviewFilterCamera, reviewSearchPlate]);

  const pagedReviewQueue = useMemo(() => {
    const start = (reviewPage - 1) * reviewPageSize;
    return filteredReviewQueue.slice(start, start + reviewPageSize);
  }, [filteredReviewQueue, reviewPage, reviewPageSize]);

  const totalReviewPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredReviewQueue.length / reviewPageSize));
  }, [filteredReviewQueue, reviewPageSize]);

  const loadReviewQueue = useCallback(async () => {
    if (!canPlateSearch) return;
    setLoadingReview(true);
    try {
      const rows = await api<AnprEvent[]>("/api/reports/anpr/review-queue?limit=200");
      setReviewQueue(Array.isArray(rows) ? rows : []);
      setReviewPage(1);
    } catch (e: any) {
      toast(e.message || "Failed to load review queue", "err");
    } finally {
      setLoadingReview(false);
    }
  }, [canPlateSearch]);

  useEffect(() => {
    if (tab === "review") {
      loadReviewQueue();
    }
  }, [tab, loadReviewQueue]);

  const handleQuickConfirm = async (eid: string, curPlate: string) => {
    try {
      await api(`/api/events/${eid}/review`, {
        method: "POST",
        body: JSON.stringify({ verdict: "confirmed" }),
      });
      toast(`Confirmed plate ${curPlate}`, "ok");
      setReviewQueue((prev) => prev.filter((r) => r.id !== eid));
      loadStats();
    } catch (e: any) {
      toast(e.message || "Confirmation failed", "err");
    }
  };

  // --------------------------------------------------------------------------
  // TAB 4: ACCURACY & THROUGHPUT ANALYTICS STATE
  // --------------------------------------------------------------------------
  const [selectedWeek, setSelectedWeek] = useState<number>(0);
  const [accuracyRows, setAccuracyRows] = useState<WeeklyCameraStat[]>([]);
  const [loadingAccuracy, setLoadingAccuracy] = useState<boolean>(false);

  const loadAccuracyReport = useCallback(async () => {
    setLoadingAccuracy(true);
    try {
      const res = await api<{ cameras: WeeklyCameraStat[] }>(`/api/reports/anpr?weeks_ago=${selectedWeek}`);
      setAccuracyRows(res.cameras || []);
    } catch (e: any) {
      toast(e.message || "Failed to load accuracy report", "err");
      setAccuracyRows([]);
    } finally {
      setLoadingAccuracy(false);
    }
  }, [selectedWeek]);

  useEffect(() => {
    if (tab === "analytics") {
      loadAccuracyReport();
    }
  }, [tab, loadAccuracyReport]);

  // --------------------------------------------------------------------------
  // MODALS STATE
  // --------------------------------------------------------------------------
  // 1. Preview Crop & Frame Modal
  const [previewEvent, setPreviewEvent] = useState<AnprEvent | null>(null);
  const [previewFullFrame, setPreviewFullFrame] = useState<boolean>(false);

  // 2. Video Clip Modal
  const [clipEvent, setClipEvent] = useState<AnprEvent | null>(null);

  // 3. Review / Fix Plate Modal
  const [fixEvent, setFixEvent] = useState<AnprEvent | null>(null);
  const [fixVerdict, setFixVerdict] = useState<"confirmed" | "corrected" | "unreadable">("confirmed");
  const [fixTruePlate, setFixTruePlate] = useState<string>("");
  const [fixReason, setFixReason] = useState<string>("");
  const [savingFix, setSavingFix] = useState<boolean>(false);

  const openFixModal = (e: AnprEvent) => {
    setFixEvent(e);
    setFixVerdict("corrected");
    setFixTruePlate(e.plate);
    setFixReason("");
  };

  const handleSaveFix = async () => {
    if (!fixEvent) return;
    if (fixVerdict === "corrected" && !fixTruePlate.trim()) {
      toast("Please enter the corrected plate number", "warn");
      return;
    }

    setSavingFix(true);
    try {
      const res = await api<{ verdict: string; plate: string }>(`/api/events/${fixEvent.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          verdict: fixVerdict,
          true_plate: fixVerdict === "corrected" ? fixTruePlate.trim().toUpperCase() : "",
          reason: fixReason,
        }),
      });

      toast(`Saved verdict: ${res.verdict}${res.plate ? ` (${res.plate})` : ""}`, "ok");
      setFixEvent(null);

      // Update in local lists
      if (tab === "review") {
        setReviewQueue((prev) => prev.filter((r) => r.id !== fixEvent.id));
      }
      runSearch();
      loadStats();
    } catch (e: any) {
      toast(e.message || "Failed to save plate review", "err");
    } finally {
      setSavingFix(false);
    }
  };

  // 4. File into Case Modal
  const [caseTargetEvent, setCaseTargetEvent] = useState<AnprEvent | null>(null);
  const [caseList, setCaseList] = useState<CaseOption[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string>("");
  const [caseNote, setCaseNote] = useState<string>("");
  const [savingCaseItem, setSavingCaseItem] = useState<boolean>(false);

  const openCaseModal = async (e: AnprEvent) => {
    setCaseTargetEvent(e);
    setCaseNote(`Sighting of plate ${e.plate} on camera ${camById[e.camera_id]?.name || e.camera_id}`);
    try {
      const res = await api<{ cases: CaseOption[] }>("/api/cases?mine=false");
      const list = res.cases || [];
      setCaseList(list);
      if (list.length > 0 && !selectedCaseId) {
        setSelectedCaseId(list[0].id);
      }
    } catch {
      // Ignore
    }
  };

  const handleSaveCaseItem = async () => {
    if (!caseTargetEvent || !selectedCaseId) {
      toast("Please select an investigation case", "warn");
      return;
    }

    setSavingCaseItem(true);
    try {
      await api(`/api/cases/${selectedCaseId}/items`, {
        method: "POST",
        body: JSON.stringify({
          kind: "event",
          ref_id: caseTargetEvent.id,
          note: caseNote,
        }),
      });
      toast("Sighting successfully filed into investigation case dossier", "ok");
      setCaseTargetEvent(null);
    } catch (e: any) {
      toast(e.message || "Failed to file sighting into case", "err");
    } finally {
      setSavingCaseItem(false);
    }
  };

  // Throughput Rate SVG Chart calculation
  const rateChartData = useMemo(() => {
    if (!stats?.per_minute) return null;
    const keys = Object.keys(stats.per_minute);
    if (!keys.length) return null;

    const values = Object.values(stats.per_minute);
    const max = Math.max(...values, 1);
    const W = 900;
    const H = 140;
    const P = 24;
    const bw = (W - P) / keys.length;

    return {
      keys,
      values,
      max,
      W,
      H,
      P,
      bw,
      firstTime: keys[0],
      lastTime: keys[keys.length - 1],
    };
  }, [stats]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header Action Row */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: 26, height: 26, color: "#3b82f6" }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                ANPR Search & Vehicle Registry
              </h2>
              <p className="perm-subtitle">
                High-performance search across optical character recognition sightings, vehicle metadata, Vahan & Sarathi registries, and human review queues
              </p>
            </div>

            <div className="perm-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {tab === "events" && canExport && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={handleExportCsv}
                  title="Export signed CSV archive with SHA-256 manifest and digital cryptographic signatures"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export Signed CSV
                </button>
              )}

              {tab === "events" && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setShowRateChart(!showRateChart)}
                  title="Toggle 60-minute read rate chart"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  {showRateChart ? "Hide Chart" : "Show Chart"}
                </button>
              )}

              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  loadStats();
                  if (tab === "events") runSearch();
                  if (tab === "review") loadReviewQueue();
                  if (tab === "analytics") loadAccuracyReport();
                }}
                title="Refresh current dashboard data"
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
            {/* Reads 24h */}
            <div className="perm-kpi-card" title="Total ANPR license plates recognized in the last 24 hours">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">ANPR Reads (24h)</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{stats ? stats.events.toLocaleString() : "—"}</span>
                </div>
                <span className="kpi-desc">Total OCR frame recognitions</span>
              </div>
            </div>

            {/* Unique Plates */}
            <div className="perm-kpi-card" title="Unique license plates observed in the past 24 hours">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="8.5" cy="7" r="4" />
                  <line x1="20" y1="8" x2="20" y2="14" />
                  <line x1="23" y1="11" x2="17" y2="11" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Unique Plates</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{stats ? stats.unique_plates.toLocaleString() : "—"}</span>
                </div>
                <span className="kpi-desc">Distinct vehicle identities</span>
              </div>
            </div>

            {/* Open Alerts */}
            <div className="perm-kpi-card" title="Active watchlist and security alerts awaiting disposition">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(239, 68, 68, 0.12)", color: "#ef4444" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Open Alerts</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ color: stats && stats.alerts_open > 0 ? "#ef4444" : undefined }}>
                    {stats ? stats.alerts_open : "—"}
                  </span>
                  {stats && stats.alerts_open > 0 && <span className="kpi-sub-pill sober-pill" style={{ color: "#ef4444" }}>Active</span>}
                </div>
                <span className="kpi-desc">Security triggers pending</span>
              </div>
            </div>

            {/* Watchlist Vehicles */}
            <div className="perm-kpi-card" title="Target vehicle plates under active surveillance hotlist">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Watchlist Active</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{stats ? stats.watchlist.toLocaleString() : "—"}</span>
                </div>
                <span className="kpi-desc">Monitored hotlist entries</span>
              </div>
            </div>

            {/* Cameras Online & ANPR */}
            <div className="perm-kpi-card" title="Operational video feeds and active OCR edge inference streams">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(139, 92, 246, 0.12)", color: "#8b5cf6" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="23 7 16 12 23 17 23 7" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Feeds & ANPR</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{stats ? `${stats.cameras_online}/${stats.cameras}` : "—"}</span>
                  {stats && <span className="kpi-sub-pill sober-pill">{stats.anpr_cameras} ANPR</span>}
                </div>
                <span className="kpi-desc">Online video capture nodes</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            {SEARCH_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={`admin-tab-item ${tab === sec.tabKey ? "active" : ""}`}
                onClick={() => handleTabChange(sec.tabKey)}
                role="tab"
              >
                {sec.iconName === "events" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                )}
                {sec.iconName === "lookup" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <line x1="7" y1="8" x2="17" y2="8" />
                    <line x1="7" y1="12" x2="13" y2="12" />
                  </svg>
                )}
                {sec.iconName === "review" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                )}
                {sec.iconName === "analytics" && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="tab-ico">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                )}
                <span className="tab-label">{sec.label}</span>
                {tab === sec.tabKey && <span className="tab-active-indicator" />}
              </button>
            ))}
          </div>

          {/* ========================================================================= */}
          {/* TAB 1: ANPR EVENT SEARCH */}
          {/* ========================================================================= */}
          {tab === "events" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Optional Read Throughput Chart */}
              {showRateChart && rateChartData && (
                <div className="panel" style={{ padding: "14px 18px", background: "var(--panel)" }}>
                  <div className="panel-head" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>ANPR Reads per Minute (Last 60 Minutes, IST)</h4>
                      <span className="small muted">Peak: {rateChartData.max} reads/min</span>
                    </div>
                    <span className="small muted">Live stream throughput monitor</span>
                  </div>

                  <div style={{ width: "100%", height: 110, overflow: "hidden" }}>
                    <svg viewBox={`0 0 ${rateChartData.W} ${rateChartData.H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                      {rateChartData.keys.map((k, i) => {
                        const val = rateChartData.values[i];
                        const h = (val / rateChartData.max) * (rateChartData.H - rateChartData.P - 6);
                        return (
                          <rect
                            key={k}
                            x={rateChartData.P + i * rateChartData.bw + 1}
                            y={rateChartData.H - rateChartData.P - h}
                            width={Math.max(rateChartData.bw - 1.5, 1)}
                            height={Math.max(h, 2)}
                            fill="var(--accent, #3b82f6)"
                            rx={1.5}
                            opacity={0.85}
                          >
                            <title>{`${k} IST: ${val} reads`}</title>
                          </rect>
                        );
                      })}
                      <text x={rateChartData.P} y={rateChartData.H - 4} fill="#8b98a8" fontSize="10">
                        {rateChartData.firstTime}
                      </text>
                      <text x={rateChartData.W - 4} y={rateChartData.H - 4} fill="#8b98a8" fontSize="10" textAnchor="end">
                        {rateChartData.lastTime}
                      </text>
                      <text x="2" y="12" fill="#8b98a8" fontSize="10">
                        {rateChartData.max}
                      </text>
                    </svg>
                  </div>
                </div>
              )}

              {/* Search Criteria Form Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <form
                  className="search-form"
                  style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    runSearch();
                  }}
                >
                  {/* Plate Input */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Plate Number</span>
                    <input
                      name="plate"
                      placeholder="MH12AB1234, MH12*, *1234"
                      value={plate}
                      onChange={(e) => setPlate(e.target.value.toUpperCase())}
                      aria-label="Plate Number"
                      style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.5px" }}
                    />
                  </label>

                  {/* Fuzzy Match Checkbox */}
                  <label className="check" style={{ display: "flex", alignItems: "center", gap: 6, paddingBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={fuzzy}
                      onChange={(e) => setFuzzy(e.target.checked)}
                    />
                    <span style={{ fontSize: 12 }}>Fuzzy (1 char off)</span>
                  </label>

                  {/* Camera Selection */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "1 1 220px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Cameras</span>
                    <select
                      value={selectedCameras[0] || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedCameras(val ? [val] : []);
                      }}
                    >
                      <option value="">All cameras ({cameras.length})</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.department ? `(${c.department})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* Violation / Detection Tag */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160, flex: "1 1 160px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Tag / Violation</span>
                    <select value={tag} onChange={(e) => setTag(e.target.value)}>
                      <option value="">Any tag</option>
                      <option value="watchlist">watchlist</option>
                      <option value="low_confidence">low_confidence</option>
                      <option value="invalid_format">invalid_format</option>
                      <option value="night_movement">night_movement</option>
                      <option value="after_hours_depot">after_hours_depot</option>
                      <option value="night">night</option>
                      <option value="non_standard_plate">non_standard_plate</option>
                      <option value="challan_suggested">challan_suggested</option>
                      <option value="wrong_way">wrong_way</option>
                      <option value="over_speed">over_speed</option>
                      <option value="triple_riding">triple_riding</option>
                      <option value="no_helmet">no_helmet</option>
                      <option value="red_light">red_light</option>
                    </select>
                  </label>

                  {/* Vehicle Type */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130, flex: "1 1 130px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Vehicle Type</span>
                    <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                      <option value="">Any type</option>
                      <option value="car">car</option>
                      <option value="two_wheeler">two-wheeler</option>
                      <option value="bus">bus</option>
                      <option value="truck">truck</option>
                      <option value="light_vehicle">light vehicle</option>
                    </select>
                  </label>

                  {/* Vehicle Colour */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 130, flex: "1 1 130px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Colour</span>
                    <select value={colour} onChange={(e) => setColour(e.target.value)}>
                      <option value="">Any colour</option>
                      <option value="white">white</option>
                      <option value="silver">silver</option>
                      <option value="grey">grey</option>
                      <option value="black">black</option>
                      <option value="red">red</option>
                      <option value="blue">blue</option>
                      <option value="yellow">yellow</option>
                      <option value="green">green</option>
                      <option value="orange">orange</option>
                      <option value="brown">brown</option>
                    </select>
                  </label>

                  {/* Date Range Inputs */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 170 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>From (IST)</span>
                    <input
                      type="datetime-local"
                      value={since}
                      onChange={(e) => setSince(e.target.value)}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 170 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>To (IST)</span>
                    <input
                      type="datetime-local"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                    />
                  </label>

                  {/* Action Buttons */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="submit" className="btn primary" disabled={searching}>
                      {searching ? "Searching…" : "Search"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => {
                        setPlate("");
                        setFuzzy(false);
                        setSelectedCameras([]);
                        setTag("");
                        setVehicleType("");
                        setColour("");
                        clearTimePreset();
                        setTimeout(() => runSearch(), 50);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </form>

                {/* Quick Date Presets Row */}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                  <span className="small muted" style={{ marginRight: 4 }}>Quick presets:</span>
                  <button type="button" className="btn ghost small" onClick={() => setTimePreset(15)}>Last 15m</button>
                  <button type="button" className="btn ghost small" onClick={() => setTimePreset(60)}>Last 1h</button>
                  <button type="button" className="btn ghost small" onClick={() => setTimePreset(360)}>Last 6h</button>
                  <button type="button" className="btn ghost small" onClick={() => setTimePreset(1440)}>Last 24h</button>
                  <button type="button" className="btn ghost small" onClick={setTodayPreset}>Today</button>
                  <button type="button" className="btn ghost small" onClick={() => setTimePreset(10080)}>Last 7d</button>
                  <button type="button" className="btn ghost small" onClick={clearTimePreset}>Clear dates</button>
                </div>
              </div>

              {/* Results Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {searching ? (
                      "Searching records…"
                    ) : totalCount > 0 ? (
                      `${totalCount.toLocaleString()} vehicle records found`
                    ) : (
                      "No records match criteria"
                    )}
                  </h3>
                  <span className="small muted">
                    Showing page {page} of {totalPages} ({events.length} loaded)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>Time (IST)</th>
                        <th style={{ width: 120 }}>Plate</th>
                        <th style={{ width: 70 }}>Crop</th>
                        <th>Camera</th>
                        <th>Department</th>
                        <th style={{ width: 85 }}>Confidence</th>
                        <th style={{ width: 60 }}>Reads</th>
                        <th style={{ width: 75 }}>Direction</th>
                        <th>Vehicle Meta</th>
                        <th>Tags</th>
                        <th style={{ textAlign: "right", minWidth: 170 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedEvents.length > 0 ? (
                        pagedEvents.map((e) => {
                          const confPct = Math.round(e.confidence * 100);
                          const confColor = confPct >= 90 ? "#10b981" : confPct >= 75 ? "#f59e0b" : "#ef4444";
                          const camName = camById[e.camera_id]?.name || e.camera_id;

                          return (
                            <tr key={e.id}>
                              {/* Time */}
                              <td>
                                <div style={{ fontWeight: 500 }}>{fmtTime(e.ts)}</div>
                              </td>

                              {/* Plate Pill */}
                              <td>
                                <span
                                  className={`platebox plate ${e.plate_masked ? "masked" : ""}`}
                                  title={e.plate_masked ? "Masked: restricted plate" : "Click to look up or filter"}
                                  onClick={() => {
                                    if (!e.plate_masked) {
                                      handleLookupSearchSightings(e.plate);
                                    }
                                  }}
                                  style={{
                                    fontFamily: "monospace",
                                    fontWeight: 700,
                                    fontSize: 12,
                                    letterSpacing: "0.5px",
                                    padding: "2px 6px",
                                  }}
                                >
                                  {e.plate}
                                </span>
                              </td>

                              {/* Crop Thumbnail */}
                              <td>
                                {e.crop_url ? (
                                  <img
                                    className="crop"
                                    src={withTok(e.crop_url)}
                                    alt="Plate"
                                    onClick={() => {
                                      setPreviewEvent(e);
                                      setPreviewFullFrame(false);
                                    }}
                                    title="Click to view crop and full frame"
                                    style={{
                                      height: 28,
                                      borderRadius: 4,
                                      cursor: "zoom-in",
                                      border: "1px solid var(--line)",
                                      objectFit: "cover",
                                    }}
                                  />
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Camera */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{camName}</span>
                              </td>

                              {/* Department */}
                              <td>
                                <span className={`dept-${e.department}`} style={{ fontSize: 11, fontWeight: 500 }}>
                                  {e.department}
                                </span>
                              </td>

                              {/* Confidence */}
                              <td>
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    background: `${confColor}18`,
                                    color: confColor,
                                  }}
                                >
                                  {confPct}%
                                </span>
                              </td>

                              {/* Reads */}
                              <td>
                                <span className="small">{e.reads}</span>
                              </td>

                              {/* Direction */}
                              <td>
                                <span className="small muted">{e.direction || "—"}</span>
                              </td>

                              {/* Vehicle Meta */}
                              <td className="small" style={{ color: "var(--muted)" }}>
                                {[
                                  e.vehicle_colour,
                                  e.vehicle_type ? e.vehicle_type.replace("_", " ") : "",
                                  e.plate_colour && e.plate_colour !== "white" ? `${e.plate_colour} plate` : "",
                                  e.make_model,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "—"}
                              </td>

                              {/* Tags */}
                              <td>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {(e.tags || [])
                                    .filter((t) => !/^(type|colour|plate):/.test(t))
                                    .map((t) => (
                                      <span
                                        key={t}
                                        className={`tagchip ${
                                          [
                                            "watchlist",
                                            "challan_suggested",
                                            "over_speed",
                                            "wrong_way",
                                            "red_light",
                                            "triple_riding",
                                            "no_helmet",
                                          ].includes(t)
                                            ? "watchlist"
                                            : ""
                                        }`}
                                      >
                                        {t}
                                      </span>
                                    ))}
                                </div>
                              </td>

                              {/* Action Buttons */}
                              <td style={{ textAlign: "right" }}>
                                <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => setClipEvent(e)}
                                    title="Play short video clip of detection"
                                  >
                                    Clip
                                  </button>

                                  {canExport && (
                                    <a
                                      className="btn ghost small"
                                      href={withTok(`/api/events/${e.id}/export`)}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="Download watermarked evidence zip bundle"
                                    >
                                      Evidence
                                    </a>
                                  )}

                                  {canCases && (
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      onClick={() => openCaseModal(e)}
                                      title="File this sighting into an investigation case"
                                    >
                                      + Case
                                    </button>
                                  )}

                                  {canPlateSearch && !e.plate_masked && (
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      onClick={() => openFixModal(e)}
                                      title="Confirm or correct this OCR reading"
                                    >
                                      Fix
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={11} className="muted" style={{ textAlign: "center", padding: "32px 16px" }}>
                            {searching ? "Searching recorded ANPR sightings…" : "No vehicle records match the specified filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={page}
                    pages={totalPages}
                    total={events.length}
                    onPage={setPage}
                    size={pageSize}
                    onSize={setPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 2: VAHAN & SARATHI LOOKUP */}
          {/* ========================================================================= */}
          {tab === "lookup" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel" style={{ padding: "20px 24px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 14 }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>National Registry Gateway</h3>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    Live and cached queries against Ministry of Road Transport and Highways (MoRTH) Vahan (vehicle registration) and Sarathi (driving licence) APIs.
                  </p>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", marginBottom: 16 }}>
                  {/* Query Mode Switch */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Lookup Target</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        className={`btn small ${lookupKind === "vahan" ? "primary" : "ghost"}`}
                        onClick={() => setLookupKind("vahan")}
                      >
                        Vahan (Vehicle)
                      </button>
                      <button
                        type="button"
                        className={`btn small ${lookupKind === "sarathi" ? "primary" : "ghost"}`}
                        onClick={() => setLookupKind("sarathi")}
                      >
                        Sarathi (Licence)
                      </button>
                    </div>
                  </div>

                  {/* Input Query */}
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 260, flex: "1 1 260px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                      {lookupKind === "vahan" ? "Vehicle Registration Plate Number" : "Driving Licence Number"}
                    </span>
                    <input
                      placeholder={lookupKind === "vahan" ? "e.g. GJ01AB1234, MH12DE1420" : "e.g. DL-0420110012345"}
                      value={lookupQuery}
                      onChange={(e) => setLookupQuery(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") runLookup();
                      }}
                      style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.5px" }}
                    />
                  </label>

                  {/* Action Button */}
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => runLookup()}
                    disabled={lookupLoading || !lookupQuery.trim()}
                  >
                    {lookupLoading ? "Looking up…" : lookupKind === "vahan" ? "Look up Vehicle" : "Look up Licence"}
                  </button>
                </div>

                {/* Recent Lookups Quick Chips */}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <span className="small muted">Recent queries:</span>
                  {recentLookups.map((r, i) => (
                    <button
                      key={i}
                      type="button"
                      className="btn ghost small"
                      onClick={() => runLookup(r.kind, r.value)}
                      style={{ fontFamily: "monospace", fontSize: 11 }}
                    >
                      {r.kind === "vahan" ? "🚗" : "🪪"} {r.value}
                    </button>
                  ))}
                </div>
              </div>

              {/* Lookup Result Display Card */}
              {lookupData ? (
                <div className="panel" style={{ padding: "20px 24px", background: "var(--panel)" }}>
                  <div className="panel-head" style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                        {lookupKind === "vahan" ? "Vehicle Registration Details" : "Driving Licence Record"}
                      </h3>
                      <span className="platebox plate" style={{ fontFamily: "monospace", fontWeight: 700 }}>
                        {lookupData.value}
                      </span>
                      {lookupData.cached && (
                        <span className="kpi-sub-pill sober-pill" style={{ fontSize: 11 }}>Cached</span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="small muted">{lookupData.ms} ms</span>
                      {lookupKind === "vahan" && (
                        <button
                          type="button"
                          className="btn primary small"
                          onClick={() => handleLookupSearchSightings(lookupData.value)}
                        >
                          Find Sightings in CCTV
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Key-Value Details Grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
                    {lookupData.rows.map(([key, val], idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "8px 12px",
                          borderRadius: 6,
                          background: "var(--bg2, rgba(0,0,0,0.03))",
                          border: "1px solid var(--line)",
                          fontSize: 12,
                        }}
                      >
                        <span style={{ color: "var(--muted)", fontWeight: 500, textTransform: "capitalize" }}>
                          {key.replace(/_/g, " ")}
                        </span>
                        <span style={{ fontWeight: 600, textAlign: "right", maxWidth: "60%", wordBreak: "break-word" }}>
                          {val || "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="panel" style={{ padding: "36px 24px", textAlign: "center", background: "var(--panel)" }}>
                  <p className="muted" style={{ margin: 0 }}>
                    Enter a vehicle registration or licence number above to inspect official registration records.
                  </p>
                  <p className="small muted" style={{ marginTop: 8 }}>
                    External integration endpoints are managed under <a href="/admin/integrations">Admin → External APIs</a>.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 3: HUMAN REVIEW QUEUE */}
          {/* ========================================================================= */}
          {tab === "review" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Header and Filter Control Strip */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Human-in-the-Loop OCR Review Queue</h3>
                    <p className="small muted" style={{ margin: "4px 0 0" }}>
                      Confirm or correct ambiguous, low-confidence, or non-standard reads. Corrections update records and train OCR recognition models.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={loadReviewQueue}
                    disabled={loadingReview}
                  >
                    {loadingReview ? "Refreshing…" : "Refresh Queue"}
                  </button>
                </div>

                {/* Filter Controls Row */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200, flex: "1 1 200px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Filter by Plate</span>
                    <input
                      placeholder="Search plate in queue…"
                      value={reviewSearchPlate}
                      onChange={(e) => {
                        setReviewSearchPlate(e.target.value.toUpperCase());
                        setReviewPage(1);
                      }}
                      style={{ textTransform: "uppercase", fontSize: 12 }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "1 1 220px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Camera Location</span>
                    <select
                      value={reviewFilterCamera}
                      onChange={(e) => {
                        setReviewFilterCamera(e.target.value);
                        setReviewPage(1);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      <option value="">All camera locations</option>
                      {cameras.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.department ? `(${c.department})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {(reviewSearchPlate || reviewFilterCamera) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        setReviewSearchPlate("");
                        setReviewFilterCamera("");
                        setReviewPage(1);
                      }}
                    >
                      Reset filters
                    </button>
                  )}
                </div>
              </div>

              {/* Review Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                    {loadingReview ? (
                      "Loading pending review items…"
                    ) : filteredReviewQueue.length > 0 ? (
                      `${filteredReviewQueue.length} pending review records`
                    ) : (
                      "No items awaiting review"
                    )}
                  </h4>
                  <span className="small muted">
                    Showing page {reviewPage} of {totalReviewPages} ({filteredReviewQueue.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>Time (IST)</th>
                        <th style={{ width: 140 }}>Read As</th>
                        <th style={{ width: 90 }}>Crop</th>
                        <th>Camera Location</th>
                        <th>Tags</th>
                        <th style={{ textAlign: "right", minWidth: 160 }}>Verdict Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedReviewQueue.length > 0 ? (
                        pagedReviewQueue.map((r) => {
                          const confPct = Math.round(r.confidence * 100);
                          const confColor = confPct >= 90 ? "#10b981" : confPct >= 75 ? "#f59e0b" : "#ef4444";
                          const camName = camById[r.camera_id]?.name || r.camera_id;

                          return (
                            <tr key={r.id}>
                              {/* Time */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{fmtTime(r.ts)}</span>
                              </td>

                              {/* Read Plate & Confidence */}
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span className="platebox plate" style={{ fontFamily: "monospace", fontWeight: 700 }}>
                                    {r.plate}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 600,
                                      padding: "1px 5px",
                                      borderRadius: 4,
                                      background: `${confColor}18`,
                                      color: confColor,
                                    }}
                                  >
                                    {confPct}%
                                  </span>
                                </div>
                              </td>

                              {/* Crop Thumbnail */}
                              <td>
                                {r.crop_url ? (
                                  <img
                                    className="crop"
                                    src={withTok(r.crop_url)}
                                    alt="Crop"
                                    onClick={() => {
                                      setPreviewEvent(r);
                                      setPreviewFullFrame(false);
                                    }}
                                    style={{ height: 32, borderRadius: 4, cursor: "zoom-in", border: "1px solid var(--line)" }}
                                  />
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Camera Location */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{camName}</span>
                                {r.department && (
                                  <span className={`dept-${r.department}`} style={{ marginLeft: 6, fontSize: 11 }}>
                                    {r.department}
                                  </span>
                                )}
                              </td>

                              {/* Tags */}
                              <td>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                  {(r.tags || [])
                                    .filter((t) => !/^(type|colour|plate):/.test(t))
                                    .map((t) => (
                                      <span key={t} className="tagchip">
                                        {t}
                                      </span>
                                    ))}
                                </div>
                              </td>

                              {/* Action Buttons */}
                              <td style={{ textAlign: "right" }}>
                                <div style={{ display: "inline-flex", gap: 6 }}>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => handleQuickConfirm(r.id, r.plate)}
                                    style={{ color: "#10b981" }}
                                    title="Confirm OCR read as accurate"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    className="btn primary small"
                                    onClick={() => openFixModal(r)}
                                    title="Correct erroneous plate letters or symbols"
                                  >
                                    Correct…
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "32px 16px" }}>
                            {loadingReview
                              ? "Loading pending review queue items…"
                              : reviewSearchPlate || reviewFilterCamera
                              ? "No review records match the specified filters."
                              : "Review queue is clear! No low-confidence reads pending verification."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Review Queue Pagination Controls */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={reviewPage}
                    pages={totalReviewPages}
                    total={filteredReviewQueue.length}
                    onPage={setReviewPage}
                    size={reviewPageSize}
                    onSize={setReviewPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: ACCURACY & THROUGHPUT ANALYTICS */}
          {/* ========================================================================= */}
          {tab === "analytics" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Camera OCR Accuracy & Traffic Analysis</h3>
                    <p className="small muted" style={{ margin: "4px 0 0" }}>
                      Aggregated weekly metrics on OCR read counts, human operator review accuracy, and error breakdown per camera node.
                    </p>
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select
                      value={selectedWeek}
                      onChange={(e) => setSelectedWeek(Number(e.target.value))}
                      style={{ fontSize: 12, padding: "4px 8px" }}
                    >
                      <option value={0}>This week</option>
                      <option value={1}>Last week</option>
                      <option value={2}>2 weeks ago</option>
                      <option value={3}>3 weeks ago</option>
                    </select>

                    {canExport && (
                      <a
                        className="btn ghost small"
                        href={withTok("/api/reports/anpr/training-set.zip?days=90")}
                        target="_blank"
                        rel="noreferrer"
                        title="Download annotated OCR training bundle with crop images and labels.csv"
                      >
                        Retraining Set (.zip)
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Camera</th>
                        <th style={{ width: 90 }}>Reads</th>
                        <th style={{ width: 90 }}>Reviewed</th>
                        <th style={{ width: 100 }}>Accuracy</th>
                        <th style={{ width: 100 }}>Mean Conf.</th>
                        <th style={{ width: 90 }}>Low Conf.</th>
                        <th style={{ width: 80 }}>Invalid</th>
                        <th style={{ width: 80 }}>Night</th>
                        <th>Top Correction Reasons</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accuracyRows.length > 0 ? (
                        accuracyRows.map((row) => {
                          const accPct = Math.round((row.accuracy ?? 1) * 100);
                          const accColor = accPct >= 95 ? "#10b981" : accPct >= 85 ? "#f59e0b" : "#ef4444";
                          const confPct = Math.round((row.mean_confidence ?? 0) * 100);

                          return (
                            <tr key={row.camera_id}>
                              <td>
                                <span style={{ fontWeight: 600 }}>{row.camera_name || row.camera_id}</span>
                                {row.department && (
                                  <span className={`dept-${row.department}`} style={{ marginLeft: 6, fontSize: 11 }}>
                                    {row.department}
                                  </span>
                                )}
                              </td>
                              <td>{row.reads.toLocaleString()}</td>
                              <td>{row.reviewed.toLocaleString()}</td>
                              <td>
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "2px 6px",
                                    borderRadius: 4,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    background: `${accColor}18`,
                                    color: accColor,
                                  }}
                                >
                                  {accPct}%
                                </span>
                              </td>
                              <td>{confPct}%</td>
                              <td>{row.low_confidence}</td>
                              <td>{row.invalid}</td>
                              <td>{row.night}</td>
                              <td>
                                <span className="small muted">
                                  {(row.top_reasons || []).join(", ") || "None"}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "32px 16px" }}>
                            {loadingAccuracy ? "Compiling accuracy statistics…" : "No accuracy report data available for this week."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* MODAL 1: CROP & FULL FRAME PREVIEW */}
          {/* ========================================================================= */}
          <Modal open={Boolean(previewEvent)} onClose={() => setPreviewEvent(null)} wide>
            {previewEvent && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
                    Vehicle Sighting
                    <span className="platebox plate" style={{ fontFamily: "monospace", fontWeight: 700 }}>
                      {previewEvent.plate}
                    </span>
                  </h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className={`btn small ${!previewFullFrame ? "primary" : "ghost"}`}
                      onClick={() => setPreviewFullFrame(false)}
                    >
                      Crop View
                    </button>
                    {previewEvent.frame_url && (
                      <button
                        type="button"
                        className={`btn small ${previewFullFrame ? "primary" : "ghost"}`}
                        onClick={() => setPreviewFullFrame(true)}
                      >
                        Full Frame View
                      </button>
                    )}
                  </div>
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
                  {previewFullFrame && previewEvent.frame_url ? (
                    <img
                      src={withTok(previewEvent.frame_url)}
                      alt="Full Frame"
                      style={{ maxWidth: "100%", maxHeight: "65vh", objectFit: "contain" }}
                    />
                  ) : previewEvent.crop_url ? (
                    <img
                      src={withTok(previewEvent.crop_url)}
                      alt="Plate Crop"
                      style={{ maxWidth: "100%", maxHeight: "50vh", objectFit: "contain", transform: "scale(1.2)" }}
                    />
                  ) : (
                    <span className="muted">No media snapshot stored</span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, fontSize: 12 }}>
                  <div>
                    <span className="muted">Captured:</span> <b>{fmtTime(previewEvent.ts)}</b>
                  </div>
                  <div>
                    <span className="muted">Camera:</span> <b>{camById[previewEvent.camera_id]?.name || previewEvent.camera_id}</b>
                  </div>
                  <div>
                    <span className="muted">Confidence:</span> <b>{Math.round(previewEvent.confidence * 100)}%</b>
                  </div>
                  <div>
                    <span className="muted">Direction:</span> <b>{previewEvent.direction || "Unknown"}</b>
                  </div>
                </div>
              </div>
            )}
          </Modal>

          {/* ========================================================================= */}
          {/* MODAL 2: VIDEO CLIP PLAYER */}
          {/* ========================================================================= */}
          <Modal open={Boolean(clipEvent)} onClose={() => setClipEvent(null)} wide>
            {clipEvent && (
              <div>
                <h3 style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                  Event Recording Clip: {clipEvent.plate}
                </h3>
                <div
                  style={{
                    width: "100%",
                    background: "#000",
                    borderRadius: 8,
                    overflow: "hidden",
                    minHeight: 320,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 12,
                  }}
                >
                  <video
                    src={withTok(`/api/events/${clipEvent.id}/clip`)}
                    controls
                    autoPlay
                    style={{ width: "100%", maxHeight: "65vh" }}
                  >
                    Your browser does not support HTML5 video playback.
                  </video>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="small muted">
                    Camera: {camById[clipEvent.camera_id]?.name || clipEvent.camera_id} · {fmtTime(clipEvent.ts)}
                  </span>
                  <button type="button" className="btn ghost small" onClick={() => setClipEvent(null)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </Modal>

          {/* ========================================================================= */}
          {/* MODAL 3: REVIEW / FIX PLATE */}
          {/* ========================================================================= */}
          <Modal open={Boolean(fixEvent)} onClose={() => setFixEvent(null)}>
            {fixEvent && (
              <div>
                <h3 style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                  Review Read:{" "}
                  <span className="platebox plate" style={{ fontFamily: "monospace" }}>
                    {fixEvent.plate}
                  </span>
                </h3>

                {fixEvent.crop_url && (
                  <div style={{ textAlign: "center", marginBottom: 14 }}>
                    <img
                      src={withTok(fixEvent.crop_url)}
                      alt="Crop"
                      style={{ height: 44, borderRadius: 4, border: "1px solid var(--line)" }}
                    />
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSaveFix();
                  }}
                  style={{ display: "flex", flexDirection: "column", gap: 12 }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Verdict</span>
                    <select
                      value={fixVerdict}
                      onChange={(e) => setFixVerdict(e.target.value as any)}
                    >
                      <option value="confirmed">Confirm: read correctly</option>
                      <option value="corrected">Correct to different plate</option>
                      <option value="unreadable">Unreadable / obscure</option>
                    </select>
                  </label>

                  {fixVerdict === "corrected" && (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>Correct Plate</span>
                      <input
                        value={fixTruePlate}
                        onChange={(e) => setFixTruePlate(e.target.value.toUpperCase())}
                        placeholder="MP04ZR7493"
                        style={{ textTransform: "uppercase", fontWeight: 700, letterSpacing: "1px" }}
                        autoFocus
                      />
                    </label>
                  )}

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Reason for OCR Error</span>
                    <select value={fixReason} onChange={(e) => setFixReason(e.target.value)}>
                      <option value="">Select reason (optional)</option>
                      <option value="two_line">two_line</option>
                      <option value="night">night</option>
                      <option value="dirty">dirty</option>
                      <option value="decorative_font">decorative_font</option>
                      <option value="occluded">occluded</option>
                      <option value="angle">angle</option>
                      <option value="motion_blur">motion_blur</option>
                      <option value="other">other</option>
                    </select>
                  </label>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn ghost" onClick={() => setFixEvent(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn primary" disabled={savingFix}>
                      {savingFix ? "Saving…" : "Save Verdict"}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </Modal>

          {/* ========================================================================= */}
          {/* MODAL 4: FILE SIGHTING INTO CASE */}
          {/* ========================================================================= */}
          <Modal open={Boolean(caseTargetEvent)} onClose={() => setCaseTargetEvent(null)}>
            {caseTargetEvent && (
              <div>
                <h3 style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 700 }}>
                  File Sighting into Case Dossier
                </h3>

                <p className="small muted" style={{ marginBottom: 14 }}>
                  Add vehicle sighting <b style={{ fontFamily: "monospace" }}>{caseTargetEvent.plate}</b> to an active investigation chain of custody.
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
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Investigation Note</span>
                    <textarea
                      rows={3}
                      value={caseNote}
                      onChange={(e) => setCaseNote(e.target.value)}
                      placeholder="Why this sighting matters to the case…"
                      style={{ fontSize: 13, padding: 8, borderRadius: 6, border: "1px solid var(--line)" }}
                    />
                  </label>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn ghost" onClick={() => setCaseTargetEvent(null)}>
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
