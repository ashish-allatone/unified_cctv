import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface PlaybackSectionItem {
  id: string;
  tabKey: "recordings" | "bookmarks" | "create-bookmark";
  label: string;
  desc: string;
  iconName: "recordings" | "bookmarks" | "create-bookmark";
}

export const PLAYBACK_SECTIONS: PlaybackSectionItem[] = [
  {
    id: "recordings",
    tabKey: "recordings",
    label: "Timeline & Archive",
    desc: "Search, join and stream recorded camera footage from object storage",
    iconName: "recordings",
  },
  {
    id: "bookmarks",
    tabKey: "bookmarks",
    label: "Incident Bookmarks",
    desc: "Flagged critical moments, cut clips, and case evidence attachments",
    iconName: "bookmarks",
  },
  {
    id: "create-bookmark",
    tabKey: "create-bookmark",
    label: "New Bookmark",
    desc: "Mark a camera timestamp window and automatically cut evidence clip",
    iconName: "create-bookmark",
  },
];

export interface CameraOption {
  id: string;
  name: string;
  department?: string;
  status?: string;
}

export interface RecordingSegment {
  start: string;
  duration_s: number;
  bytes: number;
  url: string;
}

export interface RecordingGap {
  from: string;
  seconds: number;
}

export interface RangeQueryResult {
  camera_id: string;
  count: number;
  from: string;
  to: string;
  from_unix: number;
  to_unix: number;
  recorded_s: number;
  requested_s: number;
  bytes: number;
  gaps: RecordingGap[];
  segments: RecordingSegment[];
}

export interface BookmarkItem {
  id: string;
  camera_id: string;
  camera_name?: string;
  label: string;
  ts: string;
  before_s: number;
  after_s: number;
  created_by?: string;
  clip?: "ready" | "none" | "pending" | string;
  play_url?: string;
}

export interface OpenCaseOption {
  id: string;
  number: string;
  title: string;
}

const pbPad = (n: number) => String(n).padStart(2, "0");
const pbLocal = (d: Date) =>
  `${d.getFullYear()}-${pbPad(d.getMonth() + 1)}-${pbPad(d.getDate())}T${pbPad(d.getHours())}:${pbPad(
    d.getMinutes()
  )}:${pbPad(d.getSeconds())}`;
const pbUnix = (v: string) => Math.floor(new Date(v).getTime() / 1000);
const pbMB = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

function pbDur(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const x = sec % 60;
  return [h && `${h} h`, m && `${m} min`, (x || (!h && !m)) && `${x} s`].filter(Boolean).join(" ");
}

export default function Playback() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { has } = useAuth();
  const canExport = has("export");
  const canCases = has("cases");

  // Tab mapping
  const tabFromSection = useMemo<"recordings" | "bookmarks" | "create-bookmark">(() => {
    if (!section || section === "recordings" || section === "timeline" || section === "archive") return "recordings";
    if (section === "bookmarks" || section === "clips") return "bookmarks";
    if (section === "create-bookmark" || section === "new-bookmark" || section === "add") return "create-bookmark";
    return "recordings";
  }, [section]);

  const [tab, setTab] = useState<"recordings" | "bookmarks" | "create-bookmark">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "recordings" | "bookmarks" | "create-bookmark") => {
    setTab(nextTab);
    navigate(`/playback/${nextTab}`);
  };

  // Cameras List
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [camById, setCamById] = useState<Record<string, CameraOption>>({});

  // Query Form State
  const [selectedCamera, setSelectedCamera] = useState<string>("");
  const [fromTime, setFromTime] = useState<string>(() => {
    const d = new Date(Date.now() - 15 * 60000);
    return pbLocal(d);
  });
  const [toTime, setToTime] = useState<string>(() => {
    return pbLocal(new Date());
  });

  // Query Results
  const [rangeResult, setRangeResult] = useState<RangeQueryResult | null>(null);
  const [loadingRange, setLoadingRange] = useState(false);

  // Combine video state
  const [combining, setCombining] = useState(false);
  const [combineProgress, setCombineProgress] = useState<string>("");

  // Bookmarks State
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [loadingBookmarks, setLoadingBookmarks] = useState(false);
  const [bookmarkSearch, setBookmarkSearch] = useState("");
  const [bookmarkPage, setBookmarkPage] = useState(1);
  const [bookmarkPageSize, setBookmarkPageSize] = useState(25);

  // New Bookmark Form State
  const [bmCamera, setBmCamera] = useState<string>("");
  const [bmTs, setBmTs] = useState<string>(() => pbLocal(new Date()));
  const [bmBefore, setBmBefore] = useState<number>(10);
  const [bmAfter, setBmAfter] = useState<number>(10);
  const [bmLabel, setBmLabel] = useState<string>("");
  const [savingBookmark, setSavingBookmark] = useState(false);

  // Add to Case Modal State
  const [caseModal, setCaseModal] = useState<{
    open: boolean;
    bookmarkId: string | null;
    openCases: OpenCaseOption[];
    selectedCaseId: string;
    note: string;
    submitting: boolean;
  }>({
    open: false,
    bookmarkId: null,
    openCases: [],
    selectedCaseId: "",
    note: "",
    submitting: false,
  });

  // Video Player Modal State
  const [playerModal, setPlayerModal] = useState<{
    open: boolean;
    url: string;
    title: string;
    download?: { url: string; filename: string };
  }>({
    open: false,
    url: "",
    title: "",
  });

  // Load cameras
  useEffect(() => {
    api<CameraOption[]>("/api/cameras")
      .then((list) => {
        const sorted = (Array.isArray(list) ? list : []).slice().sort((a, b) => a.name.localeCompare(b.name));
        setCameras(sorted);
        const map: Record<string, CameraOption> = {};
        sorted.forEach((c) => {
          map[c.id] = c;
        });
        setCamById(map);
        if (sorted.length > 0) {
          setSelectedCamera((prev) => prev || sorted[0].id);
          setBmCamera((prev) => prev || sorted[0].id);
        }
      })
      .catch(() => {});
  }, []);

  // Load bookmarks
  const loadBookmarks = useCallback(async () => {
    setLoadingBookmarks(true);
    try {
      const data = await api<BookmarkItem[]>("/api/bookmarks");
      setBookmarks(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e.message || "Failed to load bookmarks", "err");
      setBookmarks([]);
    } finally {
      setLoadingBookmarks(false);
    }
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  // Execute Range Search
  const runPlaybackSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedCamera) {
      toast("Please select a camera", "warn");
      return;
    }
    if (!fromTime || !toTime) {
      toast("Choose both From and To time", "warn");
      return;
    }
    const a = pbUnix(fromTime);
    const b = pbUnix(toTime);
    if (!(b > a)) {
      toast("'To' time must be later than 'From' time", "warn");
      return;
    }

    setLoadingRange(true);
    try {
      const res = await api<RangeQueryResult>(
        `/api/cameras/${encodeURIComponent(selectedCamera)}/recordings/range?from=${a}&to=${b}`
      );
      setRangeResult(res);
      if (res.count === 0) {
        toast("No recordings found in this time range", "warn");
      }
    } catch (e: any) {
      toast(e.message || "Failed to fetch recordings", "err");
      setRangeResult(null);
    } finally {
      setLoadingRange(false);
    }
  };

  // Quick preset interval helper
  const applyPresetMinutes = (min: number) => {
    const now = new Date();
    setToTime(pbLocal(now));
    setFromTime(pbLocal(new Date(now.getTime() - min * 60000)));
  };

  // Combine and play / download
  const handleCombineVideos = async (mode: "play" | "download") => {
    if (!rangeResult || combining) return;
    const base = `/api/cameras/${encodeURIComponent(rangeResult.camera_id)}/recordings`;
    setCombining(true);
    setCombineProgress("Preparing video… queued");

    try {
      let j = await api<{ name: string; status: string; progress?: number; download_url?: string; filename?: string; url?: string; bytes?: number; duration_s?: number }>(
        `${base}/combine`,
        {
          method: "POST",
          body: JSON.stringify({ from: rangeResult.from_unix, to: rangeResult.to_unix }),
        }
      );

      const jobName = j.name;
      while (j.status === "queued" || j.status === "building") {
        setCombineProgress(`Preparing video… ${j.status === "queued" ? "queued" : (j.progress || 0) + "%"}`);
        await new Promise((ok) => setTimeout(ok, 1500));
        j = await api(`${base}/combined/${jobName}/status`);
      }

      if (j.status !== "ready") {
        throw new Error("Could not prepare the combined video");
      }

      const camName = camById[rangeResult.camera_id]?.name || rangeResult.camera_id;
      const title = `${camName} • ${fmtTime(rangeResult.from)} → ${fmtTime(rangeResult.to)} (${pbDur(j.duration_s || rangeResult.recorded_s)})`;

      if (mode === "download" && j.download_url && j.filename) {
        const link = document.createElement("a");
        link.href = withTok(j.download_url);
        link.download = j.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast(`Downloading ${j.filename} (${pbMB(j.bytes || 0)})`, "ok");
      } else if (j.url) {
        setPlayerModal({
          open: true,
          url: j.url,
          title,
          download: canExport && j.download_url && j.filename ? { url: j.download_url, filename: j.filename } : undefined,
        });
      }
    } catch (e: any) {
      toast(e.message || "Failed to combine video", "err");
    } finally {
      setCombining(false);
      setCombineProgress("");
    }
  };

  // Create Bookmark
  const handleCreateBookmark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bmCamera || !bmLabel.trim()) {
      toast("Please fill in camera and bookmark label", "warn");
      return;
    }

    setSavingBookmark(true);
    try {
      const created = await api<BookmarkItem>("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify({
          camera_id: bmCamera,
          ts: bmTs ? new Date(bmTs).toISOString() : null,
          label: bmLabel.trim(),
          before_s: Number(bmBefore) || 10,
          after_s: Number(bmAfter) || 10,
        }),
      });

      toast("Bookmark added; cutting clip…", "ok");
      setBmLabel("");
      handleTabChange("bookmarks");
      loadBookmarks();

      // Trigger automatic background clip cut
      setTimeout(async () => {
        try {
          await api(`/api/bookmarks/${created.id}/cut`, { method: "POST" });
        } catch {}
        loadBookmarks();
      }, 600);
    } catch (e: any) {
      toast(e.message || "Failed to create bookmark", "err");
    } finally {
      setSavingBookmark(false);
    }
  };

  // Cut Clip Manually
  const handleCutClip = async (id: string) => {
    try {
      const res = await api<{ clip: string }>(`/api/bookmarks/${id}/cut`, { method: "POST" });
      toast(
        res.clip === "ready" ? "Clip cut successfully" : "No recording covers that window",
        res.clip === "ready" ? "ok" : "warn"
      );
      loadBookmarks();
    } catch (e: any) {
      toast(e.message || "Failed to cut clip", "err");
    }
  };

  // Delete Bookmark
  const handleDeleteBookmark = async (id: string) => {
    if (!confirm("Delete this bookmark from archive?")) return;
    try {
      await api(`/api/bookmarks/${id}`, { method: "DELETE" });
      toast("Bookmark deleted", "ok");
      loadBookmarks();
    } catch (e: any) {
      toast(e.message || "Failed to delete bookmark", "err");
    }
  };

  // Open Add to Case Dialog
  const openCaseDialogForBookmark = async (bmId: string) => {
    try {
      const cases = await api<OpenCaseOption[]>("/api/cases?status=open");
      if (!cases || cases.length === 0) {
        toast("No open cases available. Open a case in the Cases tab first.", "warn");
        return;
      }
      setCaseModal({
        open: true,
        bookmarkId: bmId,
        openCases: cases,
        selectedCaseId: cases[0].id,
        note: "",
        submitting: false,
      });
    } catch (e: any) {
      toast(e.message || "Failed to load open cases", "err");
    }
  };

  // Submit Add to Case
  const submitAddToCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!caseModal.bookmarkId || !caseModal.selectedCaseId) return;

    setCaseModal((m) => ({ ...m, submitting: true }));
    try {
      await api(`/api/cases/${caseModal.selectedCaseId}/items`, {
        method: "POST",
        body: JSON.stringify({
          kind: "bookmark",
          ref_id: caseModal.bookmarkId,
          note: caseModal.note.trim(),
        }),
      });
      toast("Bookmark clip filed into investigation case", "ok");
      setCaseModal((m) => ({ ...m, open: false }));
    } catch (e: any) {
      toast(e.message || "Failed to file into case", "err");
      setCaseModal((m) => ({ ...m, submitting: false }));
    }
  };

  // Filtered & Paginated Bookmarks
  const filteredBookmarks = useMemo(() => {
    const q = bookmarkSearch.trim().toLowerCase();
    return bookmarks.filter((b) => {
      if (q) {
        const camName = camById[b.camera_id]?.name || b.camera_name || b.camera_id;
        const match =
          b.label.toLowerCase().includes(q) ||
          camName.toLowerCase().includes(q) ||
          (b.created_by || "").toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [bookmarks, bookmarkSearch, camById]);

  const pagedBookmarks = useMemo(() => {
    const start = (bookmarkPage - 1) * bookmarkPageSize;
    return filteredBookmarks.slice(start, start + bookmarkPageSize);
  }, [filteredBookmarks, bookmarkPage, bookmarkPageSize]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Video Playback & Evidence Archive</h2>
              <p className="perm-page-desc">
                Streamed recordings from object storage, multi-segment stitching, incident bookmarks, and video evidence clipping.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  loadBookmarks();
                  if (rangeResult) runPlaybackSearch();
                }}
                disabled={loadingBookmarks || loadingRange}
                title="Refresh bookmarks and archive data"
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
                onClick={() => handleTabChange("create-bookmark")}
                title="Mark a new timestamp window for clipping"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                New Bookmark
              </button>
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Total Bookmarks */}
            <div className="perm-kpi-card" title="Total saved operator bookmarks and critical incident windows">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Video Bookmarks</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{bookmarks.length}</span>
                  <span className="kpi-sub-pill sober-pill">
                    {bookmarks.filter((b) => b.clip === "ready").length} Ready
                  </span>
                </div>
                <span className="kpi-desc">Cut incident clips in archive</span>
              </div>
            </div>

            {/* Cameras with Archive Feeds */}
            <div className="perm-kpi-card" title="Online registered cameras with recorded video streams">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Archive Streams</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{cameras.length}</span>
                  <span className="kpi-sub-pill sober-pill">RECORD_MODE</span>
                </div>
                <span className="kpi-desc">Continuous object storage ingest</span>
              </div>
            </div>

            {/* Queried Footage Duration */}
            <div className="perm-kpi-card" title="Duration of recorded segments returned in current query">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Queried Footage</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">
                    {rangeResult ? pbDur(rangeResult.recorded_s) : "–"}
                  </span>
                  {rangeResult && (
                    <span className="kpi-sub-pill sober-pill">
                      {rangeResult.count} Segments
                    </span>
                  )}
                </div>
                <span className="kpi-desc">
                  {rangeResult ? pbMB(rangeResult.bytes) : "Select camera time range"}
                </span>
              </div>
            </div>

            {/* Gap Analysis */}
            <div className="perm-kpi-card" title="Integrity of continuous stream without packet or power drops">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{
                  background:
                    rangeResult && rangeResult.gaps.length > 0
                      ? "rgba(239, 68, 68, 0.12)"
                      : "rgba(100, 116, 139, 0.12)",
                  color: rangeResult && rangeResult.gaps.length > 0 ? "#ef4444" : "#64748b",
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Stream Gaps</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">
                    {rangeResult ? rangeResult.gaps.length : "0"}
                  </span>
                  <span className="kpi-sub-pill sober-pill">
                    {rangeResult && rangeResult.gaps.length > 0 ? "Offline gaps" : "Continuous"}
                  </span>
                </div>
                <span className="kpi-desc">Network / camera disconnects</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "recordings" ? "active" : ""}`}
              onClick={() => handleTabChange("recordings")}
              role="tab"
            >
              <span>Timeline & Archive</span>
              {rangeResult && (
                <span className="tab-tag" style={{ marginLeft: 6 }}>{rangeResult.count}</span>
              )}
              {tab === "recordings" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "bookmarks" ? "active" : ""}`}
              onClick={() => handleTabChange("bookmarks")}
              role="tab"
            >
              <span>Incident Bookmarks</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{bookmarks.length}</span>
              {tab === "bookmarks" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "create-bookmark" ? "active" : ""}`}
              onClick={() => handleTabChange("create-bookmark")}
              role="tab"
            >
              <span>New Bookmark</span>
              {tab === "create-bookmark" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TAB 1: TIMELINE & ARCHIVE (CUSTOM RANGE PLAYBACK)
             ========================================================================= */}
          {tab === "recordings" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Range Search Form */}
              <div className="perm-panel-card" style={{ padding: "16px 20px" }}>
                <form
                  onSubmit={runPlaybackSearch}
                  style={{ display: "flex", flexDirection: "column", gap: 14 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Camera Selector */}
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 260px", minWidth: 200, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>Camera Stream:</span>
                      <select
                        className="search-input"
                        value={selectedCamera}
                        onChange={(e) => setSelectedCamera(e.target.value)}
                        style={{ height: 34, fontSize: 13 }}
                        required
                      >
                        <option value="">— Select Camera —</option>
                        {cameras.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} {c.department ? `(${c.department})` : ""}
                          </option>
                        ))}
                      </select>
                    </label>

                    {/* From Time */}
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>From (IST):</span>
                      <input
                        type="datetime-local"
                        step="1"
                        className="search-input"
                        value={fromTime}
                        onChange={(e) => setFromTime(e.target.value)}
                        style={{ height: 34, fontSize: 13 }}
                        required
                      />
                    </label>

                    {/* To Time */}
                    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>To (IST):</span>
                      <input
                        type="datetime-local"
                        step="1"
                        className="search-input"
                        value={toTime}
                        onChange={(e) => setToTime(e.target.value)}
                        style={{ height: 34, fontSize: 13 }}
                        required
                      />
                    </label>

                    {/* Submit Button */}
                    <button
                      type="submit"
                      className="btn primary"
                      style={{ height: 34 }}
                      disabled={loadingRange}
                    >
                      {loadingRange ? "Searching…" : "Show Recordings"}
                    </button>
                  </div>

                  {/* Quick Presets Bar */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                    <span style={{ color: "var(--muted)", fontWeight: 600 }}>Quick Presets:</span>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => applyPresetMinutes(5)}
                    >
                      Last 5 min
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => applyPresetMinutes(15)}
                    >
                      Last 15 min
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => applyPresetMinutes(30)}
                    >
                      Last 30 min
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => applyPresetMinutes(60)}
                    >
                      Last 1 hour
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => applyPresetMinutes(120)}
                    >
                      Last 2 hours
                    </button>
                  </div>
                </form>
              </div>

              {/* Combined Video Action Banner */}
              {rangeResult && rangeResult.count > 0 && (
                <div
                  className="perm-panel-card"
                  style={{
                    padding: "14px 20px",
                    background: "var(--panel2)",
                    border: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 14,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                      Recorded {pbDur(rangeResult.recorded_s)} of the {pbDur(rangeResult.requested_s)} requested ({pbMB(rangeResult.bytes)})
                    </div>
                    {rangeResult.gaps.length > 0 ? (
                      <div style={{ fontSize: 12, color: "#ef4444", marginTop: 2 }}>
                        Not recorded:{" "}
                        {rangeResult.gaps
                          .slice(0, 3)
                          .map((g) => `${fmtTime(g.from)} (${pbDur(g.seconds)})`)
                          .join("; ")}
                        {rangeResult.gaps.length > 3 ? `; +${rangeResult.gaps.length - 3} more` : ""}. Combined video joins recorded parts back-to-back.
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "#10b981", marginTop: 2 }}>
                        ✓ Continuous recording without gaps.
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => handleCombineVideos("play")}
                      disabled={combining}
                    >
                      ▶ Play Combined Video
                    </button>
                    {canExport && (
                      <button
                        type="button"
                        className="btn small outline"
                        onClick={() => handleCombineVideos("download")}
                        disabled={combining}
                      >
                        ⬇ Download Combined Video
                      </button>
                    )}
                    {combineProgress && (
                      <span style={{ fontSize: 11, color: "var(--muted)", fontStyle: "italic" }}>
                        {combineProgress}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Segments Table */}
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
                    {rangeResult ? `${rangeResult.count} Recorded Segments` : "Recorded Segments"}
                  </h3>
                  {rangeResult && (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {camById[rangeResult.camera_id]?.name || rangeResult.camera_id} • {fmtTime(rangeResult.from)} → {fmtTime(rangeResult.to)}
                    </span>
                  )}
                </div>

                <div style={{ overflowX: "auto" }}>
                  <table className="perm-table sober-perm-table" style={{ width: "100%", textAlign: "left", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)" }}>
                        <th style={{ padding: "10px 14px" }}>Start Time (IST)</th>
                        <th style={{ padding: "10px 14px" }}>Segment Length</th>
                        <th style={{ padding: "10px 14px" }}>File Size</th>
                        <th style={{ padding: "10px 14px", textAlign: "right" }}>Playback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loadingRange ? (
                        <tr>
                          <td colSpan={4} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                            Querying archive storage…
                          </td>
                        </tr>
                      ) : !rangeResult ? (
                        <tr>
                          <td colSpan={4} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                            Choose a camera and time range above to inspect archived video segments.
                          </td>
                        </tr>
                      ) : rangeResult.segments.length === 0 ? (
                        <tr>
                          <td colSpan={4} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                            No recording for this camera in that time range. Recording only runs for cameras enabled in RECORD_MODE.
                          </td>
                        </tr>
                      ) : (
                        rangeResult.segments.map((seg, idx) => {
                          const camName = camById[rangeResult.camera_id]?.name || rangeResult.camera_id;
                          return (
                            <tr key={idx} className="perm-row">
                              <td style={{ padding: "10px 14px", fontWeight: 600 }}>
                                {fmtTime(seg.start)}
                              </td>
                              <td style={{ padding: "10px 14px", color: "var(--text)" }}>
                                {Math.round(seg.duration_s)} seconds ({pbDur(seg.duration_s)})
                              </td>
                              <td style={{ padding: "10px 14px", color: "var(--muted)" }}>
                                {(seg.bytes / 1048576).toFixed(1)} MB
                              </td>
                              <td style={{ padding: "10px 14px", textAlign: "right" }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#3b82f6" }}
                                  onClick={() =>
                                    setPlayerModal({
                                      open: true,
                                      url: seg.url,
                                      title: `${camName} • ${fmtTime(seg.start)}`,
                                    })
                                  }
                                >
                                  ▶ Play
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
              TAB 2: INCIDENT BOOKMARKS
             ========================================================================= */}
          {tab === "bookmarks" && (
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
                    Operator Bookmarks & Cut Clips
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Critical video buffers cut from the recording archive. Clips can be reviewed, exported, or filed directly into active case dossiers.
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
                    style={{ paddingLeft: 30, paddingRight: bookmarkSearch ? 28 : 10, height: 32, fontSize: 12 }}
                    placeholder="Search bookmarks, camera…"
                    value={bookmarkSearch}
                    onChange={(e) => setBookmarkSearch(e.target.value)}
                  />
                  {bookmarkSearch && (
                    <button
                      type="button"
                      className="clear-btn"
                      onClick={() => setBookmarkSearch("")}
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
                      <th style={{ padding: "10px 14px" }}>Timestamp (IST)</th>
                      <th style={{ padding: "10px 14px" }}>Camera</th>
                      <th style={{ padding: "10px 14px" }}>Label / Note</th>
                      <th style={{ padding: "10px 14px" }}>Buffer Window</th>
                      <th style={{ padding: "10px 14px" }}>Created By</th>
                      <th style={{ padding: "10px 14px" }}>Clip Status</th>
                      <th style={{ padding: "10px 14px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingBookmarks && bookmarks.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Loading bookmarks…
                        </td>
                      </tr>
                    ) : pagedBookmarks.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No bookmarks recorded yet. Use &ldquo;New Bookmark&rdquo; tab or &ldquo;Bookmark&rdquo; on the video wall.
                        </td>
                      </tr>
                    ) : (
                      pagedBookmarks.map((b) => {
                        const camName = camById[b.camera_id]?.name || b.camera_name || b.camera_id;
                        return (
                          <tr key={b.id} className="perm-row">
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                              {fmtTime(b.ts)}
                            </td>
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              {camName}
                            </td>
                            <td style={{ padding: "12px 14px", fontWeight: 500 }}>
                              {b.label}
                            </td>
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                              -{b.before_s}s / +{b.after_s}s
                            </td>
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                              {b.created_by || "Operator"}
                            </td>
                            <td style={{ padding: "12px 14px" }}>
                              {b.clip === "ready" ? (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#10b981", borderColor: "rgba(16, 185, 129, 0.3)" }}
                                  onClick={() =>
                                    setPlayerModal({
                                      open: true,
                                      url: b.play_url!,
                                      title: `Bookmark: ${b.label} (${camName})`,
                                    })
                                  }
                                >
                                  ▶ Play Clip
                                </button>
                              ) : b.clip === "none" ? (
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>Not recorded</span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  onClick={() => handleCutClip(b.id)}
                                >
                                  Cut Clip
                                </button>
                              )}
                            </td>
                            <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                              <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                {canCases && (
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={() => openCaseDialogForBookmark(b.id)}
                                    title="File this clip into an open investigation case"
                                  >
                                    File Case
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ color: "#ef4444" }}
                                  onClick={() => handleDeleteBookmark(b.id)}
                                  title="Delete bookmark"
                                >
                                  ✕
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
                  Bookmarks save temporary buffer clips into permanent case-accessible media storage.
                </div>
                <Pager
                  page={bookmarkPage}
                  pages={Math.ceil(filteredBookmarks.length / bookmarkPageSize) || 1}
                  total={filteredBookmarks.length}
                  onPage={setBookmarkPage}
                  size={bookmarkPageSize}
                  onSize={setBookmarkPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 3: CREATE NEW BOOKMARK
             ========================================================================= */}
          {tab === "create-bookmark" && (
            <div className="perm-panel-card" style={{ maxWidth: 720, margin: "0 auto", padding: "20px 24px" }}>
              <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 12, marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                  Mark Incident Timestamp & Cut Clip
                </h3>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>
                  Select the target camera and timestamp. The server cuts the surrounding video buffer and stores it in the bookmarks index.
                </p>
              </div>

              <form onSubmit={handleCreateBookmark} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Camera Stream:</span>
                  <select
                    className="search-input"
                    value={bmCamera}
                    onChange={(e) => setBmCamera(e.target.value)}
                    style={{ height: 34, fontSize: 13 }}
                    required
                  >
                    <option value="">— Select Camera —</option>
                    {cameras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.department ? `(${c.department})` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Incident Timestamp (IST):</span>
                  <input
                    type="datetime-local"
                    step="1"
                    className="search-input"
                    value={bmTs}
                    onChange={(e) => setBmTs(e.target.value)}
                    style={{ height: 34, fontSize: 13 }}
                    required
                  />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Buffer Before (Seconds):</span>
                    <input
                      type="number"
                      min={1}
                      max={120}
                      className="search-input"
                      value={bmBefore}
                      onChange={(e) => setBmBefore(Number(e.target.value))}
                      style={{ height: 34, fontSize: 13 }}
                      required
                    />
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Buffer After (Seconds):</span>
                    <input
                      type="number"
                      min={1}
                      max={120}
                      className="search-input"
                      value={bmAfter}
                      onChange={(e) => setBmAfter(Number(e.target.value))}
                      style={{ height: 34, fontSize: 13 }}
                      required
                    />
                  </label>
                </div>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Incident Description / Label:</span>
                  <input
                    type="text"
                    className="search-input"
                    value={bmLabel}
                    onChange={(e) => setBmLabel(e.target.value)}
                    placeholder="e.g. Red SUV reckless overtaking, near North Gate"
                    style={{ height: 34, fontSize: 13 }}
                    required
                  />
                </label>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => handleTabChange("bookmarks")}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={savingBookmark || !bmLabel.trim() || !bmCamera}
                  >
                    {savingBookmark ? "Creating…" : "Save Bookmark & Cut Clip"}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* =========================================================================
              MODAL: FILE BOOKMARK INTO CASE
             ========================================================================= */}
          {caseModal.open && (
            <Modal
              open={caseModal.open}
              onClose={() => setCaseModal((m) => ({ ...m, open: false }))}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>File Clip into Case Dossier</h3>
              <form onSubmit={submitAddToCase} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Select Open Investigation Case:</span>
                  <select
                    className="search-input"
                    value={caseModal.selectedCaseId}
                    onChange={(e) => setCaseModal((m) => ({ ...m, selectedCaseId: e.target.value }))}
                    style={{ height: 34, fontSize: 13 }}
                    required
                  >
                    {caseModal.openCases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.number} • {c.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Investigation Note / Rationale:</span>
                  <input
                    type="text"
                    className="search-input"
                    value={caseModal.note}
                    onChange={(e) => setCaseModal((m) => ({ ...m, note: e.target.value }))}
                    placeholder="Explain why this footage is relevant evidence…"
                    style={{ height: 34, fontSize: 13 }}
                  />
                </label>

                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  Filing this clip permanently preserves the media and appends an entry to the case&apos;s SHA-256 chain of custody.
                </p>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setCaseModal((m) => ({ ...m, open: false }))}
                    disabled={caseModal.submitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={caseModal.submitting || !caseModal.selectedCaseId}
                  >
                    {caseModal.submitting ? "Filing…" : "Attach Evidence"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* =========================================================================
              MODAL: VIDEO PLAYBACK
             ========================================================================= */}
          {playerModal.open && (
            <Modal
              open={playerModal.open}
              onClose={() => setPlayerModal((m) => ({ ...m, open: false }))}
              wide
            >
              <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>{playerModal.title}</h3>
              <div style={{ width: "100%", background: "#000", borderRadius: 8, overflow: "hidden" }}>
                <video
                  controls
                  autoPlay
                  playsInline
                  src={withTok(playerModal.url)}
                  style={{ width: "100%", maxHeight: "68vh", display: "block" }}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginTop: 10,
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  Streamed securely from video archive. Access is logged in the audit trail.
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  {playerModal.download && (
                    <a
                      className="btn ghost small"
                      href={withTok(playerModal.download.url)}
                      download={playerModal.download.filename}
                    >
                      Download Video
                    </a>
                  )}
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => setPlayerModal((m) => ({ ...m, open: false }))}
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
