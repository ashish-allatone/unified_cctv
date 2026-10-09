import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import Pager from "../components/Pager";

// ----------------------------------------------------------------------------
// SECTIONS CONFIGURATION
// ----------------------------------------------------------------------------
export interface CountsSection {
  id: string;
  label: string;
  desc: string;
  iconName: string;
}

export const COUNTS_SECTIONS: CountsSection[] = [
  {
    id: "live",
    label: "Live Camera Counts",
    desc: "Real-time vehicles & people in view per camera with 5s live polling",
    iconName: "live",
  },
  {
    id: "crowd",
    label: "Crowd & Occupancy",
    desc: "Perimeter crowd density, capacity limits, and crowd alarms",
    iconName: "crowd",
  },
  {
    id: "traffic",
    label: "Traffic & Line Flow",
    desc: "Directional vehicle crossings, line counts (A→B, B→A), and lane averages",
    iconName: "traffic",
  },
  {
    id: "trends",
    label: "Timeline Trends",
    desc: "Historical per-minute averages, peak spikes, and timeline sparklines",
    iconName: "trends",
  },
];

// ----------------------------------------------------------------------------
// DATA INTERFACES
// ----------------------------------------------------------------------------
export interface LiveCameraItem {
  camera_id: string;
  name?: string;
  department?: string;
  vehicles: number;
  persons: number;
  stale?: boolean;
}

export interface CountsLivePayload {
  cameras: LiveCameraItem[];
  total: {
    vehicles: number;
    persons: number;
    cameras: number;
  };
}

export interface TimelineCameraItem {
  camera_id: string;
  name?: string;
  department?: string;
  crowd_max?: number;
  avg_vehicles?: number;
  peak_vehicles?: number;
  avg_persons?: number;
  peak_persons?: number;
  flow?: {
    a_to_b?: number;
    b_to_a?: number;
  };
  points?: [number, number, number][]; // [ts, vehicles, persons]
}

export interface CountsTimelinePayload {
  cameras: TimelineCameraItem[];
  crowd_default?: number;
}

export interface CountsStatusPayload {
  detecting_count: number;
  expected_count: number;
  cameras_last_5min: number;
  last_row_age_s: number | null;
  hint?: string;
}

export interface TrafficSummaryItem {
  camera_name: string;
  windows: number;
  avg_vehicles: number;
  peak_vehicles: number;
  avg_persons?: number;
  by_class: Record<string, number>;
  flow: {
    a_to_b?: number;
    b_to_a?: number;
  };
  last: string;
}

export interface TrafficPayload {
  rows: any[];
  summary: TrafficSummaryItem[];
}

export interface MergedCameraCount {
  id: string;
  name: string;
  dept: string;
  v: number | null;
  p: number | null;
  max: number;
  isCrowded: boolean;
  isBusy: boolean;
  flowAB: number;
  flowBA: number;
  avgV: number | null;
  peakV: number | null;
  avgP: number | null;
  peakP: number | null;
  points: [number, number, number][];
}

// ----------------------------------------------------------------------------
// SVG SPARKLINE COMPONENT
// ----------------------------------------------------------------------------
function Sparkline({
  points,
  idx,
  color,
  max,
  width = 110,
  height = 24,
  label = "",
}: {
  points?: [number, number, number][];
  idx: 1 | 2; // 1 = vehicles, 2 = persons
  color: string;
  max: number;
  width?: number;
  height?: number;
  label?: string;
}) {
  if (!points || points.length === 0) {
    return <span className="small muted" style={{ fontSize: 11 }}>—</span>;
  }
  const n = points.length;
  const m = Math.max(1, max);
  const pathD = points
    .map((p, i) => {
      const x = (i / Math.max(1, n - 1)) * width;
      const val = p[idx] ?? 0;
      const y = height - (Math.min(val, m) / m) * (height - 3) - 1.5;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const lastVal = points[points.length - 1]?.[idx] ?? 0;

  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      title={`${label}: latest ${lastVal}, peak ${max} (over ${n} intervals)`}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ verticalAlign: "middle", overflow: "visible", flexShrink: 0 }}
      >
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 11, fontWeight: 600, color, minWidth: 20 }}>{lastVal}</span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// MAIN COUNTS COMPONENT
// ----------------------------------------------------------------------------
export default function Counts() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();

  // Tab section resolution
  const validTabs = ["live", "crowd", "traffic", "trends"];
  const currentTab = section && validTabs.includes(section) ? section : "live";
  const [tab, setTab] = useState<string>(currentTab);

  useEffect(() => {
    if (section && validTabs.includes(section)) {
      setTab(section);
    } else if (!section) {
      setTab("live");
    }
  }, [section]);

  const handleTabChange = (t: string) => {
    setTab(t);
    navigate(`/counts/${t}`);
  };

  // State
  const [hours, setHours] = useState<string>("1");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());

  // Raw telemetry data
  const [liveData, setLiveData] = useState<CountsLivePayload>({ cameras: [], total: { vehicles: 0, persons: 0, cameras: 0 } });
  const [timelineData, setTimelineData] = useState<CountsTimelinePayload>({ cameras: [], crowd_default: 25 });
  const [statusData, setStatusData] = useState<CountsStatusPayload | null>(null);
  const [trafficData, setTrafficData] = useState<TrafficPayload>({ rows: [], summary: [] });
  const [camerasList, setCamerasList] = useState<any[]>([]);

  // Search & Filters
  const [search, setSearch] = useState<string>("");
  const [deptFilter, setDeptFilter] = useState<string>("");
  const [crowdFilter, setCrowdFilter] = useState<string>("all"); // all, crowded, busy, normal
  const [sortBy, setSortBy] = useState<string>("activity"); // activity, people, vehicles, name

  // Pagination states
  const [livePage, setLivePage] = useState<number>(1);
  const [livePageSize, setLivePageSize] = useState<number>(25);

  const [crowdPage, setCrowdPage] = useState<number>(1);
  const [crowdPageSize, setCrowdPageSize] = useState<number>(25);

  const [trafficPage, setTrafficPage] = useState<number>(1);
  const [trafficPageSize, setTrafficPageSize] = useState<number>(25);

  const [trendsPage, setTrendsPage] = useState<number>(1);
  const [trendsPageSize, setTrendsPageSize] = useState<number>(25);

  // Camera preview modal
  const [previewCam, setPreviewCam] = useState<MergedCameraCount | null>(null);

  // Load cameras catalog
  useEffect(() => {
    api<any[]>("/api/cameras")
      .then((cams) => setCamerasList(Array.isArray(cams) ? cams : []))
      .catch(() => {});
  }, []);

  const camById = useMemo(() => {
    return Object.fromEntries(camerasList.map((c) => [c.id, c]));
  }, [camerasList]);

  // Load telemetry data from APIs
  const fetchCounts = useCallback(
    async (isBackground = false) => {
      if (!isBackground) setLoading(true);
      try {
        const [liveRes, tlRes, stRes, trRes] = await Promise.all([
          api<CountsLivePayload>("/api/counts").catch(() => ({ cameras: [], total: { vehicles: 0, persons: 0, cameras: 0 } })),
          api<CountsTimelinePayload>(`/api/counts/timeline?hours=${hours}`).catch(() => ({ cameras: [], crowd_default: 25 })),
          api<CountsStatusPayload>("/api/counts/status").catch(() => null),
          api<TrafficPayload>(`/api/traffic?hours=${hours}`).catch(() => ({ rows: [], summary: [] })),
        ]);

        setLiveData(liveRes && Array.isArray(liveRes.cameras) ? liveRes : { cameras: [], total: { vehicles: 0, persons: 0, cameras: 0 } });
        setTimelineData(tlRes && Array.isArray(tlRes.cameras) ? tlRes : { cameras: [], crowd_default: 25 });
        setStatusData(stRes);
        setTrafficData(trRes && Array.isArray(trRes.summary) ? trRes : { rows: [], summary: [] });
        setLastRefreshedAt(new Date());
      } catch (err: any) {
        if (!isBackground) {
          toast(err?.message || "Failed to load counts telemetry", "err");
        }
      } finally {
        if (!isBackground) setLoading(false);
      }
    },
    [hours]
  );

  // Initial fetch and hours changes
  useEffect(() => {
    fetchCounts(false);
  }, [fetchCounts]);

  // 5-second polling interval
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchCounts(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchCounts]);

  // Merged camera items
  const mergedCameras = useMemo<MergedCameraCount[]>(() => {
    const liveBy = Object.fromEntries((liveData.cameras || []).map((c) => [c.camera_id, c]));
    const tlBy = Object.fromEntries((timelineData.cameras || []).map((c) => [c.camera_id, c]));

    const ids = Array.from(new Set([...Object.keys(liveBy), ...Object.keys(tlBy)]));
    const crowdDefault = timelineData.crowd_default ?? 25;

    return ids
      .map((id) => {
        const l = liveBy[id];
        const t = tlBy[id];
        const camMeta = camById[id];

        // Skip registry-only cameras if flag is set
        if (camMeta?.registry_only) return null;

        const name = l?.name || t?.name || camMeta?.name || id;
        const dept = l?.department || t?.department || camMeta?.department || "";
        const v = l && !l.stale ? l.vehicles : null;
        const p = l && !l.stale ? l.persons : null;
        const max = t?.crowd_max ?? crowdDefault;

        const isCrowded = p != null && p > max;
        const isBusy = p != null && p > max * 0.7 && p <= max;

        const flowAB = t?.flow?.a_to_b ?? 0;
        const flowBA = t?.flow?.b_to_a ?? 0;

        return {
          id,
          name,
          dept,
          v,
          p,
          max,
          isCrowded,
          isBusy,
          flowAB,
          flowBA,
          avgV: t?.avg_vehicles ?? null,
          peakV: t?.peak_vehicles ?? null,
          avgP: t?.avg_persons ?? null,
          peakP: t?.peak_persons ?? null,
          points: t?.points || [],
        };
      })
      .filter((x): x is MergedCameraCount => x !== null)
      .sort((a, b) => {
        if (sortBy === "people") {
          return (b.p ?? -1) - (a.p ?? -1) || a.name.localeCompare(b.name);
        }
        if (sortBy === "vehicles") {
          return (b.v ?? -1) - (a.v ?? -1) || a.name.localeCompare(b.name);
        }
        if (sortBy === "name") {
          return a.name.localeCompare(b.name);
        }
        // default: activity (vehicles + persons)
        const actA = (a.v ?? 0) + (a.p ?? 0);
        const actB = (b.v ?? 0) + (b.p ?? 0);
        return actB - actA || a.name.localeCompare(b.name);
      });
  }, [liveData, timelineData, camById, sortBy]);

  // Departments list for filter
  const departments = useMemo(() => {
    const set = new Set<string>();
    mergedCameras.forEach((c) => {
      if (c.dept) set.add(c.dept);
    });
    return Array.from(set).sort();
  }, [mergedCameras]);

  // KPI calculations
  const totalVehiclesNow = useMemo(() => {
    return mergedCameras.reduce((acc, c) => acc + (c.v || 0), 0);
  }, [mergedCameras]);

  const totalPeopleNow = useMemo(() => {
    return mergedCameras.reduce((acc, c) => acc + (c.p || 0), 0);
  }, [mergedCameras]);

  const activeCamerasCount = useMemo(() => {
    return mergedCameras.filter((c) => c.v != null || c.p != null).length;
  }, [mergedCameras]);

  const crowdedCameras = useMemo(() => {
    return mergedCameras.filter((c) => c.isCrowded);
  }, [mergedCameras]);

  const busyCameras = useMemo(() => {
    return mergedCameras.filter((c) => c.isBusy);
  }, [mergedCameras]);

  const peakPeriodVehicles = useMemo(() => {
    return Math.max(0, ...mergedCameras.map((c) => c.peakV || 0));
  }, [mergedCameras]);

  const peakPeriodPeople = useMemo(() => {
    return Math.max(0, ...mergedCameras.map((c) => c.peakP || 0));
  }, [mergedCameras]);

  // Filtered cameras for Tab 1 (Live)
  const filteredLiveCameras = useMemo(() => {
    return mergedCameras.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q) && !c.dept.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (deptFilter && c.dept !== deptFilter) return false;
      return true;
    });
  }, [mergedCameras, search, deptFilter]);

  // Paged live cameras
  const totalLivePages = Math.max(1, Math.ceil(filteredLiveCameras.length / livePageSize));
  const pagedLiveCameras = useMemo(() => {
    const start = (livePage - 1) * livePageSize;
    return filteredLiveCameras.slice(start, start + livePageSize);
  }, [filteredLiveCameras, livePage, livePageSize]);

  // Filtered cameras for Tab 2 (Crowd)
  const filteredCrowdCameras = useMemo(() => {
    return mergedCameras.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q) && !c.dept.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (deptFilter && c.dept !== deptFilter) return false;
      if (crowdFilter === "crowded" && !c.isCrowded) return false;
      if (crowdFilter === "busy" && !c.isBusy) return false;
      if (crowdFilter === "normal" && (c.isCrowded || c.isBusy)) return false;
      return true;
    });
  }, [mergedCameras, search, deptFilter, crowdFilter]);

  const totalCrowdPages = Math.max(1, Math.ceil(filteredCrowdCameras.length / crowdPageSize));
  const pagedCrowdCameras = useMemo(() => {
    const start = (crowdPage - 1) * crowdPageSize;
    return filteredCrowdCameras.slice(start, start + crowdPageSize);
  }, [filteredCrowdCameras, crowdPage, crowdPageSize]);

  // Filtered traffic rows for Tab 3 (Traffic)
  const filteredTrafficRows = useMemo(() => {
    const summary = trafficData.summary || [];
    return summary.filter((tr) => {
      if (search) {
        const q = search.toLowerCase();
        if (!tr.camera_name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [trafficData, search]);

  const totalTrafficPages = Math.max(1, Math.ceil(filteredTrafficRows.length / trafficPageSize));
  const pagedTrafficRows = useMemo(() => {
    const start = (trafficPage - 1) * trafficPageSize;
    return filteredTrafficRows.slice(start, start + trafficPageSize);
  }, [filteredTrafficRows, trafficPage, trafficPageSize]);

  // Filtered timeline trends for Tab 4 (Trends)
  const filteredTrendsCameras = useMemo(() => {
    return mergedCameras.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.id.toLowerCase().includes(q) && !c.dept.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (deptFilter && c.dept !== deptFilter) return false;
      return true;
    });
  }, [mergedCameras, search, deptFilter]);

  const totalTrendsPages = Math.max(1, Math.ceil(filteredTrendsCameras.length / trendsPageSize));
  const pagedTrendsCameras = useMemo(() => {
    const start = (trendsPage - 1) * trendsPageSize;
    return filteredTrendsCameras.slice(start, start + trendsPageSize);
  }, [filteredTrendsCameras, trendsPage, trendsPageSize]);

  // CSV Export
  const handleExportCSV = () => {
    const rows = [
      ["Camera ID", "Camera Name", "Department", "Live Vehicles", "Live People", "Crowd Threshold", "Status", "Flow A->B", "Flow B->A", "Avg Vehicles", "Peak Vehicles", "Avg People", "Peak People"],
      ...mergedCameras.map((c) => [
        c.id,
        c.name,
        c.dept,
        c.v ?? "N/A",
        c.p ?? "N/A",
        c.max,
        c.isCrowded ? "Crowded" : c.isBusy ? "Busy" : "Normal",
        c.flowAB,
        c.flowBA,
        c.avgV ?? "N/A",
        c.peakV ?? "N/A",
        c.avgP ?? "N/A",
        c.peakP ?? "N/A",
      ]),
    ];
    const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.map((x) => `"${x}"`).join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `cctv_counts_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast("Counts telemetry CSV exported successfully", "ok");
  };

  // Status indicator
  const isCountingOk = statusData ? statusData.detecting_count > 0 && statusData.cameras_last_5min > 0 : false;

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header Action Row */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ width: 26, height: 26, color: "var(--accent)" }}>
                  <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
                </svg>
                Vehicle &amp; Crowd Counts
              </h2>
              <p className="perm-subtitle">
                Live vehicular density, crowd occupancy tracking, directional line crossing, and multi-hour telemetry
              </p>
            </div>

            <div className="perm-actions" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {/* Auto-Refresh Toggle Button */}
              <button
                type="button"
                className={`btn small ${autoRefresh ? "primary" : "ghost"}`}
                onClick={() => setAutoRefresh(!autoRefresh)}
                title={autoRefresh ? "Auto-refreshing every 5 seconds (click to pause)" : "Auto-refresh paused (click to resume)"}
                style={autoRefresh ? { background: "#10b981", borderColor: "#10b981", color: "#fff" } : undefined}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  {autoRefresh ? (
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="10" y1="15" x2="10" y2="9" />
                      <line x1="14" y1="15" x2="14" y2="9" />
                    </>
                  ) : (
                    <>
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </>
                  )}
                </svg>
                {autoRefresh ? "Live Polling: 5s" : "Polling: Paused"}
              </button>

              {/* Time Window Selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--panel)", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--line)" }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}>Period:</span>
                <select
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  style={{ background: "transparent", border: "none", color: "var(--text)", fontSize: 12, cursor: "pointer", fontWeight: 600 }}
                >
                  <option value="1">Last 1 hour</option>
                  <option value="3">Last 3 hours</option>
                  <option value="12">Last 12 hours</option>
                  <option value="24">Last 24 hours</option>
                  <option value="168">Last 7 days</option>
                </select>
              </div>

              {/* Manual Refresh */}
              <button
                type="button"
                className="btn ghost small"
                onClick={() => fetchCounts(false)}
                disabled={loading}
                title="Refresh telemetry immediately"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Refresh
              </button>

              {/* CSV Export */}
              <button
                type="button"
                className="btn ghost small"
                onClick={handleExportCSV}
                title="Download CSV export of telemetry counts"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Export CSV
              </button>
            </div>
          </div>

          {/* Worker Status & Diagnostic Banner */}
          {statusData && (
            <div
              className="panel"
              style={{
                marginBottom: 16,
                padding: "10px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                fontSize: 12,
                background: "var(--panel)",
                borderLeft: `4px solid ${isCountingOk ? "#10b981" : statusData.detecting_count > 0 ? "#f59e0b" : "#ef4444"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontWeight: 700,
                    textTransform: "uppercase",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    background: isCountingOk ? "rgba(16, 185, 129, 0.15)" : statusData.detecting_count > 0 ? "rgba(245, 158, 11, 0.15)" : "rgba(239, 68, 68, 0.15)",
                    color: isCountingOk ? "#10b981" : statusData.detecting_count > 0 ? "#f59e0b" : "#ef4444",
                  }}
                >
                  {isCountingOk ? "● Active Counting" : statusData.detecting_count > 0 ? "▲ Starting Up" : "■ Offline"}
                </span>

                <span style={{ color: "var(--muted)" }}>
                  <b>{statusData.detecting_count}</b> of <b>{statusData.expected_count}</b> cameras detecting now ·
                  Last telemetry{" "}
                  {statusData.last_row_age_s == null
                    ? "never"
                    : statusData.last_row_age_s < 90
                    ? `${Math.round(statusData.last_row_age_s)}s ago`
                    : `${Math.round(statusData.last_row_age_s / 60)} min ago`}
                  {" "}· <b>{statusData.cameras_last_5min}</b> cameras active in past 5 min
                </span>
              </div>

              {statusData.hint && (
                <div style={{ color: "#ef4444", fontSize: 12, fontWeight: 500 }}>
                  ⚠️ {statusData.hint}
                </div>
              )}
            </div>
          )}

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid" style={{ marginBottom: 16 }}>
            {/* Vehicles in View */}
            <div className="perm-kpi-card" title="Total vehicles currently detected across all cameras">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="7" width="20" height="13" rx="2" />
                  <path d="M16 7V4a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v3" />
                  <circle cx="7" cy="14" r="1.5" />
                  <circle cx="17" cy="14" r="1.5" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Vehicles in View</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ color: "#10b981" }}>{totalVehiclesNow.toLocaleString()}</span>
                </div>
                <span className="kpi-desc">Across {mergedCameras.length} active cameras</span>
              </div>
            </div>

            {/* People in View */}
            <div className="perm-kpi-card" title="Total individuals currently detected in camera feeds">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">People in View</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ color: "#3b82f6" }}>{totalPeopleNow.toLocaleString()}</span>
                </div>
                <span className="kpi-desc">Real-time crowd count</span>
              </div>
            </div>

            {/* Cameras Counting */}
            <div className="perm-kpi-card" title="Number of cameras actively streaming count telemetry">
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(99, 102, 241, 0.12)", color: "#6366f1" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Cameras Counting</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{activeCamerasCount} / {mergedCameras.length}</span>
                </div>
                <span className="kpi-desc">Operational video nodes</span>
              </div>
            </div>

            {/* Crowded Alarms */}
            <div className="perm-kpi-card" title="Cameras where persons exceed capacity limit">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: crowdedCameras.length > 0 ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.12)",
                  color: crowdedCameras.length > 0 ? "#ef4444" : "#10b981",
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
                  <span className="kpi-label">Crowded Zones</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ color: crowdedCameras.length > 0 ? "#ef4444" : undefined }}>
                    {crowdedCameras.length}
                  </span>
                  {crowdedCameras.length > 0 && <span className="kpi-sub-pill sober-pill" style={{ color: "#ef4444" }}>Alarm</span>}
                </div>
                <span className="kpi-desc">
                  {busyCameras.length > 0 ? `${busyCameras.length} busy nearing limit` : "Within safety thresholds"}
                </span>
              </div>
            </div>

            {/* Peak Activity */}
            <div className="perm-kpi-card" title={`Peak detections recorded in the last ${hours}h window`}>
              <div className="kpi-icon-box sober-icon-box" style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Period Peaks ({hours}h)</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value" style={{ fontSize: 20 }}>
                    {peakPeriodVehicles} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>veh</span> · {peakPeriodPeople} <span style={{ fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>ppl</span>
                  </span>
                </div>
                <span className="kpi-desc">Maximum observed spike</span>
              </div>
            </div>
          </div>

          {/* Section Navigation Tabs Strip */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            {COUNTS_SECTIONS.map((sec) => {
              const isActive = tab === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`admin-tab-item ${isActive ? "active" : ""}`}
                  onClick={() => handleTabChange(sec.id)}
                  title={sec.desc}
                >
                  <span className="tab-ico">
                    {sec.iconName === "live" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <circle cx="12" cy="12" r="3" />
                        <line x1="12" y1="2" x2="12" y2="5" />
                        <line x1="12" y1="19" x2="12" y2="22" />
                      </svg>
                    )}
                    {sec.iconName === "crowd" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    )}
                    {sec.iconName === "traffic" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="17 1 21 5 17 9" />
                        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                        <polyline points="7 23 3 19 7 15" />
                        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                      </svg>
                    )}
                    {sec.iconName === "trends" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="20" x2="18" y2="10" />
                        <line x1="12" y1="20" x2="12" y2="4" />
                        <line x1="6" y1="20" x2="6" y2="14" />
                      </svg>
                    )}
                  </span>
                  <span className="tab-label">{sec.label}</span>
                  {sec.id === "crowd" && crowdedCameras.length > 0 && (
                    <span className="tab-tag" style={{ background: "#ef4444", color: "#fff", borderColor: "#ef4444" }}>
                      {crowdedCameras.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ========================================================================= */}
          {/* TAB 1: LIVE CAMERA COUNTS */}
          {/* ========================================================================= */}
          {tab === "live" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "1 1 220px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Search Camera or Zone</span>
                    <input
                      type="text"
                      className="input"
                      placeholder="Type camera name, ID, or zone…"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setLivePage(1);
                      }}
                    />
                  </label>

                  {departments.length > 0 && (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>Department</span>
                      <select
                        className="input"
                        value={deptFilter}
                        onChange={(e) => {
                          setDeptFilter(e.target.value);
                          setLivePage(1);
                        }}
                      >
                        <option value="">All Departments</option>
                        {departments.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Sort Cameras By</span>
                    <select
                      className="input"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                    >
                      <option value="activity">Total Activity (Vehicles + People)</option>
                      <option value="people">Highest People Count</option>
                      <option value="vehicles">Highest Vehicle Count</option>
                      <option value="name">Camera Name (A-Z)</option>
                    </select>
                  </label>

                  {(search || deptFilter) && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        setSearch("");
                        setDeptFilter("");
                        setLivePage(1);
                      }}
                    >
                      Reset Filters
                    </button>
                  )}
                </div>
              </div>

              {/* Live Cameras Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {filteredLiveCameras.length} cameras monitored
                  </h3>
                  <span className="small muted">
                    Showing page {livePage} of {totalLivePages} ({filteredLiveCameras.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Camera Node</th>
                        <th style={{ width: 110 }}>Department</th>
                        <th style={{ width: 110 }}>Vehicles</th>
                        <th style={{ width: 110 }}>People</th>
                        <th style={{ width: 130 }}>Status</th>
                        <th style={{ width: 140 }}>Capacity</th>
                        <th style={{ width: 110 }}>Flow</th>
                        <th style={{ textAlign: "right", width: 130 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedLiveCameras.length > 0 ? (
                        pagedLiveCameras.map((cam) => {
                          const pct = Math.min(100, Math.round(((cam.p ?? 0) / Math.max(1, cam.max)) * 100));
                          const hasSignal = cam.v != null || cam.p != null;

                          return (
                            <tr key={cam.id}>
                              {/* Camera Node */}
                              <td>
                                <div style={{ fontWeight: 600 }}>{cam.name}</div>
                                <div className="mono muted" style={{ fontSize: 11 }}>{cam.id}</div>
                              </td>

                              {/* Department */}
                              <td>
                                {cam.dept ? (
                                  <span className={`dept-${cam.dept}`} style={{ fontSize: 11, fontWeight: 500 }}>
                                    {cam.dept}
                                  </span>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Vehicles Now */}
                              <td>
                                {cam.v != null ? (
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 6,
                                      fontWeight: 700,
                                      fontSize: 14,
                                      color: "#10b981",
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                                      <rect x="2" y="7" width="20" height="13" rx="2" />
                                      <path d="M16 7V4a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v3" />
                                      <circle cx="7" cy="14" r="1.5" />
                                      <circle cx="17" cy="14" r="1.5" />
                                    </svg>
                                    {cam.v}
                                  </span>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* People Now */}
                              <td>
                                {cam.p != null ? (
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 6,
                                      fontWeight: 700,
                                      fontSize: 14,
                                      color: cam.isCrowded ? "#ef4444" : cam.isBusy ? "#f59e0b" : "#3b82f6",
                                    }}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                      <circle cx="9" cy="7" r="4" />
                                    </svg>
                                    {cam.p}
                                  </span>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Occupancy Status */}
                              <td>
                                {!hasSignal ? (
                                  <span className="small muted">No signal</span>
                                ) : cam.isCrowded ? (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      textTransform: "uppercase",
                                      padding: "3px 8px",
                                      borderRadius: 4,
                                      background: "rgba(239, 68, 68, 0.15)",
                                      color: "#ef4444",
                                    }}
                                  >
                                    🚨 Crowded ({cam.p}/{cam.max})
                                  </span>
                                ) : cam.isBusy ? (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      textTransform: "uppercase",
                                      padding: "3px 8px",
                                      borderRadius: 4,
                                      background: "rgba(245, 158, 11, 0.15)",
                                      color: "#f59e0b",
                                    }}
                                  >
                                    ▲ Busy ({cam.p}/{cam.max})
                                  </span>
                                ) : (
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      padding: "3px 8px",
                                      borderRadius: 4,
                                      background: "rgba(16, 185, 129, 0.12)",
                                      color: "#10b981",
                                    }}
                                  >
                                    Normal ({cam.p ?? 0}/{cam.max})
                                  </span>
                                )}
                              </td>

                              {/* Capacity Meter */}
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <div
                                    style={{
                                      width: "100%",
                                      height: 6,
                                      background: "var(--line)",
                                      borderRadius: 3,
                                      overflow: "hidden",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: `${pct}%`,
                                        height: "100%",
                                        background: cam.isCrowded ? "#ef4444" : cam.isBusy ? "#f59e0b" : "#3b82f6",
                                        borderRadius: 3,
                                        transition: "width 0.4s ease",
                                      }}
                                    />
                                  </div>
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)" }}>
                                    <span>{pct}% capacity</span>
                                    <span>Limit: {cam.max}</span>
                                  </div>
                                </div>
                              </td>

                              {/* Line Flow */}
                              <td>
                                {cam.flowAB || cam.flowBA ? (
                                  <span style={{ fontSize: 11, fontWeight: 500 }}>
                                    <span style={{ color: "#10b981" }}>{cam.flowAB} →</span> · <span style={{ color: "#3b82f6" }}>{cam.flowBA} ←</span>
                                  </span>
                                ) : (
                                  <span className="small muted">No line trigger</span>
                                )}
                              </td>

                              {/* Actions */}
                              <td style={{ textAlign: "right" }}>
                                <div style={{ display: "inline-flex", gap: 6 }}>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => navigate(`/playback?cam=${encodeURIComponent(cam.id)}`)}
                                    title="View recorded playback for this camera"
                                  >
                                    Playback
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => setPreviewCam(cam)}
                                    title="Quick live inspection modal"
                                  >
                                    Inspect
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={8} className="muted" style={{ textAlign: "center", padding: "36px 16px" }}>
                            {loading ? "Polling camera analytics…" : "No cameras matching current count filters."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={livePage}
                    pages={totalLivePages}
                    total={filteredLiveCameras.length}
                    onPage={setLivePage}
                    size={livePageSize}
                    onSize={setLivePageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 2: CROWD & OCCUPANCY */}
          {/* ========================================================================= */}
          {tab === "crowd" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 220, flex: "1 1 220px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Filter Camera or Zone</span>
                    <input
                      type="text"
                      className="input"
                      placeholder="Filter crowd areas…"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setCrowdPage(1);
                      }}
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Crowd Status</span>
                    <select
                      className="input"
                      value={crowdFilter}
                      onChange={(e) => {
                        setCrowdFilter(e.target.value);
                        setCrowdPage(1);
                      }}
                    >
                      <option value="all">All Cameras ({mergedCameras.length})</option>
                      <option value="crowded">🚨 Exceeding Limit ({crowdedCameras.length})</option>
                      <option value="busy">▲ Busy &gt;70% ({busyCameras.length})</option>
                      <option value="normal">Normal Occupancy</option>
                    </select>
                  </label>

                  {departments.length > 0 && (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>Department</span>
                      <select
                        className="input"
                        value={deptFilter}
                        onChange={(e) => {
                          setDeptFilter(e.target.value);
                          setCrowdPage(1);
                        }}
                      >
                        <option value="">All Departments</option>
                        {departments.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>

              {/* Crowd Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {filteredCrowdCameras.length} crowd surveillance nodes
                  </h3>
                  <span className="small muted">
                    Showing page {crowdPage} of {totalCrowdPages} ({filteredCrowdCameras.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Camera / Location</th>
                        <th style={{ width: 100 }}>People</th>
                        <th style={{ width: 110 }}>Safe Limit</th>
                        <th style={{ width: 140 }}>Occupancy</th>
                        <th style={{ width: 100 }}>Period Avg</th>
                        <th style={{ width: 100 }}>Period Peak</th>
                        <th style={{ width: 150 }}>Trend ({hours}h)</th>
                        <th style={{ textAlign: "right", width: 90 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedCrowdCameras.length > 0 ? (
                        pagedCrowdCameras.map((cam) => {
                          const pct = Math.round(((cam.p ?? 0) / Math.max(1, cam.max)) * 100);
                          const pts = cam.points || [];
                          const mp = Math.max(1, ...pts.map((p) => p[2]));

                          return (
                            <tr key={cam.id}>
                              {/* Camera / Location */}
                              <td>
                                <div style={{ fontWeight: 600 }}>{cam.name}</div>
                                <div className="mono muted" style={{ fontSize: 11 }}>{cam.id}</div>
                                {cam.dept && <span className={`dept-${cam.dept}`} style={{ fontSize: 10 }}>{cam.dept}</span>}
                              </td>

                              {/* People Now */}
                              <td>
                                <span
                                  style={{
                                    fontWeight: 700,
                                    fontSize: 16,
                                    color: cam.isCrowded ? "#ef4444" : cam.isBusy ? "#f59e0b" : "#3b82f6",
                                  }}
                                >
                                  {cam.p ?? "—"}
                                </span>
                              </td>

                              {/* Safe Limit */}
                              <td>
                                <span style={{ fontWeight: 600 }}>{cam.max} persons</span>
                              </td>

                              {/* Occupancy % */}
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      color: cam.isCrowded ? "#ef4444" : cam.isBusy ? "#f59e0b" : "#10b981",
                                    }}
                                  >
                                    {pct}% {cam.isCrowded ? "OVER CAPACITY" : cam.isBusy ? "NEAR LIMIT" : "OK"}
                                  </span>
                                  <div
                                    style={{
                                      width: "100%",
                                      height: 6,
                                      background: "var(--line)",
                                      borderRadius: 3,
                                      overflow: "hidden",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: `${Math.min(100, pct)}%`,
                                        height: "100%",
                                        background: cam.isCrowded ? "#ef4444" : cam.isBusy ? "#f59e0b" : "#10b981",
                                        borderRadius: 3,
                                      }}
                                    />
                                  </div>
                                </div>
                              </td>

                              {/* Period Avg */}
                              <td>
                                <span style={{ fontWeight: 500 }}>{cam.avgP ?? "—"}</span>
                              </td>

                              {/* Period Peak */}
                              <td>
                                <span style={{ fontWeight: 700, color: (cam.peakP || 0) > cam.max ? "#ef4444" : "var(--text)" }}>
                                  {cam.peakP ?? "—"}
                                </span>
                              </td>

                              {/* Crowd Trend */}
                              <td>
                                <Sparkline points={pts} idx={2} color="#ef476f" max={mp} width={120} height={26} label="Crowd" />
                              </td>

                              {/* Actions */}
                              <td style={{ textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  onClick={() => navigate(`/alerts/incidents`)}
                                  title="View perimeter alarms"
                                >
                                  Alarms
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={8} className="muted" style={{ textAlign: "center", padding: "36px 16px" }}>
                            No crowd cameras found matching selected filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={crowdPage}
                    pages={totalCrowdPages}
                    total={filteredCrowdCameras.length}
                    onPage={setCrowdPage}
                    size={crowdPageSize}
                    onSize={setCrowdPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 3: TRAFFIC & LINE FLOW */}
          {/* ========================================================================= */}
          {tab === "traffic" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Filter Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 240, flex: "1 1 240px" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>Filter Traffic Lanes</span>
                    <input
                      type="text"
                      className="input"
                      placeholder="Search traffic camera name…"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setTrafficPage(1);
                      }}
                    />
                  </label>

                  <div style={{ fontSize: 12, color: "var(--muted)", paddingBottom: 8 }}>
                    {trafficData.rows.length} one-minute windows telemetry analyzed over the last {hours} hour(s)
                  </div>
                </div>
              </div>

              {/* Traffic Summary Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {filteredTrafficRows.length} traffic count locations
                  </h3>
                  <span className="small muted">
                    Showing page {trafficPage} of {totalTrafficPages} ({filteredTrafficRows.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Camera / Intersection</th>
                        <th style={{ width: 90 }}>Windows</th>
                        <th style={{ width: 100 }}>Avg Veh</th>
                        <th style={{ width: 100 }}>Peak Veh</th>
                        <th style={{ width: 90 }}>Avg Ppl</th>
                        <th style={{ minWidth: 160 }}>Class Breakdown</th>
                        <th style={{ width: 100 }}>Flow (A→B)</th>
                        <th style={{ width: 100 }}>Flow (B→A)</th>
                        <th style={{ width: 110 }}>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedTrafficRows.length > 0 ? (
                        pagedTrafficRows.map((tr, idx) => {
                          const classEntries = Object.entries(tr.by_class || {}).sort((a, b) => b[1] - a[1]);

                          return (
                            <tr key={`${tr.camera_name}-${idx}`}>
                              {/* Camera / Intersection */}
                              <td>
                                <div style={{ fontWeight: 600 }}>{tr.camera_name}</div>
                              </td>

                              {/* Windows */}
                              <td>
                                <span className="mono">{tr.windows} min</span>
                              </td>

                              {/* Avg Vehicles */}
                              <td>
                                <span style={{ fontWeight: 700, color: "#10b981" }}>{tr.avg_vehicles}</span>
                              </td>

                              {/* Peak Vehicles */}
                              <td>
                                <span style={{ fontWeight: 700 }}>{tr.peak_vehicles}</span>
                              </td>

                              {/* Avg People */}
                              <td>
                                <span>{tr.avg_persons ?? 0}</span>
                              </td>

                              {/* Class Breakdown */}
                              <td>
                                {classEntries.length > 0 ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                    {classEntries.slice(0, 4).map(([cls, count]) => (
                                      <span
                                        key={cls}
                                        style={{
                                          fontSize: 10,
                                          fontWeight: 600,
                                          padding: "2px 6px",
                                          borderRadius: 4,
                                          background: "rgba(255, 255, 255, 0.06)",
                                          border: "1px solid var(--line)",
                                          textTransform: "capitalize",
                                        }}
                                      >
                                        {cls}: {count}
                                      </span>
                                    ))}
                                    {classEntries.length > 4 && (
                                      <span className="small muted">+{classEntries.length - 4} more</span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>

                              {/* Flow A -> B */}
                              <td>
                                <span style={{ fontWeight: 600, color: "#10b981" }}>
                                  {tr.flow?.a_to_b ? `${tr.flow.a_to_b} →` : "—"}
                                </span>
                              </td>

                              {/* Flow B -> A */}
                              <td>
                                <span style={{ fontWeight: 600, color: "#3b82f6" }}>
                                  {tr.flow?.b_to_a ? `${tr.flow.b_to_a} ←` : "—"}
                                </span>
                              </td>

                              {/* Last Update */}
                              <td>
                                <span className="small muted">{tr.last || "recent"}</span>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={9} className="muted" style={{ textAlign: "center", padding: "36px 16px" }}>
                            No traffic line-crossing counts yet. Ensure cameras have directional counting enabled in analytics configuration.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={trafficPage}
                    pages={totalTrafficPages}
                    total={filteredTrafficRows.length}
                    onPage={setTrafficPage}
                    size={trafficPageSize}
                    onSize={setTrafficPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* TAB 4: TIMELINE TRENDS */}
          {/* ========================================================================= */}
          {tab === "trends" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Legend & Controls Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 14, height: 3, background: "#06d6a0", borderRadius: 2 }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>Vehicles per min</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 14, height: 3, background: "#ef476f", borderRadius: 2 }} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>People per min</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    Timeline Resolution: 1-minute aggregations across {hours} hour(s)
                  </div>
                </div>
              </div>

              {/* Trends Table Panel */}
              <div className="panel" style={{ padding: "16px 20px", background: "var(--panel)" }}>
                <div className="panel-head" style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                    {filteredTrendsCameras.length} camera timeline waveforms
                  </h3>
                  <span className="small muted">
                    Showing page {trendsPage} of {totalTrendsPages} ({filteredTrendsCameras.length} total)
                  </span>
                </div>

                <div className="table-wrap" style={{ overflowX: "auto" }}>
                  <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th>Camera Node</th>
                        <th style={{ width: 100 }}>Avg Veh</th>
                        <th style={{ width: 100 }}>Peak Veh</th>
                        <th style={{ width: 100 }}>Avg Ppl</th>
                        <th style={{ width: 100 }}>Peak Ppl</th>
                        <th style={{ width: 140 }}>Vehicles Waveform</th>
                        <th style={{ width: 140 }}>Crowd Waveform</th>
                        <th style={{ width: 110 }}>Net Flow</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedTrendsCameras.length > 0 ? (
                        pagedTrendsCameras.map((cam) => {
                          const pts = cam.points || [];
                          const mv = Math.max(1, ...pts.map((p) => p[1]));
                          const mp = Math.max(1, ...pts.map((p) => p[2]));

                          return (
                            <tr key={cam.id}>
                              {/* Camera Node */}
                              <td>
                                <div style={{ fontWeight: 600 }}>{cam.name}</div>
                                <div className="mono muted" style={{ fontSize: 11 }}>{cam.id}</div>
                              </td>

                              {/* Avg Vehicles */}
                              <td>
                                <span style={{ fontWeight: 600, color: "#10b981" }}>{cam.avgV ?? "—"}</span>
                              </td>

                              {/* Peak Vehicles */}
                              <td>
                                <span style={{ fontWeight: 700 }}>{cam.peakV ?? "—"}</span>
                              </td>

                              {/* Avg People */}
                              <td>
                                <span style={{ fontWeight: 600, color: "#3b82f6" }}>{cam.avgP ?? "—"}</span>
                              </td>

                              {/* Peak People */}
                              <td>
                                <span style={{ fontWeight: 700, color: (cam.peakP || 0) > cam.max ? "#ef4444" : "var(--text)" }}>
                                  {cam.peakP ?? "—"}
                                </span>
                              </td>

                              {/* Vehicles Sparkline */}
                              <td>
                                <Sparkline points={pts} idx={1} color="#06d6a0" max={mv} width={120} height={26} label="Vehicles" />
                              </td>

                              {/* Crowd Sparkline */}
                              <td>
                                <Sparkline points={pts} idx={2} color="#ef476f" max={mp} width={120} height={26} label="Crowd" />
                              </td>

                              {/* Net Flow */}
                              <td>
                                {cam.flowAB || cam.flowBA ? (
                                  <span style={{ fontSize: 11, fontWeight: 600 }}>
                                    {cam.flowAB} → · {cam.flowBA} ←
                                  </span>
                                ) : (
                                  <span className="small muted">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={8} className="muted" style={{ textAlign: "center", padding: "36px 16px" }}>
                            No trend data available for current period.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{ marginTop: 14 }}>
                  <Pager
                    page={trendsPage}
                    pages={totalTrendsPages}
                    total={filteredTrendsCameras.length}
                    onPage={setTrendsPage}
                    size={trendsPageSize}
                    onSize={setTrendsPageSize}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Quick Inspection Modal */}
          {previewCam && (
            <div
              className="modal-overlay"
              onClick={() => setPreviewCam(null)}
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: "rgba(0,0,0,0.75)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
            >
              <div
                className="panel"
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 540,
                  maxWidth: "92vw",
                  padding: 24,
                  background: "var(--panel)",
                  borderRadius: 12,
                  boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{previewCam.name}</h3>
                    <div className="mono muted" style={{ fontSize: 12 }}>{previewCam.id}</div>
                  </div>
                  <button type="button" className="btn ghost small" onClick={() => setPreviewCam(null)}>✕</button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
                  <div style={{ background: "var(--bg)", padding: 12, borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>Vehicles in View</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: "#10b981" }}>{previewCam.v ?? "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Avg: {previewCam.avgV ?? "—"} · Peak: {previewCam.peakV ?? "—"}</div>
                  </div>

                  <div style={{ background: "var(--bg)", padding: 12, borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>People in View</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: previewCam.isCrowded ? "#ef4444" : "#3b82f6" }}>
                      {previewCam.p ?? "—"}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Limit: {previewCam.max} · Peak: {previewCam.peakP ?? "—"}</div>
                  </div>
                </div>

                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Recent Activity Waveform</div>
                  <div style={{ background: "var(--bg)", padding: 12, borderRadius: 8, display: "flex", gap: 16, alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>Vehicles</div>
                      <Sparkline points={previewCam.points} idx={1} color="#06d6a0" max={Math.max(1, previewCam.peakV || 1)} width={180} height={32} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>Crowd</div>
                      <Sparkline points={previewCam.points} idx={2} color="#ef476f" max={Math.max(1, previewCam.peakP || 1)} width={180} height={32} />
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      const id = previewCam.id;
                      setPreviewCam(null);
                      navigate(`/playback?cam=${encodeURIComponent(id)}`);
                    }}
                  >
                    Open Playback
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => {
                      setPreviewCam(null);
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
