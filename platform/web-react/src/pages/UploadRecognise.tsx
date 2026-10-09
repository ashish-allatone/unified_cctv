import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, token } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface UploadSectionItem {
  id: string;
  tabKey: "upload" | "history" | "persons" | "plates";
  label: string;
  desc: string;
  iconName: "upload" | "history" | "persons" | "plates";
}

export const UPLOAD_SECTIONS: UploadSectionItem[] = [
  {
    id: "upload",
    tabKey: "upload",
    label: "Upload & Analyse",
    desc: "Ingest external video & photo evidence",
    iconName: "upload",
  },
  {
    id: "history",
    tabKey: "history",
    label: "Analysis History",
    desc: "Audit log of all processed evidence files",
    iconName: "history",
  },
  {
    id: "persons",
    tabKey: "persons",
    label: "Detected Persons",
    desc: "Face recognition clusters & watchlist enrolment",
    iconName: "persons",
  },
  {
    id: "plates",
    tabKey: "plates",
    label: "Detected Plates",
    desc: "ANPR plates extracted from video footage",
    iconName: "plates",
  },
];

export interface AnalysisSummary {
  id: string;
  created_at: string;
  files: string[];
  note: string;
  status: "done" | "running" | "failed";
  persons: number;
  plates: number;
}

export interface PersonCluster {
  cluster: number;
  rank: number;
  count: number;
  first_t: number;
  last_t: number;
  face_px: number;
  best_crop_url?: string;
  crop_urls?: string[];
  match?: {
    name: string;
    category: string;
    score: number | string;
  } | null;
  enrolled_person_id?: string | null;
}

export interface PlateDetection {
  plate: string;
  crop_url?: string;
  count: number;
  best_conf: number | string;
}

export interface AnalysisDetail {
  id: string;
  created_at: string;
  files: string[];
  note: string;
  status: "done" | "running" | "failed";
  progress?: number;
  total?: number;
  error?: string;
  frames?: number;
  faces?: number;
  timing?: {
    total?: number;
    faces?: number;
    plates?: number;
    decode?: number;
  };
  persons: PersonCluster[];
  plates: PlateDetection[];
}

export function withToken(url?: string | null): string {
  if (!url) return "";
  const tok = token();
  if (!tok) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(tok)}`;
}

export default function UploadRecognise() {
  const { has } = useAuth();
  const canSupervisor = has("supervisor") || has("admin");
  const canWatchlist = has("watchlist") || has("admin");
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

  // Tab mapping
  const tabFromSection = useMemo<"upload" | "history" | "persons" | "plates">(() => {
    if (!section || section === "upload" || section === "new") return "upload";
    if (section === "history" || section === "results") return "history";
    if (section === "persons" || section === "faces") return "persons";
    if (section === "plates") return "plates";
    return "upload";
  }, [section]);

  const [tab, setTab] = useState<"upload" | "history" | "persons" | "plates">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "upload" | "history" | "persons" | "plates") => {
    setTab(nextTab);
    navigate(`/upload/${nextTab}`);
  };

  // State
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [activeAnalysis, setActiveAnalysis] = useState<AnalysisDetail | null>(null);
  const [loadingActive, setLoadingActive] = useState(false);

  // Upload Form state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadNote, setUploadNote] = useState("");
  const [readPlates, setReadPlates] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadRate, setUploadRate] = useState("");
  const [analysisProgress, setAnalysisProgress] = useState<{ frame: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // History Filter & Pagination state
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState<"all" | "done" | "running" | "failed">("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(25);

  // Enrol modal state
  const [enrolTarget, setEnrolTarget] = useState<{ job: string; cluster: number; defaultName?: string } | null>(null);
  const [enrolName, setEnrolName] = useState("");
  const [enrolCategory, setEnrolCategory] = useState("suspect");
  const [enrolling, setEnrolling] = useState(false);

  // Persons / Plates general search
  const [personSearch, setPersonSearch] = useState("");
  const [plateSearch, setPlateSearch] = useState("");

  // Fetch list of past analyses
  const loadAnalyses = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await api<AnalysisSummary[]>("/api/analyses");
      setAnalyses(res || []);
    } catch (e: any) {
      toast(e.message || "Failed to load evidence analyses", "err");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadAnalyses();
  }, [loadAnalyses]);

  // Open a specific analysis
  const handleOpenAnalysis = async (id: string) => {
    setLoadingActive(true);
    try {
      const detail = await api<AnalysisDetail>(`/api/analyses/${id}`);
      setActiveAnalysis(detail);
      handleTabChange("upload");
    } catch (e: any) {
      toast(e.message || "Failed to load analysis details", "err");
    } finally {
      setLoadingActive(false);
    }
  };

  // Delete an analysis
  const handleDeleteAnalysis = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!confirm("Delete this evidence upload, face crops, and recognition results?")) return;
    try {
      await api(`/api/analyses/${id}`, { method: "DELETE" });
      toast("Upload and extracted crops deleted", "ok");
      if (activeAnalysis?.id === id) setActiveAnalysis(null);
      loadAnalyses();
    } catch (e: any) {
      toast(e.message || "Failed to delete upload", "err");
    }
  };

  // Handle file select
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  // Execute Upload & Analyse
  const handleStartUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFiles.length === 0) {
      toast("Please select at least one video or photo file", "warn");
      return;
    }

    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    const totalMb = totalBytes / (1024 * 1024);
    if (totalMb > 350) {
      toast(`Total upload size is ${totalMb.toFixed(1)} MB (maximum supported is 300 MB)`, "err");
      return;
    }

    setIsUploading(true);
    setUploadPct(0);
    setUploadRate(`Uploading ${totalMb.toFixed(1)} MB…`);
    setAnalysisProgress(null);

    const fd = new FormData();
    selectedFiles.forEach((f) => fd.append("files", f));
    if (uploadNote.trim()) fd.append("note", uploadNote.trim());
    if (readPlates) fd.append("plates", "1");

    try {
      const t0 = Date.now();
      const job = await new Promise<{ id: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/analyses");
        const tok = token();
        if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);

        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          setUploadPct(pct);
          const secs = (Date.now() - t0) / 1000;
          const rate = ev.loaded / 1048576 / Math.max(secs, 0.5);
          const remainingSecs = Math.max(1, Math.round((ev.total - ev.loaded) / 1048576 / rate));
          setUploadRate(
            pct < 100
              ? `${pct}% · ${rate.toFixed(1)} MB/s · ~${remainingSecs}s remaining`
              : "100% · Starting AI neural inference…"
          );
        };

        xhr.onload = () => {
          let body: any = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // ignore
          }
          if (xhr.status < 300) {
            resolve(body);
          } else {
            reject(new Error(body.detail || xhr.statusText || "Upload failed"));
          }
        };

        xhr.onerror = () => reject(new Error("Network connection error during upload"));
        xhr.send(fd);
      });

      // Poll analysis progress
      setUploadRate("Analysing video frames for persons & license plates…");
      const poll = async () => {
        try {
          const det = await api<AnalysisDetail>(`/api/analyses/${job.id}`);
          if (det.status === "running") {
            const tot = det.total || 0;
            const progress = det.progress || 0;
            setAnalysisProgress({ frame: progress, total: tot });
            setTimeout(poll, 1200);
            return;
          }
          if (det.status === "failed") {
            setIsUploading(false);
            setAnalysisProgress(null);
            toast(`Analysis failed: ${det.error || "Unknown error"}`, "err");
            loadAnalyses();
            return;
          }

          // Done!
          setIsUploading(false);
          setAnalysisProgress(null);
          setSelectedFiles([]);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setUploadNote("");
          setActiveAnalysis(det);
          toast(
            `Analysis complete: ${det.persons?.length || 0} person(s), ${det.plates?.length || 0} plate(s) found!`,
            "ok"
          );
          loadAnalyses();
        } catch (err: any) {
          setIsUploading(false);
          toast(err.message || "Polling analysis failed", "err");
        }
      };
      poll();
    } catch (err: any) {
      setIsUploading(false);
      setAnalysisProgress(null);
      toast(err.message || "Failed to initiate evidence upload", "err");
    }
  };

  // Submit Enrolment to Watchlist
  const handleEnrolToWatchlist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrolTarget || !enrolName.trim()) return;

    setEnrolling(true);
    try {
      const res = await api<{ name: string; embeddings: number }>(`/api/analyses/${enrolTarget.job}/enrol`, {
        method: "POST",
        body: JSON.stringify({
          cluster: enrolTarget.cluster,
          name: enrolName.trim(),
          category: enrolCategory,
        }),
      });
      toast(`${res.name} enrolled with ${res.embeddings} face embeddings. Cameras start watching now.`, "ok");
      setEnrolTarget(null);
      setEnrolName("");
      // Refresh active analysis
      if (activeAnalysis?.id === enrolTarget.job) {
        const refreshed = await api<AnalysisDetail>(`/api/analyses/${enrolTarget.job}`);
        setActiveAnalysis(refreshed);
      }
    } catch (e: any) {
      toast(e.message || "Enrolment to watchlist failed", "err");
    } finally {
      setEnrolling(false);
    }
  };

  // KPIs
  const kpis = useMemo(() => {
    const totalJobs = analyses.length;
    const completed = analyses.filter((a) => a.status === "done").length;
    const running = analyses.filter((a) => a.status === "running").length;
    const totalPersons = analyses.reduce((acc, a) => acc + (a.persons || 0), 0);
    const totalPlates = analyses.reduce((acc, a) => acc + (a.plates || 0), 0);

    return { totalJobs, completed, running, totalPersons, totalPlates };
  }, [analyses]);

  // Filtered History
  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return analyses.filter((a) => {
      if (historyStatus !== "all" && a.status !== historyStatus) return false;
      if (q) {
        const filesMatch = (a.files || []).some((f) => f.toLowerCase().includes(q));
        const noteMatch = (a.note || "").toLowerCase().includes(q);
        const idMatch = a.id.toLowerCase().includes(q);
        if (!filesMatch && !noteMatch && !idMatch) return false;
      }
      return true;
    });
  }, [analyses, historySearch, historyStatus]);

  const historyTotalPages = Math.max(1, Math.ceil(filteredHistory.length / historyPageSize));
  const pagedHistory = useMemo(() => {
    const start = (historyPage - 1) * historyPageSize;
    return filteredHistory.slice(start, start + historyPageSize);
  }, [filteredHistory, historyPage, historyPageSize]);

  // Aggregated Persons list (from active analysis or past completed analyses)
  const allPersons = useMemo(() => {
    if (activeAnalysis && activeAnalysis.persons?.length > 0) {
      return activeAnalysis.persons.map((p) => ({ ...p, job: activeAnalysis.id, note: activeAnalysis.note }));
    }
    return [];
  }, [activeAnalysis]);

  const filteredPersons = useMemo(() => {
    const q = personSearch.trim().toLowerCase();
    return allPersons.filter((p) => {
      if (q) {
        const matchName = p.match?.name?.toLowerCase().includes(q);
        const matchCat = p.match?.category?.toLowerCase().includes(q);
        if (!matchName && !matchCat && !`person ${p.rank}`.includes(q)) return false;
      }
      return true;
    });
  }, [allPersons, personSearch]);

  // Aggregated Plates list
  const allPlates = useMemo(() => {
    if (activeAnalysis && activeAnalysis.plates?.length > 0) {
      return activeAnalysis.plates.map((pl) => ({ ...pl, job: activeAnalysis.id, note: activeAnalysis.note }));
    }
    return [];
  }, [activeAnalysis]);

  const filteredPlates = useMemo(() => {
    const q = plateSearch.trim().toLowerCase();
    return allPlates.filter((pl) => {
      if (q && !pl.plate.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allPlates, plateSearch]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Evidence Upload & AI Recognition</h2>
              <p className="perm-page-desc">
                Analyse external CCTV footage, phone recordings, WhatsApp clips, DVR exports and photos. Automatically detect faces, match known suspects, enrol to watchlist, and read number plates.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={loadAnalyses}
                disabled={loadingList}
                title="Refresh analysis jobs list"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>
              <button
                type="button"
                className="btn primary small"
                onClick={() => {
                  handleTabChange("upload");
                  if (fileInputRef.current) fileInputRef.current.click();
                }}
                title="Select video or image files to upload"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Upload Evidence
              </button>
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Total Footage Batches */}
            <div className="perm-kpi-card" title="Total video and photo evidence packages analysed">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="12" y1="18" x2="12" y2="12" />
                  <line x1="9" y1="15" x2="15" y2="15" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Evidence Uploads</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalJobs}</span>
                  <span className="kpi-sub-pill sober-pill">{kpis.completed} Processed</span>
                </div>
                <span className="kpi-desc">External video & photo batches</span>
              </div>
            </div>

            {/* Identified Persons */}
            <div className="perm-kpi-card" title="Distinct faces clustered across evidence footage">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Faces & Persons</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalPersons}</span>
                  <span className="kpi-sub-pill sober-pill">Clustered</span>
                </div>
                <span className="kpi-desc">Distinct subjects detected</span>
              </div>
            </div>

            {/* License Plates Extracted */}
            <div className="perm-kpi-card" title="High-confidence license plates identified in evidence">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Number Plates</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalPlates}</span>
                  <span className="kpi-sub-pill sober-pill">ANPR Read</span>
                </div>
                <span className="kpi-desc">Plates matched against catalog</span>
              </div>
            </div>

            {/* Inference Status */}
            <div className="perm-kpi-card" title="Current background AI pipeline inference status">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background: kpis.running > 0 ? "rgba(245, 158, 11, 0.12)" : "rgba(16, 185, 129, 0.12)",
                  color: kpis.running > 0 ? "#f59e0b" : "#10b981",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">AI Inference Engine</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.running > 0 ? `${kpis.running} Active` : "Ready"}</span>
                  <span className={`kpi-sub-pill ${kpis.running > 0 ? "warn-pill" : "sober-pill"}`}>
                    {kpis.running > 0 ? "Processing" : "Idle"}
                  </span>
                </div>
                <span className="kpi-desc">2 fps sampling · RetinaFace + LPR</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "upload" ? "active" : ""}`}
              onClick={() => handleTabChange("upload")}
              role="tab"
            >
              <span>Upload & Analyse</span>
              {tab === "upload" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "history" ? "active" : ""}`}
              onClick={() => handleTabChange("history")}
              role="tab"
            >
              <span>Analysis History</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{analyses.length}</span>
              {tab === "history" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "persons" ? "active" : ""}`}
              onClick={() => handleTabChange("persons")}
              role="tab"
            >
              <span>Detected Persons</span>
              {allPersons.length > 0 && <span className="tab-tag" style={{ marginLeft: 6 }}>{allPersons.length}</span>}
              {tab === "persons" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "plates" ? "active" : ""}`}
              onClick={() => handleTabChange("plates")}
              role="tab"
            >
              <span>Detected Plates</span>
              {allPlates.length > 0 && <span className="tab-tag" style={{ marginLeft: 6 }}>{allPlates.length}</span>}
              {tab === "plates" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TAB 1: Upload & Analyse
              ========================================================================= */}
          {tab === "upload" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Upload Card */}
              <div className="perm-panel-card" style={{ padding: "20px 24px" }}>
                <form onSubmit={handleStartUpload} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <h3 style={{ margin: "0 0 4px 0", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                      Upload Video or Image Evidence
                    </h3>
                    <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
                      Select recordings from phones, body-worn cameras, or photo exports. Supported formats: MP4, MOV, MKV, AVI, WebM, JPG, PNG (up to 300 MB).
                    </p>
                  </div>

                  {/* Dropzone / File Picker */}
                  <div
                    style={{
                      border: "2px dashed var(--line)",
                      borderRadius: 8,
                      padding: "24px 16px",
                      textAlign: "center",
                      background: "var(--bg2)",
                      cursor: "pointer",
                      transition: "border-color 0.2s ease",
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*,image/*"
                      multiple
                      onChange={handleFileChange}
                      style={{ display: "none" }}
                    />
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 36, height: 36, margin: "0 auto 8px auto", color: "var(--muted)", display: "block" }}>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    {selectedFiles.length === 0 ? (
                      <>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                          Click or drag files here to upload evidence
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                          Faces must be approx. 32px or larger; the neural pipeline inspects 2 frames per second (up to 7.5 min of video).
                        </div>
                      </>
                    ) : (
                      <div>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--accent)" }}>
                          {selectedFiles.length} file(s) selected
                        </div>
                        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                          {selectedFiles.map((f) => f.name).join(", ")} ({(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1048576).toFixed(1)} MB)
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Note & Options Grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center" }}>
                    <div>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                        Case Reference / Note
                      </label>
                      <input
                        type="text"
                        value={uploadNote}
                        onChange={(e) => setUploadNote(e.target.value)}
                        placeholder="e.g. WhatsApp video from complainant, Incident #104"
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          borderRadius: 6,
                          border: "1px solid var(--line)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontSize: 13,
                        }}
                      />
                    </div>
                    <div style={{ paddingTop: 20 }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
                        <input
                          type="checkbox"
                          checked={readPlates}
                          onChange={(e) => setReadPlates(e.target.checked)}
                        />
                        <span>Read number plates too</span>
                      </label>
                    </div>
                    <div style={{ paddingTop: 20 }}>
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={isUploading || selectedFiles.length === 0}
                        style={{ minWidth: 150 }}
                      >
                        {isUploading ? "Processing…" : "Upload & Analyse"}
                      </button>
                    </div>
                  </div>

                  {/* Upload Progress Bar */}
                  {isUploading && (
                    <div style={{ background: "var(--bg2)", padding: "14px 16px", borderRadius: 6, border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 600 }}>
                        <span>{uploadRate}</span>
                        <span>{uploadPct}%</span>
                      </div>
                      <div style={{ width: "100%", height: 8, background: "var(--panel)", borderRadius: 4, overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${uploadPct}%`,
                            height: "100%",
                            background: uploadPct === 100 ? "#10b981" : "#3b82f6",
                            transition: "width 0.2s ease",
                          }}
                        />
                      </div>
                      {analysisProgress && (
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>
                          Evaluating frames: <strong>frame {analysisProgress.frame}</strong>
                          {analysisProgress.total ? ` of ~${analysisProgress.total}` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </form>
              </div>

              {/* Active Results Display */}
              {loadingActive && (
                <div className="perm-panel-card" style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
                  Loading analysis results…
                </div>
              )}

              {activeAnalysis && !loadingActive && (
                <div className="perm-panel-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Result Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--line)", paddingBottom: 14 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                          Analysis Results: {activeAnalysis.note || (activeAnalysis.files || []).join(", ") || activeAnalysis.id}
                        </h3>
                        <span className={activeAnalysis.status === "done" ? "ok-chip" : activeAnalysis.status === "failed" ? "bad-chip" : "warn-chip"} style={{ fontSize: 11 }}>
                          ● {activeAnalysis.status.toUpperCase()}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                        Created {fmtTime(activeAnalysis.created_at)} · {activeAnalysis.frames ?? 0} frames scanned · {activeAnalysis.faces ?? 0} face detections · {activeAnalysis.persons?.length || 0} distinct person(s) · {activeAnalysis.plates?.length || 0} plate(s)
                        {activeAnalysis.timing?.total && ` · Total time ${activeAnalysis.timing.total}s`}
                      </div>
                    </div>
                    {canSupervisor && (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={(e) => handleDeleteAnalysis(activeAnalysis.id, e)}
                        style={{ color: "#ef4444" }}
                      >
                        Delete Results
                      </button>
                    )}
                  </div>

                  {/* Persons Grid */}
                  <div>
                    <h4 style={{ margin: "0 0 10px 0", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      Identified Persons ({activeAnalysis.persons?.length || 0})
                    </h4>
                    {(!activeAnalysis.persons || activeAnalysis.persons.length === 0) ? (
                      <div style={{ padding: "20px 14px", background: "var(--bg2)", borderRadius: 6, color: "var(--muted)", fontSize: 12.5 }}>
                        No faces large enough (≥ 32px) were found in the uploaded footage.
                      </div>
                    ) : (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                        {activeAnalysis.persons.map((p) => (
                          <div
                            key={p.cluster}
                            style={{
                              background: "var(--bg2)",
                              border: p.match ? "1.5px solid rgba(239, 68, 68, 0.4)" : "1px solid var(--line)",
                              borderRadius: 8,
                              padding: 12,
                              display: "flex",
                              flexDirection: "column",
                              gap: 10,
                            }}
                          >
                            <div style={{ display: "flex", gap: 12 }}>
                              {p.best_crop_url ? (
                                <img
                                  src={withToken(p.best_crop_url)}
                                  alt={`Person ${p.rank}`}
                                  style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)", flexShrink: 0 }}
                                />
                              ) : (
                                <div style={{ width: 90, height: 90, background: "var(--panel)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 11 }}>
                                  No image
                                </div>
                              )}
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <strong style={{ fontSize: 13.5 }}>Person {p.rank}</strong>
                                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{p.face_px} px</span>
                                </div>
                                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                                  Seen <strong>{p.count}×</strong> · {p.first_t}s – {p.last_t}s in video
                                </span>
                                {p.match ? (
                                  <div style={{ marginTop: 2 }}>
                                    <span className="bad-chip" style={{ fontSize: 11 }}>
                                      Match: {p.match.name} ({p.match.category})
                                    </span>
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 11, color: "var(--muted)" }}>
                                    Not in persons of interest catalog
                                  </div>
                                )}
                                {p.enrolled_person_id && (
                                  <div>
                                    <span className="ok-chip" style={{ fontSize: 10.5 }}>✓ Enrolled to Watchlist</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Secondary crops strip */}
                            {p.crop_urls && p.crop_urls.length > 1 && (
                              <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 2 }}>
                                {p.crop_urls.slice(1, 6).map((u, i) => (
                                  <img
                                    key={i}
                                    src={withToken(u)}
                                    alt=""
                                    style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 4, border: "1px solid var(--line)" }}
                                  />
                                ))}
                              </div>
                            )}

                            {/* Quick Enrol button */}
                            {canWatchlist && !p.enrolled_person_id && (
                              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: "auto" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ width: "100%", fontSize: 11.5 }}
                                  onClick={() => {
                                    setEnrolTarget({ job: activeAnalysis.id, cluster: p.cluster });
                                    setEnrolName(p.match ? p.match.name : "");
                                    setEnrolCategory(p.match ? p.match.category : "suspect");
                                  }}
                                >
                                  Enrol & Watch on Cameras
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Plates Grid */}
                  <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                    <h4 style={{ margin: "0 0 10px 0", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      Plates in Footage ({activeAnalysis.plates?.length || 0})
                    </h4>
                    {(!activeAnalysis.plates || activeAnalysis.plates.length === 0) ? (
                      <div style={{ padding: "14px", background: "var(--bg2)", borderRadius: 6, color: "var(--muted)", fontSize: 12.5 }}>
                        No license plates detected in footage.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                        {activeAnalysis.plates.map((pl, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              background: "var(--bg2)",
                              border: "1px solid var(--line)",
                              borderRadius: 6,
                              padding: "6px 10px",
                            }}
                          >
                            {pl.crop_url && (
                              <img
                                src={withToken(pl.crop_url)}
                                alt={pl.plate}
                                style={{ height: 28, borderRadius: 3, border: "1px solid var(--line)" }}
                              />
                            )}
                            <code style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 13, background: "var(--panel)", padding: "2px 6px", borderRadius: 4 }}>
                              {pl.plate}
                            </code>
                            <span style={{ fontSize: 11, color: "var(--muted)" }}>
                              {pl.count}× · conf {typeof pl.best_conf === "number" ? pl.best_conf.toFixed(2) : pl.best_conf}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 2: Analysis History
              ========================================================================= */}
          {tab === "history" && (
            <div className="perm-panel-card">
              {/* Filter Toolbar */}
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
                <div className="perm-filter-strip">
                  <div className="perm-search-box">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      value={historySearch}
                      onChange={(e) => {
                        setHistorySearch(e.target.value);
                        setHistoryPage(1);
                      }}
                      placeholder="Search evidence by file name, note, or ID…"
                      className="search-input"
                    />
                    {historySearch && (
                      <button type="button" className="clear-btn" onClick={() => setHistorySearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={historyStatus}
                      onChange={(e) => {
                        setHistoryStatus(e.target.value as any);
                        setHistoryPage(1);
                      }}
                    >
                      <option value="all">All Statuses</option>
                      <option value="done">Completed</option>
                      <option value="running">Processing</option>
                      <option value="failed">Failed</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Table */}
              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "16%" }}>Upload Time</th>
                      <th style={{ width: "22%" }}>Files</th>
                      <th style={{ width: "24%" }}>Case Note / Reference</th>
                      <th style={{ width: "10%" }}>Status</th>
                      <th style={{ width: "10%" }}>Persons</th>
                      <th style={{ width: "10%" }}>Plates</th>
                      <th style={{ width: "8%", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedHistory.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No evidence analysis uploads matching criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedHistory.map((item) => (
                        <tr
                          key={item.id}
                          style={{ cursor: "pointer" }}
                          onClick={() => handleOpenAnalysis(item.id)}
                        >
                          <td>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{fmtTime(item.created_at)}</span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12 }}>
                              {(item.files || []).join(", ") || "—"}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12.5, color: item.note ? "var(--text)" : "var(--muted)" }}>
                              {item.note || "No note recorded"}
                            </span>
                          </td>
                          <td>
                            <span className={item.status === "done" ? "ok-chip" : item.status === "failed" ? "bad-chip" : "warn-chip"} style={{ fontSize: 11 }}>
                              ● {item.status.toUpperCase()}
                            </span>
                          </td>
                          <td>
                            <strong style={{ fontSize: 12.5 }}>{item.persons ?? "—"}</strong>
                          </td>
                          <td>
                            <strong style={{ fontSize: 12.5 }}>{item.plates ?? "—"}</strong>
                          </td>
                          <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                type="button"
                                className="btn ghost small"
                                style={{ padding: "3px 8px", fontSize: 11.5 }}
                                onClick={() => handleOpenAnalysis(item.id)}
                              >
                                Open
                              </button>
                              {canSupervisor && (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ padding: "3px 8px", fontSize: 11.5, color: "#ef4444" }}
                                  onClick={(e) => handleDeleteAnalysis(item.id, e)}
                                >
                                  Delete
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

              {/* Pagination */}
              {filteredHistory.length > 0 && (
                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                  <Pager
                    page={historyPage}
                    pages={historyTotalPages}
                    total={filteredHistory.length}
                    onPage={setHistoryPage}
                    size={historyPageSize}
                    onSize={(sz) => {
                      setHistoryPageSize(sz);
                      setHistoryPage(1);
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 3: Detected Persons
              ========================================================================= */}
          {tab === "persons" && (
            <div className="perm-panel-card">
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
                <div className="perm-filter-strip">
                  <div className="perm-search-box">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      value={personSearch}
                      onChange={(e) => setPersonSearch(e.target.value)}
                      placeholder="Search detected persons by name or category…"
                      className="search-input"
                    />
                    {personSearch && (
                      <button type="button" className="clear-btn" onClick={() => setPersonSearch("")}>×</button>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", alignSelf: "center" }}>
                    {activeAnalysis ? `From analysis: ${activeAnalysis.note || activeAnalysis.id}` : "Select an analysis from History to view person clusters"}
                  </div>
                </div>
              </div>

              <div style={{ padding: 18 }}>
                {filteredPersons.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                    {activeAnalysis ? "No person clusters match your search." : "No analysis selected. Open an analysis from History or Upload footage above."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                    {filteredPersons.map((p) => (
                      <div
                        key={p.cluster}
                        style={{
                          background: "var(--bg2)",
                          border: p.match ? "1.5px solid rgba(239, 68, 68, 0.4)" : "1px solid var(--line)",
                          borderRadius: 8,
                          padding: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", gap: 10 }}>
                          {p.best_crop_url ? (
                            <img
                              src={withToken(p.best_crop_url)}
                              alt=""
                              style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }}
                            />
                          ) : (
                            <div style={{ width: 80, height: 80, background: "var(--panel)", borderRadius: 6 }} />
                          )}
                          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <strong>Person {p.rank}</strong>
                            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                              Seen {p.count}× · {p.face_px}px
                            </span>
                            {p.match && (
                              <span className="bad-chip" style={{ fontSize: 10.5 }}>
                                {p.match.name} ({p.match.category})
                              </span>
                            )}
                            {p.enrolled_person_id && (
                              <span className="ok-chip" style={{ fontSize: 10.5 }}>✓ Enrolled</span>
                            )}
                          </div>
                        </div>
                        {canWatchlist && !p.enrolled_person_id && (
                          <button
                            type="button"
                            className="btn ghost small"
                            style={{ fontSize: 11.5 }}
                            onClick={() => {
                              setEnrolTarget({ job: p.job, cluster: p.cluster });
                              setEnrolName(p.match ? p.match.name : "");
                              setEnrolCategory(p.match ? p.match.category : "suspect");
                            }}
                          >
                            Enrol to Watchlist
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: Detected Plates
              ========================================================================= */}
          {tab === "plates" && (
            <div className="perm-panel-card">
              <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line)" }}>
                <div className="perm-filter-strip">
                  <div className="perm-search-box">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-ico">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      value={plateSearch}
                      onChange={(e) => setPlateSearch(e.target.value)}
                      placeholder="Filter detected plates by registration string…"
                      className="search-input"
                    />
                    {plateSearch && (
                      <button type="button" className="clear-btn" onClick={() => setPlateSearch("")}>×</button>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", alignSelf: "center" }}>
                    {activeAnalysis ? `From analysis: ${activeAnalysis.note || activeAnalysis.id}` : "Select an analysis from History to view detected vehicle plates"}
                  </div>
                </div>
              </div>

              <div style={{ padding: 18 }}>
                {filteredPlates.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                    {activeAnalysis ? "No plates match your filter." : "No analysis selected. Open an analysis from History or Upload footage above."}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
                    {filteredPlates.map((pl, i) => (
                      <div
                        key={i}
                        style={{
                          background: "var(--bg2)",
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                          padding: "10px 14px",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                        }}
                      >
                        {pl.crop_url ? (
                          <img
                            src={withToken(pl.crop_url)}
                            alt={pl.plate}
                            style={{ height: 36, borderRadius: 4, border: "1px solid var(--line)" }}
                          />
                        ) : (
                          <div style={{ width: 48, height: 36, background: "var(--panel)", borderRadius: 4 }} />
                        )}
                        <div>
                          <code style={{ fontSize: 14, fontWeight: 700, fontFamily: "monospace" }}>
                            {pl.plate}
                          </code>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                            Seen {pl.count}× · Confidence {typeof pl.best_conf === "number" ? pl.best_conf.toFixed(2) : pl.best_conf}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Watchlist Enrol Modal */}
      <Modal open={!!enrolTarget} onClose={() => setEnrolTarget(null)}>
        {enrolTarget && (
          <form onSubmit={handleEnrolToWatchlist} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              Enrol Subject to Watchlist
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
              Assign subject name and category. Once enrolled, all face-enabled CCTV cameras across your departments will immediately begin tracking this individual.
            </p>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Full Name / Alias
              </label>
              <input
                type="text"
                value={enrolName}
                onChange={(e) => setEnrolName(e.target.value)}
                placeholder="e.g. John Doe / Suspect 1"
                required
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  background: "var(--bg2)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Category
              </label>
              <select
                value={enrolCategory}
                onChange={(e) => setEnrolCategory(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  background: "var(--bg2)",
                  color: "var(--text)",
                  fontSize: 13,
                }}
              >
                <option value="suspect">Suspect</option>
                <option value="wanted">Wanted</option>
                <option value="missing">Missing Person</option>
                <option value="other">Other / POI</option>
              </select>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
              <button type="button" className="btn outline" onClick={() => setEnrolTarget(null)} disabled={enrolling}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={enrolling || !enrolName.trim()}>
                {enrolling ? "Enrolling…" : "Enrol to Watchlist"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </main>
  );
}
