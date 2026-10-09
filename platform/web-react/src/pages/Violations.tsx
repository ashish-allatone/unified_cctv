import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, token, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface ViolationsSectionItem {
  id: string;
  tabKey: "challans" | "incidents" | "review" | "accuracy" | "traffic";
  label: string;
  desc: string;
  iconName: "challans" | "incidents" | "review" | "accuracy" | "traffic";
}

export const VIOLATIONS_SECTIONS: ViolationsSectionItem[] = [
  {
    id: "challans",
    tabKey: "challans",
    label: "Challans",
    desc: "e-Challan drafting, review, approval & evidence packs",
    iconName: "challans",
  },
  {
    id: "incidents",
    tabKey: "incidents",
    label: "Zone Incidents",
    desc: "Real-time automated rule and zone violations",
    iconName: "incidents",
  },
  {
    id: "review",
    tabKey: "review",
    label: "Plate Review Queue",
    desc: "Human-in-the-loop OCR verification and correction",
    iconName: "review",
  },
  {
    id: "accuracy",
    tabKey: "accuracy",
    label: "ANPR Accuracy",
    desc: "Weekly recognition metrics, error stats & retraining sets",
    iconName: "accuracy",
  },
  {
    id: "traffic",
    tabKey: "traffic",
    label: "Traffic Counts",
    desc: "Directional flow counts, vehicle density & peak load",
    iconName: "traffic",
  },
];

export interface ChallanItem {
  id: string;
  number: string;
  repeat?: boolean;
  ts: string;
  plate: string;
  plate_masked?: boolean;
  label: string;
  section: string;
  fine_inr: number;
  camera_id: string;
  crop_url?: string;
  frame_url?: string;
  status: "draft" | "approved" | "sent" | "failed" | "rejected" | string;
  external_ref?: string;
  remarks?: string;
}

export interface ZoneIncident {
  id: string;
  ts: string;
  kind: string;
  label: string;
  priority: "high" | "medium" | "low" | string;
  zone?: string;
  camera_id: string;
  plate?: string;
  detail?: Record<string, any>;
  snapshot_url?: string;
  ack_by?: string | null;
}

export interface ReviewQueueEvent {
  id: string;
  ts: string;
  plate: string;
  confidence: number;
  crop_url?: string;
  frame_url?: string;
  camera_id: string;
  tags?: string[];
}

export interface AnprCameraAccuracy {
  camera_id?: string;
  camera_name: string;
  reads: number;
  reviewed: number;
  accuracy_pct: number | null;
  mean_confidence: number;
  low_confidence_pct: number;
  invalid_format_pct: number;
  night_pct: number;
  top_reasons: [string, number][];
}

export interface AnprReportData {
  week_start: string;
  week_end: string;
  reads: number;
  reviewed: number;
  accuracy_pct: number | null;
  note: string;
  cameras: AnprCameraAccuracy[];
}

export interface TrafficCameraSummary {
  camera_name: string;
  windows: number;
  avg_vehicles: number;
  peak_vehicles: number;
  avg_persons: number;
  by_class: Record<string, number>;
  flow: {
    a_to_b?: number;
    b_to_a?: number;
  };
  last: string;
}

export interface TrafficReportData {
  rows: any[];
  summary: TrafficCameraSummary[];
}

export interface OffenceRule {
  label: string;
  fine_inr: number;
  repeat_inr: number;
  section?: string;
}

export default function Violations() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();

  const canReviewChallans = has("alerts_ack");
  const canAckIncidents = has("alerts_ack");
  const canExport = has("export");

  // Tab mapping
  const tabFromSection = useMemo<"challans" | "incidents" | "review" | "accuracy" | "traffic">(() => {
    if (!section || section === "challans") return "challans";
    if (section === "incidents" || section === "zones") return "incidents";
    if (section === "review" || section === "plate-review") return "review";
    if (section === "accuracy" || section === "anpr") return "accuracy";
    if (section === "traffic" || section === "counts") return "traffic";
    return "challans";
  }, [section]);

  const [tab, setTab] = useState<"challans" | "incidents" | "review" | "accuracy" | "traffic">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "challans" | "incidents" | "review" | "accuracy" | "traffic") => {
    setTab(nextTab);
    navigate(`/violations/${nextTab}`);
  };

  // Common metadata
  const [cameras, setCameras] = useState<Record<string, { id: string; name: string; department?: string }>>({});
  const [stats, setStats] = useState<{ incidents: Record<string, number>; challans: Record<string, number> }>({
    incidents: {},
    challans: {},
  });
  const [offences, setOffences] = useState<Record<string, OffenceRule>>({});
  const [loading, setLoading] = useState(false);

  // Challans state
  const [challans, setChallans] = useState<ChallanItem[]>([]);
  const [challanStatus, setChallanStatus] = useState<string>("all");
  const [challanSearch, setChallanSearch] = useState("");
  const [challanPage, setChallanPage] = useState(1);
  const [challanPageSize, setChallanPageSize] = useState(25);

  // Review Challan Modal
  const [reviewModal, setReviewModal] = useState<{
    open: boolean;
    challan: ChallanItem | null;
    action: "approve" | "reject";
    remarks: string;
    submitting: boolean;
  }>({
    open: false,
    challan: null,
    action: "approve",
    remarks: "",
    submitting: false,
  });

  // Incidents state
  const [incidents, setIncidents] = useState<ZoneIncident[]>([]);
  const [incidentsOpenOnly, setIncidentsOpenOnly] = useState(true);
  const [incidentPriority, setIncidentPriority] = useState<string>("all");
  const [incidentSearch, setIncidentSearch] = useState("");
  const [incidentPage, setIncidentPage] = useState(1);
  const [incidentPageSize, setIncidentPageSize] = useState(25);

  // Review Queue state
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueEvent[]>([]);
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewPageSize, setReviewPageSize] = useState(25);

  // Plate Correction Modal
  const [correctModal, setCorrectModal] = useState<{
    open: boolean;
    event: ReviewQueueEvent | null;
    newPlate: string;
    reason: string;
    submitting: boolean;
  }>({
    open: false,
    event: null,
    newPlate: "",
    reason: "OCR misread",
    submitting: false,
  });

  // Accuracy state
  const [accuracyWeek, setAccuracyWeek] = useState<number>(0);
  const [accuracyReport, setAccuracyReport] = useState<AnprReportData | null>(null);
  const [accuracySearch, setAccuracySearch] = useState("");
  const [accuracyPage, setAccuracyPage] = useState(1);
  const [accuracyPageSize, setAccuracyPageSize] = useState(25);

  // Traffic state
  const [trafficHours, setTrafficHours] = useState<number>(24);
  const [trafficData, setTrafficData] = useState<TrafficReportData | null>(null);
  const [trafficSearch, setTrafficSearch] = useState("");
  const [trafficPage, setTrafficPage] = useState(1);
  const [trafficPageSize, setTrafficPageSize] = useState(25);

  // Enlarged Photo Viewer Modal
  const [previewPhoto, setPreviewPhoto] = useState<{
    open: boolean;
    url: string;
    title: string;
    subtitle?: string;
  }>({
    open: false,
    url: "",
    title: "",
  });

  // Load cameras lookup once
  useEffect(() => {
    api<Array<{ id: string; name: string; department?: string }>>("/api/cameras")
      .then((cams) => {
        const map: Record<string, { id: string; name: string; department?: string }> = {};
        cams.forEach((c) => {
          map[c.id] = c;
        });
        setCameras(map);
      })
      .catch(() => {});
  }, []);

  // Fetch KPI stats and offences schedule
  const loadKpis = useCallback(async () => {
    try {
      const [st, offs] = await Promise.all([
        api<{ incidents: Record<string, number>; challans: Record<string, number> }>("/api/incidents/stats?hours=24").catch(() => ({ incidents: {}, challans: {} })),
        api<Record<string, OffenceRule>>("/api/offences").catch(() => ({})),
      ]);
      setStats(st);
      setOffences(offs);
    } catch {
      // ignore
    }
  }, []);

  // Load Challans
  const loadChallans = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ChallanItem[]>(`/api/challans?status=${encodeURIComponent(challanStatus)}`);
      setChallans(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e.message || "Failed to load challans", "err");
      setChallans([]);
    } finally {
      setLoading(false);
    }
  }, [challanStatus]);

  // Load Incidents
  const loadIncidents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ZoneIncident[]>(`/api/incidents?open_only=${incidentsOpenOnly}&limit=1000`);
      setIncidents(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e.message || "Failed to load incidents", "err");
      setIncidents([]);
    } finally {
      setLoading(false);
    }
  }, [incidentsOpenOnly]);

  // Load Review Queue
  const loadReviewQueue = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<ReviewQueueEvent[]>("/api/reports/anpr/review-queue?limit=200");
      setReviewQueue(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e.message || "Failed to load review queue", "err");
      setReviewQueue([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load Accuracy Report
  const loadAccuracy = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<AnprReportData>(`/api/reports/anpr?weeks_ago=${accuracyWeek}`);
      setAccuracyReport(data);
    } catch (e: any) {
      toast(e.message || "Failed to load ANPR accuracy report", "err");
      setAccuracyReport(null);
    } finally {
      setLoading(false);
    }
  }, [accuracyWeek]);

  // Load Traffic Data
  const loadTraffic = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<TrafficReportData>(`/api/traffic?hours=${trafficHours}`);
      setTrafficData(data);
    } catch (e: any) {
      toast(e.message || "Failed to load traffic counts", "err");
      setTrafficData(null);
    } finally {
      setLoading(false);
    }
  }, [trafficHours]);

  // Main data trigger based on active tab
  useEffect(() => {
    loadKpis();
    if (tab === "challans") {
      loadChallans();
    } else if (tab === "incidents") {
      loadIncidents();
    } else if (tab === "review") {
      loadReviewQueue();
    } else if (tab === "accuracy") {
      loadAccuracy();
    } else if (tab === "traffic") {
      loadTraffic();
    }
  }, [tab, loadKpis, loadChallans, loadIncidents, loadReviewQueue, loadAccuracy, loadTraffic]);

  // Reset page when search changes
  useEffect(() => {
    setChallanPage(1);
  }, [challanSearch, challanStatus]);

  useEffect(() => {
    setIncidentPage(1);
  }, [incidentSearch, incidentPriority, incidentsOpenOnly]);

  useEffect(() => {
    setReviewPage(1);
  }, [reviewSearch]);

  useEffect(() => {
    setAccuracyPage(1);
  }, [accuracySearch, accuracyWeek]);

  useEffect(() => {
    setTrafficPage(1);
  }, [trafficSearch, trafficHours]);

  // Handle Challan Review Submission
  const submitChallanReview = async () => {
    if (!reviewModal.challan) return;
    setReviewModal((m) => ({ ...m, submitting: true }));
    try {
      const res = await api<{ number: string; status: string; external_ref?: string }>(
        `/api/challans/${reviewModal.challan.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            action: reviewModal.action,
            remarks: reviewModal.remarks.trim(),
          }),
        }
      );
      toast(
        `${res.number}: ${res.status}${res.external_ref ? " · " + res.external_ref : ""}`,
        res.status === "failed" ? "err" : "ok"
      );
      setReviewModal({ open: false, challan: null, action: "approve", remarks: "", submitting: false });
      loadChallans();
      loadKpis();
    } catch (e: any) {
      toast(e.message || "Failed to update challan", "err");
      setReviewModal((m) => ({ ...m, submitting: false }));
    }
  };

  // Acknowledge Incident
  const handleAckIncident = async (id: string) => {
    try {
      await api(`/api/incidents/${id}/ack`, { method: "POST" });
      toast("Incident marked as acknowledged", "ok");
      loadIncidents();
      loadKpis();
    } catch (e: any) {
      toast(e.message || "Failed to acknowledge incident", "err");
    }
  };

  // Confirm Plate in Review Queue
  const handleConfirmPlate = async (id: string) => {
    try {
      await api(`/api/events/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ verdict: "confirmed" }),
      });
      toast("Plate read confirmed", "ok");
      loadReviewQueue();
      loadKpis();
    } catch (e: any) {
      toast(e.message || "Failed to confirm plate", "err");
    }
  };

  // Submit Plate Correction
  const submitPlateCorrection = async () => {
    if (!correctModal.event || !correctModal.newPlate.trim()) return;
    setCorrectModal((m) => ({ ...m, submitting: true }));
    try {
      const res = await api<{ verdict: string; plate?: string }>(
        `/api/events/${correctModal.event.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            verdict: "corrected",
            true_plate: correctModal.newPlate.trim().toUpperCase(),
            reason: correctModal.reason,
          }),
        }
      );
      toast(`Saved: ${res.verdict}${res.plate ? " → " + res.plate : ""}`, "ok");
      setCorrectModal({ open: false, event: null, newPlate: "", reason: "OCR misread", submitting: false });
      loadReviewQueue();
      loadKpis();
    } catch (e: any) {
      toast(e.message || "Failed to correct plate", "err");
      setCorrectModal((m) => ({ ...m, submitting: false }));
    }
  };

  // Filtered & Paginated Challans
  const filteredChallans = useMemo(() => {
    const q = challanSearch.trim().toLowerCase();
    return challans.filter((c) => {
      if (q) {
        const camName = cameras[c.camera_id]?.name || c.camera_id;
        const match =
          c.number.toLowerCase().includes(q) ||
          c.plate.toLowerCase().includes(q) ||
          c.label.toLowerCase().includes(q) ||
          c.section.toLowerCase().includes(q) ||
          camName.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [challans, challanSearch, cameras]);

  const pagedChallans = useMemo(() => {
    const start = (challanPage - 1) * challanPageSize;
    return filteredChallans.slice(start, start + challanPageSize);
  }, [filteredChallans, challanPage, challanPageSize]);

  // Filtered & Paginated Incidents
  const filteredIncidents = useMemo(() => {
    const q = incidentSearch.trim().toLowerCase();
    return incidents.filter((i) => {
      if (incidentPriority !== "all" && i.priority !== incidentPriority) return false;
      if (q) {
        const camName = cameras[i.camera_id]?.name || i.camera_id;
        const match =
          i.label.toLowerCase().includes(q) ||
          (i.zone || "").toLowerCase().includes(q) ||
          (i.plate || "").toLowerCase().includes(q) ||
          camName.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [incidents, incidentSearch, incidentPriority, cameras]);

  const pagedIncidents = useMemo(() => {
    const start = (incidentPage - 1) * incidentPageSize;
    return filteredIncidents.slice(start, start + incidentPageSize);
  }, [filteredIncidents, incidentPage, incidentPageSize]);

  // Filtered & Paginated Review Queue
  const filteredReviewQueue = useMemo(() => {
    const q = reviewSearch.trim().toLowerCase();
    return reviewQueue.filter((e) => {
      if (q) {
        const camName = cameras[e.camera_id]?.name || e.camera_id;
        const match =
          e.plate.toLowerCase().includes(q) ||
          camName.toLowerCase().includes(q) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(q));
        if (!match) return false;
      }
      return true;
    });
  }, [reviewQueue, reviewSearch, cameras]);

  const pagedReviewQueue = useMemo(() => {
    const start = (reviewPage - 1) * reviewPageSize;
    return filteredReviewQueue.slice(start, start + reviewPageSize);
  }, [filteredReviewQueue, reviewPage, reviewPageSize]);

  // Filtered & Paginated Accuracy Cameras
  const filteredAccuracyCameras = useMemo(() => {
    const q = accuracySearch.trim().toLowerCase();
    const list = accuracyReport?.cameras || [];
    return list.filter((c) => {
      if (q && !c.camera_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [accuracyReport, accuracySearch]);

  const pagedAccuracyCameras = useMemo(() => {
    const start = (accuracyPage - 1) * accuracyPageSize;
    return filteredAccuracyCameras.slice(start, start + accuracyPageSize);
  }, [filteredAccuracyCameras, accuracyPage, accuracyPageSize]);

  // Filtered & Paginated Traffic Cameras
  const filteredTrafficCameras = useMemo(() => {
    const q = trafficSearch.trim().toLowerCase();
    const list = trafficData?.summary || [];
    return list.filter((c) => {
      if (q && !c.camera_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [trafficData, trafficSearch]);

  const pagedTrafficCameras = useMemo(() => {
    const start = (trafficPage - 1) * trafficPageSize;
    return filteredTrafficCameras.slice(start, start + trafficPageSize);
  }, [filteredTrafficCameras, trafficPage, trafficPageSize]);

  // Aggregated KPI numbers
  const totalIncidents24h = useMemo(() => {
    return Object.values(stats.incidents).reduce((a, b) => a + b, 0);
  }, [stats.incidents]);

  const draftChallansCount = useMemo(() => {
    return stats.challans["draft"] || 0;
  }, [stats.challans]);

  const approvedChallansCount = useMemo(() => {
    return (stats.challans["approved"] || 0) + (stats.challans["sent"] || 0);
  }, [stats.challans]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Violations & Traffic Analytics</h2>
              <p className="perm-page-desc">
                Automated MV Act challans, plate accuracy audit queue, zone analytics, and vehicle counts across city camera networks.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  loadKpis();
                  if (tab === "challans") loadChallans();
                  else if (tab === "incidents") loadIncidents();
                  else if (tab === "review") loadReviewQueue();
                  else if (tab === "accuracy") loadAccuracy();
                  else if (tab === "traffic") loadTraffic();
                }}
                disabled={loading}
                title="Refresh current violation feeds"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>

              {tab === "accuracy" && canExport && (
                <a
                  className="btn ghost small"
                  href={withTok("/api/reports/anpr/training-set.zip")}
                  title="Download OCR misread dataset for offline retraining"
                  download="anpr-retraining-set.zip"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Retraining Set
                </a>
              )}
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Incidents in 24h */}
            <div className="perm-kpi-card" title="Total automated rule & zone incidents flagged in the last 24 hours">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(239, 68, 68, 0.12)", color: "#ef4444" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Incidents (24h)</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{totalIncidents24h}</span>
                  <span className="kpi-sub-pill sober-pill">
                    {Object.keys(stats.incidents).length ? Object.keys(stats.incidents).length + " kinds" : "Active"}
                  </span>
                </div>
                <span className="kpi-desc">Zone alerts & safety breaches</span>
              </div>
            </div>

            {/* Challans Pending Review */}
            <div className="perm-kpi-card" title="Challans waiting for operator sign-off and approval">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line x1="7" y1="8" x2="17" y2="8" />
                  <line x1="7" y1="12" x2="13" y2="12" />
                  <line x1="7" y1="16" x2="11" y2="16" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Challans To Review</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{draftChallansCount}</span>
                  <span className="kpi-sub-pill sober-pill">{approvedChallansCount} Approved</span>
                </div>
                <span className="kpi-desc">Draft MV Act penalty records</span>
              </div>
            </div>

            {/* Plate Verification Queue */}
            <div className="perm-kpi-card" title="Sample plates awaiting human OCR verification for model retraining">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  <line x1="11" y1="8" x2="11" y2="14" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">OCR Review Queue</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{reviewQueue.length}</span>
                  <span className="kpi-sub-pill sober-pill">Pending Sample</span>
                </div>
                <span className="kpi-desc">Model confidence feedback loop</span>
              </div>
            </div>

            {/* Offence Fine Schedule */}
            <div className="perm-kpi-card" title="Active fine schedules configured in MV Act rules">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Rule Categories</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{Object.keys(offences).length}</span>
                  <span className="kpi-sub-pill sober-pill">MV Act 2019</span>
                </div>
                <span className="kpi-desc">Configured offence tariffs</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "challans" ? "active" : ""}`}
              onClick={() => handleTabChange("challans")}
              role="tab"
            >
              <span>Challans</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{challans.length}</span>
              {tab === "challans" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "incidents" ? "active" : ""}`}
              onClick={() => handleTabChange("incidents")}
              role="tab"
            >
              <span>Zone Incidents</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{incidents.length}</span>
              {tab === "incidents" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "review" ? "active" : ""}`}
              onClick={() => handleTabChange("review")}
              role="tab"
            >
              <span>Plate Review Queue</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{reviewQueue.length}</span>
              {tab === "review" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "accuracy" ? "active" : ""}`}
              onClick={() => handleTabChange("accuracy")}
              role="tab"
            >
              <span>ANPR Accuracy</span>
              {accuracyReport?.accuracy_pct != null && (
                <span className="tab-tag" style={{ marginLeft: 6 }}>{accuracyReport.accuracy_pct}%</span>
              )}
              {tab === "accuracy" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "traffic" ? "active" : ""}`}
              onClick={() => handleTabChange("traffic")}
              role="tab"
            >
              <span>Traffic Counts</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{trafficData?.summary?.length || 0}</span>
              {tab === "traffic" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TAB 1: CHALLANS
             ========================================================================= */}
          {tab === "challans" && (
            <div className="perm-panel-card">
              {/* Filter and Search Bar */}
              <div
                className="perm-panel-head"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div>
                  <h3 className="perm-panel-title" style={{ margin: 0, fontSize: 16 }}>
                    Traffic Challans & e-Challan Workflow
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Review captured offences, confirm state notification amounts, approve for e-Challan webhook dispatch, or export evidence bundles.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {/* Status Filter */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Status:</span>
                    <select
                      className="search-input"
                      style={{ padding: "4px 8px", fontSize: 12, height: 32, borderRadius: 6, width: 130 }}
                      value={challanStatus}
                      onChange={(e) => setChallanStatus(e.target.value)}
                    >
                      <option value="all">All statuses</option>
                      <option value="draft">Draft (to review)</option>
                      <option value="approved">Approved</option>
                      <option value="sent">Sent</option>
                      <option value="failed">Failed</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </label>

                  {/* Search Input */}
                  <div className="search-field" style={{ width: 240, position: "relative" }}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="search-ico"
                      style={{ position: "absolute", left: 10, top: 9, width: 14, height: 14, color: "var(--muted)" }}
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      className="search-input"
                      style={{ paddingLeft: 30, paddingRight: challanSearch ? 28 : 10, height: 32, fontSize: 12 }}
                      placeholder="Search plate, number, offence…"
                      value={challanSearch}
                      onChange={(e) => setChallanSearch(e.target.value)}
                    />
                    {challanSearch && (
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => setChallanSearch("")}
                        title="Clear search"
                        style={{ position: "absolute", right: 6, top: 6 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "10px 14px" }}>Challan No.</th>
                      <th style={{ padding: "10px 14px" }}>When (IST)</th>
                      <th style={{ padding: "10px 14px" }}>Plate</th>
                      <th style={{ padding: "10px 14px" }}>Offence</th>
                      <th style={{ padding: "10px 14px" }}>Section</th>
                      <th style={{ padding: "10px 14px" }}>Fine (INR)</th>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Evidence</th>
                      <th style={{ padding: "10px 14px" }}>Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && challans.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Loading challans…
                        </td>
                      </tr>
                    ) : pagedChallans.length === 0 ? (
                      <tr>
                        <td colSpan={10} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No challans found matching current status and search filters.
                        </td>
                      </tr>
                    ) : (
                      pagedChallans.map((c) => {
                        const cam = cameras[c.camera_id];
                        const camName = cam?.name || c.camera_id;
                        const evidenceSrc = c.crop_url ? withTok(c.crop_url) : c.frame_url ? withTok(c.frame_url) : null;
                        const fullFrameSrc = c.frame_url ? withTok(c.frame_url) : evidenceSrc;

                        return (
                          <tr key={c.id} className="perm-row">
                            {/* Challan No */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span>{c.number}</span>
                                {c.repeat && (
                                  <span
                                    className="tagchip"
                                    style={{
                                      background: "rgba(239, 68, 68, 0.15)",
                                      color: "#ef4444",
                                      fontSize: 10,
                                      padding: "1px 6px",
                                      borderRadius: 4,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    Repeat
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* When */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                              {fmtTime(c.ts)}
                            </td>

                            {/* Plate */}
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "3px 8px",
                                  background: "#fef08a",
                                  color: "#0f172a",
                                  border: "1px solid #ca8a04",
                                  borderRadius: 4,
                                  fontFamily: "monospace",
                                  fontWeight: 700,
                                  fontSize: 12,
                                  letterSpacing: "0.06em",
                                  filter: c.plate_masked ? "blur(2px)" : "none",
                                }}
                                title={c.plate_masked ? "Masked plate" : c.plate}
                              >
                                {c.plate}
                              </span>
                            </td>

                            {/* Offence */}
                            <td style={{ padding: "12px 14px", fontWeight: 500 }}>
                              {c.label}
                            </td>

                            {/* Section */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                              {c.section || "–"}
                            </td>

                            {/* Fine */}
                            <td style={{ padding: "12px 14px", fontWeight: 600, color: "var(--text)" }}>
                              ₹{c.fine_inr.toLocaleString("en-IN")}
                            </td>

                            {/* Camera */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ fontWeight: 500, fontSize: 12 }}>{camName}</div>
                              {cam?.department && (
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>{cam.department}</div>
                              )}
                            </td>

                            {/* Evidence Thumbnail */}
                            <td style={{ padding: "12px 14px" }}>
                              {evidenceSrc ? (
                                <img
                                  src={evidenceSrc}
                                  alt="Evidence"
                                  style={{
                                    width: 48,
                                    height: 32,
                                    objectFit: "cover",
                                    borderRadius: 4,
                                    border: "1px solid var(--line)",
                                    cursor: "pointer",
                                    verticalAlign: "middle",
                                  }}
                                  onClick={() =>
                                    setPreviewPhoto({
                                      open: true,
                                      url: fullFrameSrc || evidenceSrc,
                                      title: `Evidence: ${c.number} (${c.plate})`,
                                      subtitle: `${c.label} · ${camName} · ${fmtTime(c.ts)}`,
                                    })
                                  }
                                  title="Click to view enlarged full frame"
                                />
                              ) : (
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>No frame</span>
                              )}
                            </td>

                            {/* Status */}
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                  fontSize: 11,
                                  fontWeight: 600,
                                  textTransform: "capitalize",
                                  background:
                                    c.status === "approved" || c.status === "sent"
                                      ? "rgba(16, 185, 129, 0.15)"
                                      : c.status === "failed" || c.status === "rejected"
                                      ? "rgba(239, 68, 68, 0.15)"
                                      : "rgba(245, 158, 11, 0.15)",
                                  color:
                                    c.status === "approved" || c.status === "sent"
                                      ? "#10b981"
                                      : c.status === "failed" || c.status === "rejected"
                                      ? "#ef4444"
                                      : "#f59e0b",
                                }}
                              >
                                {c.status}
                              </span>
                              {c.external_ref && (
                                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                                  Ref: {c.external_ref}
                                </div>
                              )}
                              {c.remarks && (
                                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>
                                  {c.remarks}
                                </div>
                              )}
                            </td>

                            {/* Actions */}
                            <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                {canReviewChallans && (c.status === "draft" || c.status === "failed") && (
                                  <>
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      style={{ color: "#10b981", borderColor: "rgba(16, 185, 129, 0.3)" }}
                                      onClick={() =>
                                        setReviewModal({
                                          open: true,
                                          challan: c,
                                          action: "approve",
                                          remarks: "",
                                          submitting: false,
                                        })
                                      }
                                      title="Approve and send to e-challan webhook"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.3)" }}
                                      onClick={() =>
                                        setReviewModal({
                                          open: true,
                                          challan: c,
                                          action: "reject",
                                          remarks: "",
                                          submitting: false,
                                        })
                                      }
                                      title="Reject challan"
                                    >
                                      Reject
                                    </button>
                                  </>
                                )}

                                {canExport && (
                                  <a
                                    className="btn ghost small"
                                    href={withTok(`/api/challans/${c.id}/export`)}
                                    title="Download signed evidence bundle pack"
                                    download={`challan-${c.number}.zip`}
                                  >
                                    Pack
                                  </a>
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

              {/* Bottom Pagination Strip & Footer Note */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel2)",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--muted)", maxWidth: 600 }}>
                  Fine amounts follow MV Act 2019 central defaults. Approving hands signed cryptographic payloads to ECHALLAN_WEBHOOK_URL.
                </div>
                <Pager
                  page={challanPage}
                  pages={Math.ceil(filteredChallans.length / challanPageSize) || 1}
                  total={filteredChallans.length}
                  onPage={setChallanPage}
                  size={challanPageSize}
                  onSize={setChallanPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 2: ZONE INCIDENTS
             ========================================================================= */}
          {tab === "incidents" && (
            <div className="perm-panel-card">
              <div
                className="perm-panel-head"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div>
                  <h3 className="perm-panel-title" style={{ margin: 0, fontSize: 16 }}>
                    Zone Incidents & Automated Safety Violations
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Geofence breaches, wrong-way movements, speed triggers, crowd density, and illegal stopping.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  {/* Open Only Checkbox */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={incidentsOpenOnly}
                      onChange={(e) => setIncidentsOpenOnly(e.target.checked)}
                      style={{ cursor: "pointer" }}
                    />
                    <span>Open only</span>
                  </label>

                  {/* Priority Selector */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Priority:</span>
                    <select
                      className="search-input"
                      style={{ padding: "4px 8px", fontSize: 12, height: 32, borderRadius: 6, width: 110 }}
                      value={incidentPriority}
                      onChange={(e) => setIncidentPriority(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>

                  {/* Search Input */}
                  <div className="search-field" style={{ width: 220, position: "relative" }}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="search-ico"
                      style={{ position: "absolute", left: 10, top: 9, width: 14, height: 14, color: "var(--muted)" }}
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      className="search-input"
                      style={{ paddingLeft: 30, paddingRight: incidentSearch ? 28 : 10, height: 32, fontSize: 12 }}
                      placeholder="Search incident, zone…"
                      value={incidentSearch}
                      onChange={(e) => setIncidentSearch(e.target.value)}
                    />
                    {incidentSearch && (
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => setIncidentSearch("")}
                        title="Clear search"
                        style={{ position: "absolute", right: 6, top: 6 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "10px 14px" }}>When (IST)</th>
                      <th style={{ padding: "10px 14px" }}>Kind / Offence</th>
                      <th style={{ padding: "10px 14px" }}>Zone</th>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Plate</th>
                      <th style={{ padding: "10px 14px" }}>Details</th>
                      <th style={{ padding: "10px 14px" }}>Snapshot</th>
                      <th style={{ padding: "10px 14px", textAlign: "right" }}>Status / Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && incidents.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Loading incidents…
                        </td>
                      </tr>
                    ) : pagedIncidents.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No incidents recorded for current criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedIncidents.map((i) => {
                        const cam = cameras[i.camera_id];
                        const camName = cam?.name || i.camera_id;
                        const snapSrc = i.snapshot_url ? withTok(i.snapshot_url) : null;
                        const detailAttrs = Object.entries(i.detail || {})
                          .filter(([k]) => k !== "bbox")
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(", ");

                        return (
                          <tr key={i.id} className="perm-row">
                            {/* When */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                              {fmtTime(i.ts)}
                            </td>

                            {/* Kind */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                  fontSize: 11,
                                  fontWeight: 600,
                                  background:
                                    i.priority === "high"
                                      ? "rgba(239, 68, 68, 0.15)"
                                      : "rgba(59, 130, 246, 0.15)",
                                  color: i.priority === "high" ? "#ef4444" : "#3b82f6",
                                }}
                              >
                                {i.label || i.kind}
                              </span>
                            </td>

                            {/* Zone */}
                            <td style={{ padding: "12px 14px", fontWeight: 500 }}>
                              {i.zone || "Default Zone"}
                            </td>

                            {/* Camera */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ fontWeight: 500, fontSize: 12 }}>{camName}</div>
                              {cam?.department && (
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>{cam.department}</div>
                              )}
                            </td>

                            {/* Plate */}
                            <td style={{ padding: "12px 14px" }}>
                              {i.plate ? (
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "2px 6px",
                                    background: "#fef08a",
                                    color: "#0f172a",
                                    border: "1px solid #ca8a04",
                                    borderRadius: 3,
                                    fontFamily: "monospace",
                                    fontWeight: 700,
                                    fontSize: 11,
                                  }}
                                >
                                  {i.plate}
                                </span>
                              ) : (
                                <span style={{ color: "var(--muted)" }}>–</span>
                              )}
                            </td>

                            {/* Details */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, maxWidth: 260 }}>
                              {detailAttrs || "–"}
                            </td>

                            {/* Snapshot */}
                            <td style={{ padding: "12px 14px" }}>
                              {snapSrc ? (
                                <img
                                  src={snapSrc}
                                  alt="Snapshot"
                                  style={{
                                    width: 48,
                                    height: 32,
                                    objectFit: "cover",
                                    borderRadius: 4,
                                    border: "1px solid var(--line)",
                                    cursor: "pointer",
                                  }}
                                  onClick={() =>
                                    setPreviewPhoto({
                                      open: true,
                                      url: snapSrc,
                                      title: `Incident Snapshot: ${i.label}`,
                                      subtitle: `${camName} · ${i.zone || ""} · ${fmtTime(i.ts)}`,
                                    })
                                  }
                                  title="Click to view snapshot"
                                />
                              ) : (
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>–</span>
                              )}
                            </td>

                            {/* Status / Ack */}
                            <td style={{ padding: "12px 14px", textAlign: "right" }}>
                              {i.ack_by ? (
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>
                                  Seen by {i.ack_by}
                                </span>
                              ) : canAckIncidents ? (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  onClick={() => handleAckIncident(i.id)}
                                  title="Acknowledge this incident alert"
                                >
                                  Acknowledge
                                </button>
                              ) : (
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "2px 6px",
                                    borderRadius: 3,
                                    fontSize: 11,
                                    background: "rgba(239, 68, 68, 0.15)",
                                    color: "#ef4444",
                                    fontWeight: 600,
                                  }}
                                >
                                  Open
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Bottom Pagination */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel2)",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  Zone analytics stream real-time events based on geometry bounds in config/analytics.yaml.
                </div>
                <Pager
                  page={incidentPage}
                  pages={Math.ceil(filteredIncidents.length / incidentPageSize) || 1}
                  total={filteredIncidents.length}
                  onPage={setIncidentPage}
                  size={incidentPageSize}
                  onSize={setIncidentPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 3: PLATE REVIEW QUEUE
             ========================================================================= */}
          {tab === "review" && (
            <div className="perm-panel-card">
              <div
                className="perm-panel-head"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div>
                  <h3 className="perm-panel-title" style={{ margin: 0, fontSize: 16 }}>
                    Human-in-the-Loop Plate Review Queue
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Verify sampled ANPR reads every week. Corrections fix records immediately and feed OCR retraining datasets.
                  </p>
                </div>

                <div className="search-field" style={{ width: 240, position: "relative" }}>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="search-ico"
                    style={{ position: "absolute", left: 10, top: 9, width: 14, height: 14, color: "var(--muted)" }}
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="search-input"
                    style={{ paddingLeft: 30, paddingRight: reviewSearch ? 28 : 10, height: 32, fontSize: 12 }}
                    placeholder="Search plate or camera…"
                    value={reviewSearch}
                    onChange={(e) => setReviewSearch(e.target.value)}
                  />
                  {reviewSearch && (
                    <button
                      type="button"
                      className="clear-btn"
                      onClick={() => setReviewSearch("")}
                      title="Clear search"
                      style={{ position: "absolute", right: 6, top: 6 }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "10px 14px" }}>Time (IST)</th>
                      <th style={{ padding: "10px 14px" }}>Read As (ANPR)</th>
                      <th style={{ padding: "10px 14px" }}>Vehicle Crop</th>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Tags & Model Details</th>
                      <th style={{ padding: "10px 14px", textAlign: "right" }}>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && reviewQueue.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Loading review queue…
                        </td>
                      </tr>
                    ) : pagedReviewQueue.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No reads currently waiting in the verification queue.
                        </td>
                      </tr>
                    ) : (
                      pagedReviewQueue.map((e) => {
                        const cam = cameras[e.camera_id];
                        const camName = cam?.name || e.camera_id;
                        const cropSrc = e.crop_url ? withTok(e.crop_url) : null;
                        const fullFrameSrc = e.frame_url ? withTok(e.frame_url) : cropSrc;
                        const confPct = Math.round(e.confidence * 100);

                        return (
                          <tr key={e.id} className="perm-row">
                            {/* Time */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                              {fmtTime(e.ts)}
                            </td>

                            {/* Read As */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span
                                  style={{
                                    display: "inline-block",
                                    padding: "3px 8px",
                                    background: "#fef08a",
                                    color: "#0f172a",
                                    border: "1px solid #ca8a04",
                                    borderRadius: 4,
                                    fontFamily: "monospace",
                                    fontWeight: 700,
                                    fontSize: 12,
                                  }}
                                >
                                  {e.plate}
                                </span>
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: confPct >= 85 ? "#10b981" : confPct >= 70 ? "#f59e0b" : "#ef4444",
                                    fontWeight: 600,
                                  }}
                                >
                                  {confPct}% conf
                                </span>
                              </div>
                            </td>

                            {/* Crop */}
                            <td style={{ padding: "12px 14px" }}>
                              {cropSrc ? (
                                <img
                                  src={cropSrc}
                                  alt="Crop"
                                  style={{
                                    width: 64,
                                    height: 32,
                                    objectFit: "cover",
                                    borderRadius: 4,
                                    border: "1px solid var(--line)",
                                    cursor: "pointer",
                                  }}
                                  onClick={() =>
                                    setPreviewPhoto({
                                      open: true,
                                      url: fullFrameSrc || cropSrc,
                                      title: `Plate Sample: ${e.plate}`,
                                      subtitle: `${camName} · ${fmtTime(e.ts)} (${confPct}% confidence)`,
                                    })
                                  }
                                  title="Click to view full image"
                                />
                              ) : (
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>–</span>
                              )}
                            </td>

                            {/* Camera */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ fontWeight: 500, fontSize: 12 }}>{camName}</div>
                              {cam?.department && (
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>{cam.department}</div>
                              )}
                            </td>

                            {/* Tags */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {(e.tags || [])
                                  .filter((x) => !/^(type|colour|plate):/.test(x))
                                  .map((t, idx) => (
                                    <span
                                      key={idx}
                                      style={{
                                        fontSize: 10,
                                        padding: "1px 6px",
                                        borderRadius: 3,
                                        background: "var(--panel2)",
                                        border: "1px solid var(--line)",
                                        color: "var(--text)",
                                      }}
                                    >
                                      {t}
                                    </span>
                                  ))}
                              </div>
                            </td>

                            {/* Verdict Buttons */}
                            <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#10b981", borderColor: "rgba(16, 185, 129, 0.3)" }}
                                  onClick={() => handleConfirmPlate(e.id)}
                                  title="Confirm plate OCR is correct"
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#3b82f6", borderColor: "rgba(59, 130, 246, 0.3)" }}
                                  onClick={() =>
                                    setCorrectModal({
                                      open: true,
                                      event: e,
                                      newPlate: e.plate,
                                      reason: "OCR misread",
                                      submitting: false,
                                    })
                                  }
                                  title="Provide human correction for plate reading"
                                >
                                  Correct
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel2)",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  Verified entries are written directly to accuracy benchmarking reports.
                </div>
                <Pager
                  page={reviewPage}
                  pages={Math.ceil(filteredReviewQueue.length / reviewPageSize) || 1}
                  total={filteredReviewQueue.length}
                  onPage={setReviewPage}
                  size={reviewPageSize}
                  onSize={setReviewPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: ANPR ACCURACY
             ========================================================================= */}
          {tab === "accuracy" && (
            <div className="perm-panel-card">
              <div
                className="perm-panel-head"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div>
                  <h3 className="perm-panel-title" style={{ margin: 0, fontSize: 16 }}>
                    ANPR Weekly Accuracy & Error Breakdown
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Comprehensive camera-level OCR accuracy benchmarks, night performance, and misread reasons.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {/* Week Selector */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Period:</span>
                    <select
                      className="search-input"
                      style={{ padding: "4px 8px", fontSize: 12, height: 32, borderRadius: 6, width: 140 }}
                      value={accuracyWeek}
                      onChange={(e) => setAccuracyWeek(Number(e.target.value))}
                    >
                      <option value={0}>This week</option>
                      <option value={1}>Last week</option>
                      <option value={2}>2 weeks ago</option>
                      <option value={3}>3 weeks ago</option>
                    </select>
                  </label>

                  {/* Camera Search */}
                  <div className="search-field" style={{ width: 200, position: "relative" }}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="search-ico"
                      style={{ position: "absolute", left: 10, top: 9, width: 14, height: 14, color: "var(--muted)" }}
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      className="search-input"
                      style={{ paddingLeft: 30, paddingRight: accuracySearch ? 28 : 10, height: 32, fontSize: 12 }}
                      placeholder="Filter camera…"
                      value={accuracySearch}
                      onChange={(e) => setAccuracySearch(e.target.value)}
                    />
                    {accuracySearch && (
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => setAccuracySearch("")}
                        title="Clear search"
                        style={{ position: "absolute", right: 6, top: 6 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Weekly Summary Banner */}
              {accuracyReport && (
                <div
                  style={{
                    padding: "12px 18px",
                    background: "var(--panel2)",
                    borderBottom: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 12,
                    fontSize: 12,
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, color: "var(--text)" }}>
                      {accuracyReport.week_start} → {accuracyReport.week_end}
                    </span>
                    <span style={{ margin: "0 8px", color: "var(--muted)" }}>•</span>
                    <span>
                      <b>{accuracyReport.reads.toLocaleString("en-IN")}</b> reads captured
                    </span>
                    <span style={{ margin: "0 8px", color: "var(--muted)" }}>•</span>
                    <span>
                      <b>{accuracyReport.reviewed}</b> sample reviewed
                    </span>
                    <span style={{ margin: "0 8px", color: "var(--muted)" }}>•</span>
                    <span>
                      Overall accuracy:{" "}
                      <b
                        style={{
                          color:
                            (accuracyReport.accuracy_pct ?? 0) >= 95
                              ? "#10b981"
                              : (accuracyReport.accuracy_pct ?? 0) >= 90
                              ? "#f59e0b"
                              : "#ef4444",
                        }}
                      >
                        {accuracyReport.accuracy_pct ?? "–"}%
                      </b>
                    </span>
                  </div>
                  {accuracyReport.note && (
                    <div style={{ color: "var(--muted)", fontStyle: "italic" }}>
                      {accuracyReport.note}
                    </div>
                  )}
                </div>
              )}

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Total Reads</th>
                      <th style={{ padding: "10px 14px" }}>Reviewed</th>
                      <th style={{ padding: "10px 14px" }}>Accuracy</th>
                      <th style={{ padding: "10px 14px" }}>Mean Conf.</th>
                      <th style={{ padding: "10px 14px" }}>Low Conf. %</th>
                      <th style={{ padding: "10px 14px" }}>Invalid %</th>
                      <th style={{ padding: "10px 14px" }}>Night %</th>
                      <th style={{ padding: "10px 14px" }}>Top Correction Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && !accuracyReport ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Calculating weekly ANPR benchmarks…
                        </td>
                      </tr>
                    ) : pagedAccuracyCameras.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No camera reads recorded for this period.
                        </td>
                      </tr>
                    ) : (
                      pagedAccuracyCameras.map((c, idx) => {
                        const acc = c.accuracy_pct;
                        return (
                          <tr key={c.camera_id || idx} className="perm-row">
                            {/* Camera */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              {c.camera_name}
                            </td>

                            {/* Reads */}
                            <td style={{ padding: "12px 14px" }}>
                              {c.reads.toLocaleString("en-IN")}
                            </td>

                            {/* Reviewed */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)" }}>
                              {c.reviewed}
                            </td>

                            {/* Accuracy */}
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                  fontSize: 12,
                                  fontWeight: 700,
                                  background:
                                    acc == null
                                      ? "var(--panel2)"
                                      : acc >= 95
                                      ? "rgba(16, 185, 129, 0.15)"
                                      : acc >= 90
                                      ? "rgba(245, 158, 11, 0.15)"
                                      : "rgba(239, 68, 68, 0.15)",
                                  color:
                                    acc == null
                                      ? "var(--muted)"
                                      : acc >= 95
                                      ? "#10b981"
                                      : acc >= 90
                                      ? "#f59e0b"
                                      : "#ef4444",
                                }}
                              >
                                {acc != null ? `${acc}%` : "–"}
                              </span>
                            </td>

                            {/* Mean Confidence */}
                            <td style={{ padding: "12px 14px", color: "var(--text)" }}>
                              {Math.round(c.mean_confidence * 100)}%
                            </td>

                            {/* Low Confidence */}
                            <td style={{ padding: "12px 14px", color: c.low_confidence_pct > 15 ? "#ef4444" : "var(--muted)" }}>
                              {c.low_confidence_pct}%
                            </td>

                            {/* Invalid */}
                            <td style={{ padding: "12px 14px", color: c.invalid_format_pct > 10 ? "#f59e0b" : "var(--muted)" }}>
                              {c.invalid_format_pct}%
                            </td>

                            {/* Night */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)" }}>
                              {c.night_pct}%
                            </td>

                            {/* Top Reasons */}
                            <td style={{ padding: "12px 14px", fontSize: 12, color: "var(--muted)" }}>
                              {c.top_reasons && c.top_reasons.length > 0
                                ? c.top_reasons.map(([r, n]) => `${r} (×${n})`).join(", ")
                                : "–"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel2)",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  Optical character recognition models run on Edge inference nodes with TensorRT.
                </div>
                <Pager
                  page={accuracyPage}
                  pages={Math.ceil(filteredAccuracyCameras.length / accuracyPageSize) || 1}
                  total={filteredAccuracyCameras.length}
                  onPage={setAccuracyPage}
                  size={accuracyPageSize}
                  onSize={setAccuracyPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 5: TRAFFIC COUNTS
             ========================================================================= */}
          {tab === "traffic" && (
            <div className="perm-panel-card">
              <div
                className="perm-panel-head"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 12,
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <div>
                  <h3 className="perm-panel-title" style={{ margin: 0, fontSize: 16 }}>
                    Traffic Volume & Vehicle Density Analytics
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Rolling window counts, directional tripwire line crossing, and peak congestion load per camera.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {/* Hours Selector */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Time Horizon:</span>
                    <select
                      className="search-input"
                      style={{ padding: "4px 8px", fontSize: 12, height: 32, borderRadius: 6, width: 120 }}
                      value={trafficHours}
                      onChange={(e) => setTrafficHours(Number(e.target.value))}
                    >
                      <option value={1}>Last 1 hour</option>
                      <option value={6}>Last 6 hours</option>
                      <option value={24}>Last 24 hours</option>
                      <option value={168}>Last 7 days</option>
                    </select>
                  </label>

                  {/* Search Input */}
                  <div className="search-field" style={{ width: 200, position: "relative" }}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="search-ico"
                      style={{ position: "absolute", left: 10, top: 9, width: 14, height: 14, color: "var(--muted)" }}
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      className="search-input"
                      style={{ paddingLeft: 30, paddingRight: trafficSearch ? 28 : 10, height: 32, fontSize: 12 }}
                      placeholder="Filter camera…"
                      value={trafficSearch}
                      onChange={(e) => setTrafficSearch(e.target.value)}
                    />
                    {trafficSearch && (
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => setTrafficSearch("")}
                        title="Clear search"
                        style={{ position: "absolute", right: 6, top: 6 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Windows Count Pill */}
              {trafficData && (
                <div
                  style={{
                    padding: "10px 18px",
                    background: "var(--panel2)",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                >
                  Aggregated from <b>{trafficData.rows?.length || 0}</b> one-minute telemetry windows across registered streams.
                </div>
              )}

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Windows</th>
                      <th style={{ padding: "10px 14px" }}>Avg Vehicles</th>
                      <th style={{ padding: "10px 14px" }}>Peak Vehicles</th>
                      <th style={{ padding: "10px 14px" }}>Avg Persons</th>
                      <th style={{ padding: "10px 14px" }}>Breakdown By Class</th>
                      <th style={{ padding: "10px 14px" }}>Line Flow (A → B)</th>
                      <th style={{ padding: "10px 14px" }}>Line Flow (B → A)</th>
                      <th style={{ padding: "10px 14px" }}>Last Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && !trafficData ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Aggregating traffic counts…
                        </td>
                      </tr>
                    ) : pagedTrafficCameras.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No traffic counts yet. Add <code>traffic:</code> analytics config in config/analytics.yaml.
                        </td>
                      </tr>
                    ) : (
                      pagedTrafficCameras.map((c, idx) => {
                        const classItems = Object.entries(c.by_class || {})
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 4);

                        return (
                          <tr key={idx} className="perm-row">
                            {/* Camera */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              {c.camera_name}
                            </td>

                            {/* Windows */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)" }}>
                              {c.windows}
                            </td>

                            {/* Avg Vehicles */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              {c.avg_vehicles}
                            </td>

                            {/* Peak Vehicles */}
                            <td style={{ padding: "12px 14px", color: "var(--text)" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  background: "rgba(59, 130, 246, 0.12)",
                                  color: "#3b82f6",
                                  fontWeight: 600,
                                }}
                              >
                                {c.peak_vehicles}
                              </span>
                            </td>

                            {/* Avg Persons */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)" }}>
                              {c.avg_persons ?? 0}
                            </td>

                            {/* Breakdown By Class */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {classItems.map(([cls, cnt]) => (
                                  <span
                                    key={cls}
                                    style={{
                                      fontSize: 10,
                                      padding: "1px 6px",
                                      borderRadius: 3,
                                      background: "var(--panel2)",
                                      border: "1px solid var(--line)",
                                      color: "var(--text)",
                                    }}
                                  >
                                    {cls}: {cnt}
                                  </span>
                                ))}
                              </div>
                            </td>

                            {/* Line Flow A -> B */}
                            <td style={{ padding: "12px 14px", color: "var(--text)" }}>
                              {c.flow?.a_to_b != null ? `${c.flow.a_to_b} →` : "–"}
                            </td>

                            {/* Line Flow B -> A */}
                            <td style={{ padding: "12px 14px", color: "var(--text)" }}>
                              {c.flow?.b_to_a != null ? `← ${c.flow.b_to_a}` : "–"}
                            </td>

                            {/* Last Activity */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                              {c.last ? fmtTime(c.last) : "–"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 18px",
                  borderTop: "1px solid var(--line)",
                  background: "var(--panel2)",
                  flexWrap: "wrap",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  Traffic windows update continuously every minute from YOLOv8 object detection pipelines.
                </div>
                <Pager
                  page={trafficPage}
                  pages={Math.ceil(filteredTrafficCameras.length / trafficPageSize) || 1}
                  total={filteredTrafficCameras.length}
                  onPage={setTrafficPage}
                  size={trafficPageSize}
                  onSize={setTrafficPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              MODAL: REVIEW CHALLAN (APPROVE / REJECT)
             ========================================================================= */}
          {reviewModal.open && reviewModal.challan && (
            <Modal
              open={reviewModal.open}
              onClose={() => setReviewModal((m) => ({ ...m, open: false }))}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
                {reviewModal.action === "approve"
                  ? `Approve Challan: ${reviewModal.challan.number}`
                  : `Reject Challan: ${reviewModal.challan.number}`}
              </h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitChallanReview();
                }}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div
                  style={{
                    padding: "12px",
                    borderRadius: 6,
                    background: "var(--panel2)",
                    border: "1px solid var(--line)",
                    fontSize: 12,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div>
                    <span style={{ color: "var(--muted)" }}>Vehicle Plate:</span>{" "}
                    <b>{reviewModal.challan.plate}</b>
                  </div>
                  <div>
                    <span style={{ color: "var(--muted)" }}>Offence:</span>{" "}
                    <b>{reviewModal.challan.label}</b> (Section {reviewModal.challan.section})
                  </div>
                  <div>
                    <span style={{ color: "var(--muted)" }}>Penalty:</span>{" "}
                    <b>₹{reviewModal.challan.fine_inr.toLocaleString("en-IN")}</b>
                  </div>
                  <div>
                    <span style={{ color: "var(--muted)" }}>Camera:</span>{" "}
                    <b>{cameras[reviewModal.challan.camera_id]?.name || reviewModal.challan.camera_id}</b>
                  </div>
                </div>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>
                    {reviewModal.action === "approve" ? "Review Remarks (optional):" : "Rejection Reason (required):"}
                  </span>
                  <input
                    type="text"
                    className="search-input"
                    placeholder={
                      reviewModal.action === "approve"
                        ? "e.g. Verified license plate in high-res frame"
                        : "e.g. Unclear registration plate number / blurry evidence"
                    }
                    value={reviewModal.remarks}
                    onChange={(e) => setReviewModal((m) => ({ ...m, remarks: e.target.value }))}
                    required={reviewModal.action === "reject"}
                    autoFocus
                  />
                </label>

                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  {reviewModal.action === "approve"
                    ? "Approval hands the challan payload to the state e-challan endpoint with digital signature."
                    : "Rejecting moves the challan to the rejected audit log and halts further processing."}
                </p>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setReviewModal((m) => ({ ...m, open: false }))}
                    disabled={reviewModal.submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`btn small ${reviewModal.action === "approve" ? "primary" : "danger"}`}
                    disabled={reviewModal.submitting}
                  >
                    {reviewModal.submitting
                      ? "Processing…"
                      : reviewModal.action === "approve"
                      ? "Confirm Approval"
                      : "Confirm Rejection"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* =========================================================================
              MODAL: CORRECT PLATE READING
             ========================================================================= */}
          {correctModal.open && correctModal.event && (
            <Modal
              open={correctModal.open}
              onClose={() => setCorrectModal((m) => ({ ...m, open: false }))}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>
                Correct Plate Read: {correctModal.event.plate}
              </h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitPlateCorrection();
                }}
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                {/* Crop preview if available */}
                {correctModal.event.crop_url && (
                  <div style={{ textAlign: "center", padding: "10px", background: "var(--panel2)", borderRadius: 6 }}>
                    <img
                      src={withTok(correctModal.event.crop_url)}
                      alt="Crop preview"
                      style={{ maxHeight: 90, borderRadius: 4, border: "1px solid var(--line)" }}
                    />
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                      Captured read: <b>{correctModal.event.plate}</b> ({Math.round(correctModal.event.confidence * 100)}% confidence)
                    </div>
                  </div>
                )}

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>True Registration Plate Number:</span>
                  <input
                    type="text"
                    className="search-input"
                    style={{ textTransform: "uppercase", fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}
                    value={correctModal.newPlate}
                    onChange={(e) => setCorrectModal((m) => ({ ...m, newPlate: e.target.value.toUpperCase() }))}
                    placeholder="e.g. MH12AB1234"
                    required
                    autoFocus
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Correction Reason:</span>
                  <select
                    className="search-input"
                    value={correctModal.reason}
                    onChange={(e) => setCorrectModal((m) => ({ ...m, reason: e.target.value }))}
                  >
                    <option value="OCR misread">OCR misread</option>
                    <option value="Occlusion">Partial occlusion</option>
                    <option value="Reflection">Reflection / Glare</option>
                    <option value="Dirty plate">Dirty or damaged plate</option>
                    <option value="Non-standard font">Non-standard font or style</option>
                    <option value="Other">Other</option>
                  </select>
                </label>

                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  This correction updates the plate event and is archived for weekly ANPR model fine-tuning.
                </p>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setCorrectModal((m) => ({ ...m, open: false }))}
                    disabled={correctModal.submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={correctModal.submitting}
                  >
                    {correctModal.submitting ? "Saving…" : "Save Correction"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* =========================================================================
              MODAL: ENLARGED PHOTO PREVIEW
             ========================================================================= */}
          {previewPhoto.open && (
            <Modal
              open={previewPhoto.open}
              onClose={() => setPreviewPhoto((m) => ({ ...m, open: false }))}
              wide
            >
              <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{previewPhoto.title}</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
                {previewPhoto.subtitle && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--muted)", width: "100%", textAlign: "left" }}>
                    {previewPhoto.subtitle}
                  </p>
                )}
                <div style={{ width: "100%", textAlign: "center", background: "#000", borderRadius: 8, overflow: "hidden" }}>
                  <img
                    src={previewPhoto.url}
                    alt={previewPhoto.title}
                    style={{
                      maxWidth: "100%",
                      maxHeight: "70vh",
                      objectFit: "contain",
                      display: "block",
                      margin: "0 auto",
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", width: "100%", gap: 8, marginTop: 6 }}>
                  <a
                    className="btn ghost small"
                    href={previewPhoto.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Original
                  </a>
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => setPreviewPhoto((m) => ({ ...m, open: false }))}
                  >
                    Close
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      </section>
    </main>
  );
}
