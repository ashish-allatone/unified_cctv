import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, withTok } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface CasesSectionItem {
  id: string;
  tabKey: "active" | "mine" | "closed" | "custody";
  label: string;
  desc: string;
  iconName: "active" | "mine" | "closed" | "custody";
}

export const CASES_SECTIONS: CasesSectionItem[] = [
  {
    id: "active",
    tabKey: "active",
    label: "Active Cases",
    desc: "Open investigation dossiers currently under active review",
    iconName: "active",
  },
  {
    id: "mine",
    tabKey: "mine",
    label: "My Cases",
    desc: "Investigations assigned directly to your account",
    iconName: "mine",
  },
  {
    id: "closed",
    tabKey: "closed",
    label: "Closed Cases",
    desc: "Resolved investigations with sealed evidence chains",
    iconName: "closed",
  },
  {
    id: "custody",
    tabKey: "custody",
    label: "Evidence & Custody",
    desc: "Cryptographic SHA-256 chain of custody and media items",
    iconName: "custody",
  },
];

export interface CaseListItem {
  id: string;
  number: string;
  title: string;
  reference?: string;
  priority: "high" | "medium" | "low" | string;
  owner: string;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  department?: string;
  status: "open" | "closed" | string;
  items: number;
}

export interface CaseEvidenceItem {
  id: string;
  kind: "event" | "note" | "stitch" | "bookmark" | "recording" | string;
  note?: string;
  added_by?: string;
  added_at?: string;
  meta?: {
    crop_url?: string;
    plate?: string;
    camera_name?: string;
    camera_id?: string;
    ts?: string;
    play_url?: string;
    segments?: number;
    label?: string;
    start?: string;
  };
}

export interface CustodyRecord {
  ts: string;
  action: string;
  user: string;
  detail: string;
  sha256?: string;
}

export interface CaseDetail extends Omit<CaseListItem, "items"> {
  items: CaseEvidenceItem[];
  custody: CustodyRecord[];
  custody_chain: {
    ok: boolean;
  };
}

export default function Cases() {
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();
  const { user, has } = useAuth();
  const canExport = has("export");

  // Tab mapping
  const tabFromSection = useMemo<"active" | "mine" | "closed" | "custody">(() => {
    if (!section || section === "active" || section === "open") return "active";
    if (section === "mine") return "mine";
    if (section === "closed") return "closed";
    if (section === "custody" || section === "evidence" || section === "detail") return "custody";
    return "active";
  }, [section]);

  const [tab, setTab] = useState<"active" | "mine" | "closed" | "custody">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "active" | "mine" | "closed" | "custody") => {
    setTab(nextTab);
    navigate(`/cases/${nextTab}`);
  };

  // State
  const [allCases, setAllCases] = useState<CaseListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedCaseDetail, setSelectedCaseDetail] = useState<CaseDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Filters & Pagination
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // New Case Modal
  const [openNewCaseModal, setOpenNewCaseModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newReference, setNewReference] = useState("");
  const [newPriority, setNewPriority] = useState<"high" | "medium" | "low">("medium");
  const [newOwner, setNewOwner] = useState("");
  const [savingNewCase, setSavingNewCase] = useState(false);

  // Add Note Form
  const [newNote, setNewNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  // Reassign / Update Priority Form in Detail
  const [assignOwner, setAssignOwner] = useState("");
  const [assignPriority, setAssignPriority] = useState<string>("medium");
  const [savingAssign, setSavingAssign] = useState(false);

  // Video Player Modal
  const [videoModal, setVideoModal] = useState<{
    open: boolean;
    url: string;
    title: string;
  }>({
    open: false,
    url: "",
    title: "",
  });

  // Load all cases list
  const loadCasesList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<CaseListItem[]>("/api/cases");
      setAllCases(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e.message || "Failed to load cases", "err");
      setAllCases([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load case detail
  const loadCaseDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const c = await api<CaseDetail>(`/api/cases/${id}`);
      setSelectedCaseDetail(c);
      setAssignOwner(c.owner || "");
      setAssignPriority(c.priority || "medium");
    } catch (e: any) {
      toast(e.message || "Failed to load case detail", "err");
      setSelectedCaseDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    loadCasesList();
  }, [loadCasesList]);

  // If a case is selected, load its detail
  useEffect(() => {
    if (selectedCaseId) {
      loadCaseDetail(selectedCaseId);
    }
  }, [selectedCaseId, loadCaseDetail]);

  // Select initial case if none selected and on custody tab
  useEffect(() => {
    if (tab === "custody" && !selectedCaseId && allCases.length > 0) {
      const first = allCases[0];
      setSelectedCaseId(first.id);
    }
  }, [tab, selectedCaseId, allCases]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [search, priorityFilter, tab]);

  // KPI Calculations
  const kpis = useMemo(() => {
    const total = allCases.length;
    const open = allCases.filter((c) => c.status === "open").length;
    const high = allCases.filter((c) => c.status === "open" && c.priority === "high").length;
    const mine = allCases.filter(
      (c) => c.status === "open" && user?.username && c.owner?.toLowerCase() === user.username.toLowerCase()
    ).length;
    const closed = allCases.filter((c) => c.status === "closed").length;
    return { total, open, high, mine, closed };
  }, [allCases, user]);

  // Filtered cases by active tab
  const tabFilteredCases = useMemo(() => {
    let list = allCases;
    if (tab === "active") {
      list = list.filter((c) => c.status === "open");
    } else if (tab === "mine") {
      const myUser = (user?.username || "").toLowerCase();
      list = list.filter(
        (c) => (c.owner || "").toLowerCase() === myUser || (c.created_by || "").toLowerCase() === myUser
      );
    } else if (tab === "closed") {
      list = list.filter((c) => c.status === "closed");
    }
    // "custody" tab displays all cases in its selector

    // Search filter
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.number.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          (c.reference || "").toLowerCase().includes(q) ||
          (c.owner || "").toLowerCase().includes(q) ||
          (c.department || "").toLowerCase().includes(q)
      );
    }

    // Priority filter
    if (priorityFilter !== "all") {
      list = list.filter((c) => c.priority === priorityFilter);
    }

    return list;
  }, [allCases, tab, search, priorityFilter, user]);

  const pagedCases = useMemo(() => {
    const start = (page - 1) * pageSize;
    return tabFilteredCases.slice(start, start + pageSize);
  }, [tabFilteredCases, page, pageSize]);

  // Handle Create Case
  const handleCreateCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setSavingNewCase(true);
    try {
      const created = await api<CaseListItem>("/api/cases", {
        method: "POST",
        body: JSON.stringify({
          title: newTitle.trim(),
          reference: newReference.trim(),
          priority: newPriority,
          owner: newOwner.trim() || user?.username || "admin",
        }),
      });
      toast(`Investigation dossier ${created.number} opened`, "ok");
      setOpenNewCaseModal(false);
      setNewTitle("");
      setNewReference("");
      setNewPriority("medium");
      setNewOwner("");
      await loadCasesList();
      setSelectedCaseId(created.id);
      handleTabChange("custody");
    } catch (e: any) {
      toast(e.message || "Failed to create case", "err");
    } finally {
      setSavingNewCase(false);
    }
  };

  // Toggle Case Status (Open / Close)
  const handleToggleCaseStatus = async () => {
    if (!selectedCaseDetail) return;
    const nextStatus = selectedCaseDetail.status === "open" ? "closed" : "open";
    try {
      await api(`/api/cases/${selectedCaseDetail.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      toast(`Case ${selectedCaseDetail.number} marked as ${nextStatus}`, "ok");
      loadCaseDetail(selectedCaseDetail.id);
      loadCasesList();
    } catch (e: any) {
      toast(e.message || "Failed to update case status", "err");
    }
  };

  // Save Assignment & Priority
  const handleSaveAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCaseDetail) return;
    setSavingAssign(true);
    try {
      await api(`/api/cases/${selectedCaseDetail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          owner: assignOwner.trim(),
          priority: assignPriority,
        }),
      });
      toast("Case owner and priority updated", "ok");
      loadCaseDetail(selectedCaseDetail.id);
      loadCasesList();
    } catch (e: any) {
      toast(e.message || "Failed to update assignment", "err");
    } finally {
      setSavingAssign(false);
    }
  };

  // Add Note to Case
  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCaseDetail || !newNote.trim()) return;
    setSavingNote(true);
    try {
      await api(`/api/cases/${selectedCaseDetail.id}/items`, {
        method: "POST",
        body: JSON.stringify({
          kind: "note",
          note: newNote.trim(),
        }),
      });
      toast("Investigation note appended to case", "ok");
      setNewNote("");
      loadCaseDetail(selectedCaseDetail.id);
    } catch (e: any) {
      toast(e.message || "Failed to add note", "err");
    } finally {
      setSavingNote(false);
    }
  };

  // Remove Evidence Item
  const handleRemoveItem = async (itemId: string) => {
    if (!selectedCaseDetail) return;
    if (!confirm("Remove this evidence record from the case dossier?")) return;
    try {
      await api(`/api/cases/${selectedCaseDetail.id}/items/${itemId}`, { method: "DELETE" });
      toast("Evidence record removed", "ok");
      loadCaseDetail(selectedCaseDetail.id);
      loadCasesList();
    } catch (e: any) {
      toast(e.message || "Failed to remove item", "err");
    }
  };

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Investigation Cases & Evidence Custody</h2>
              <p className="perm-page-desc">
                Incident dossiers, stitched video evidence, bookmark references, and SHA-256 tamper-evident chain of custody.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  loadCasesList();
                  if (selectedCaseId) loadCaseDetail(selectedCaseId);
                }}
                disabled={loading || loadingDetail}
                title="Refresh case dossiers"
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
                  setNewOwner(user?.username || "");
                  setOpenNewCaseModal(true);
                }}
                title="Open a new investigation case"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Open Case
              </button>
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Total Cases */}
            <div className="perm-kpi-card" title="Total case dossiers logged across all departments">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "#3b82f6" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="7" width="18" height="13" rx="2" />
                  <path d="M8 7V5h8v2M3 12h18" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Total Cases</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.total}</span>
                  <span className="kpi-sub-pill sober-pill">{kpis.open} Open</span>
                </div>
                <span className="kpi-desc">Dossiers in investigation system</span>
              </div>
            </div>

            {/* Active Investigations */}
            <div className="perm-kpi-card" title="Active open investigations currently pending resolution">
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
                  <span className="kpi-label">Active Cases</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.open}</span>
                  {kpis.high > 0 && (
                    <span
                      className="kpi-sub-pill sober-pill"
                      style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444" }}
                    >
                      {kpis.high} High Priority
                    </span>
                  )}
                </div>
                <span className="kpi-desc">Investigations in progress</span>
              </div>
            </div>

            {/* Assigned to Me */}
            <div className="perm-kpi-card" title="Cases assigned directly to your logged-in officer account">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Assigned To Me</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.mine}</span>
                  <span className="kpi-sub-pill sober-pill">{user?.username || "Officer"}</span>
                </div>
                <span className="kpi-desc">Personal investigation queue</span>
              </div>
            </div>

            {/* Closed Cases */}
            <div className="perm-kpi-card" title="Completed dossiers with archived evidence chains">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(100, 116, 139, 0.12)", color: "#64748b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Closed & Resolved</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.closed}</span>
                  <span className="kpi-sub-pill sober-pill">Archived</span>
                </div>
                <span className="kpi-desc">Sealed evidence archives</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "active" ? "active" : ""}`}
              onClick={() => handleTabChange("active")}
              role="tab"
            >
              <span>Active Cases</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{kpis.open}</span>
              {tab === "active" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "mine" ? "active" : ""}`}
              onClick={() => handleTabChange("mine")}
              role="tab"
            >
              <span>My Cases</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{kpis.mine}</span>
              {tab === "mine" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "closed" ? "active" : ""}`}
              onClick={() => handleTabChange("closed")}
              role="tab"
            >
              <span>Closed Cases</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{kpis.closed}</span>
              {tab === "closed" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "custody" ? "active" : ""}`}
              onClick={() => handleTabChange("custody")}
              role="tab"
            >
              <span>Evidence & Custody</span>
              {selectedCaseDetail && (
                <span className="tab-tag" style={{ marginLeft: 6 }}>{selectedCaseDetail.number}</span>
              )}
              {tab === "custody" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TABS 1-3: ACTIVE / MINE / CLOSED CASE LISTINGS
             ========================================================================= */}
          {tab !== "custody" && (
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
                    {tab === "active"
                      ? "Active Investigation Cases"
                      : tab === "mine"
                      ? "My Assigned Investigations"
                      : "Closed & Archived Investigation Files"}
                  </h3>
                  <p className="perm-panel-desc" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    Click on any case to inspect its evidence catalog, watch recorded clips, and audit the cryptographic chain of custody.
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {/* Priority Filter */}
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: 0 }}>
                    <span style={{ color: "var(--muted)", fontSize: 12 }}>Priority:</span>
                    <select
                      className="search-input"
                      style={{ padding: "4px 8px", fontSize: 12, height: 32, borderRadius: 6, width: 110 }}
                      value={priorityFilter}
                      onChange={(e) => setPriorityFilter(e.target.value)}
                    >
                      <option value="all">All</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
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
                      style={{ paddingLeft: 30, paddingRight: search ? 28 : 10, height: 32, fontSize: 12 }}
                      placeholder="Search case, title, ref, owner…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        type="button"
                        className="clear-btn"
                        onClick={() => setSearch("")}
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
                      <th style={{ padding: "10px 14px" }}>Case No.</th>
                      <th style={{ padding: "10px 14px" }}>Title</th>
                      <th style={{ padding: "10px 14px" }}>Reference / FIR</th>
                      <th style={{ padding: "10px 14px" }}>Priority</th>
                      <th style={{ padding: "10px 14px" }}>Assigned Owner</th>
                      <th style={{ padding: "10px 14px" }}>Evidence</th>
                      <th style={{ padding: "10px 14px" }}>Status</th>
                      <th style={{ padding: "10px 14px" }}>Last Updated</th>
                      <th style={{ padding: "10px 14px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && allCases.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          Loading cases…
                        </td>
                      </tr>
                    ) : pagedCases.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "32px", textAlign: "center", color: "var(--muted)" }}>
                          No investigation cases found for current filter criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedCases.map((c) => {
                        const isHigh = c.priority === "high";
                        const isLow = c.priority === "low";
                        const isOpen = c.status === "open";

                        return (
                          <tr
                            key={c.id}
                            className="perm-row"
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setSelectedCaseId(c.id);
                              handleTabChange("custody");
                            }}
                          >
                            {/* Case Number */}
                            <td style={{ padding: "12px 14px", fontWeight: 700, color: "var(--text)" }}>
                              <span style={{ fontFamily: "monospace", fontSize: 13 }}>{c.number}</span>
                            </td>

                            {/* Title */}
                            <td style={{ padding: "12px 14px", fontWeight: 600 }}>
                              <div style={{ color: "var(--text)" }}>{c.title}</div>
                              {c.department && (
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.department}</div>
                              )}
                            </td>

                            {/* Reference */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12 }}>
                              {c.reference || "–"}
                            </td>

                            {/* Priority */}
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 4,
                                  fontSize: 11,
                                  fontWeight: 600,
                                  textTransform: "capitalize",
                                  background: isHigh
                                    ? "rgba(239, 68, 68, 0.15)"
                                    : isLow
                                    ? "rgba(100, 116, 139, 0.15)"
                                    : "rgba(245, 158, 11, 0.15)",
                                  color: isHigh ? "#ef4444" : isLow ? "#64748b" : "#f59e0b",
                                }}
                              >
                                {c.priority}
                              </span>
                            </td>

                            {/* Owner */}
                            <td style={{ padding: "12px 14px" }}>
                              <div style={{ fontWeight: 500 }}>{c.owner || "Unassigned"}</div>
                              {c.created_by && (
                                <div style={{ fontSize: 10, color: "var(--muted)" }}>
                                  Opened by {c.created_by}
                                </div>
                              )}
                            </td>

                            {/* Evidence Count */}
                            <td style={{ padding: "12px 14px" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  background: "var(--panel2)",
                                  border: "1px solid var(--line)",
                                  fontSize: 11,
                                  fontWeight: 600,
                                }}
                              >
                                {c.items} {c.items === 1 ? "item" : "items"}
                              </span>
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
                                  background: isOpen
                                    ? "rgba(16, 185, 129, 0.15)"
                                    : "rgba(100, 116, 139, 0.15)",
                                  color: isOpen ? "#10b981" : "#64748b",
                                }}
                              >
                                {c.status}
                              </span>
                            </td>

                            {/* Last Updated */}
                            <td style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                              {fmtTime(c.updated_at || c.created_at)}
                            </td>

                            {/* Actions */}
                            <td
                              style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "inline-flex", gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  onClick={() => {
                                    setSelectedCaseId(c.id);
                                    handleTabChange("custody");
                                  }}
                                  title="Open case evidence dossier"
                                >
                                  View Dossier
                                </button>
                                {canExport && (
                                  <a
                                    className="btn ghost small"
                                    href={withTok(`/api/cases/${c.id}/export`)}
                                    title="Export report PDF + watermarked media pack"
                                    download={`case-${c.number}.zip`}
                                  >
                                    Export
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
                  Investigation cases record sightings, stitched vehicle timelines, and operator notes.
                </div>
                <Pager
                  page={page}
                  pages={Math.ceil(tabFilteredCases.length / pageSize) || 1}
                  total={tabFilteredCases.length}
                  onPage={setPage}
                  size={pageSize}
                  onSize={setPageSize}
                />
              </div>
            </div>
          )}

          {/* =========================================================================
              TAB 4: EVIDENCE & CUSTODY DETAIL VIEW
             ========================================================================= */}
          {tab === "custody" && (
            <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16 }}>
              {/* Left Column: Case Selector List */}
              <div className="perm-panel-card" style={{ height: "fit-content" }}>
                <div
                  className="perm-panel-head"
                  style={{
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--line)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Select Investigation</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{allCases.length} files</span>
                </div>

                <div style={{ maxHeight: "calc(100vh - 280px)", overflowY: "auto", padding: "6px" }}>
                  {allCases.length === 0 ? (
                    <div style={{ padding: "20px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
                      No cases open. Use "+ Open Case" above.
                    </div>
                  ) : (
                    allCases.map((c) => {
                      const isSel = selectedCaseId === c.id;
                      return (
                        <div
                          key={c.id}
                          onClick={() => setSelectedCaseId(c.id)}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 6,
                            marginBottom: 4,
                            cursor: "pointer",
                            background: isSel ? "var(--panel2)" : "transparent",
                            border: isSel ? "1px solid #3b82f6" : "1px solid transparent",
                            transition: "all 0.12s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>
                              {c.number}
                            </span>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                padding: "1px 6px",
                                borderRadius: 3,
                                textTransform: "capitalize",
                                background:
                                  c.status === "open"
                                    ? "rgba(16, 185, 129, 0.15)"
                                    : "rgba(100, 116, 139, 0.15)",
                                color: c.status === "open" ? "#10b981" : "#64748b",
                              }}
                            >
                              {c.status}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "var(--text)",
                              marginTop: 2,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {c.title}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: 11,
                              color: "var(--muted)",
                              marginTop: 4,
                            }}
                          >
                            <span>Owner: {c.owner}</span>
                            <span>{c.items} items</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Case Dossier & Chain of Custody */}
              <div>
                {loadingDetail ? (
                  <div className="perm-panel-card" style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
                    Loading investigation dossier details…
                  </div>
                ) : !selectedCaseDetail ? (
                  <div className="perm-panel-card" style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
                    Please select a case from the list on the left to inspect evidence and verify the custody chain.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {/* Top Case Dossier Banner */}
                    <div className="perm-panel-card" style={{ padding: "16px 20px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: 12,
                          borderBottom: "1px solid var(--line)",
                          paddingBottom: 14,
                        }}
                      >
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#3b82f6" }}>
                              {selectedCaseDetail.number}
                            </span>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                              {selectedCaseDetail.title}
                            </h3>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                padding: "2px 8px",
                                borderRadius: 4,
                                textTransform: "uppercase",
                                background:
                                  selectedCaseDetail.status === "open"
                                    ? "rgba(16, 185, 129, 0.15)"
                                    : "rgba(100, 116, 139, 0.15)",
                                color: selectedCaseDetail.status === "open" ? "#10b981" : "#64748b",
                              }}
                            >
                              {selectedCaseDetail.status}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                            Ref: <b>{selectedCaseDetail.reference || "None"}</b> • Priority:{" "}
                            <b>{selectedCaseDetail.priority}</b> • Dept:{" "}
                            <b>{selectedCaseDetail.department || "General"}</b> • Opened by{" "}
                            <b>{selectedCaseDetail.created_by}</b> on {fmtTime(selectedCaseDetail.created_at)}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {canExport && (
                            <a
                              className="btn ghost small"
                              href={withTok(`/api/cases/${selectedCaseDetail.id}/export`)}
                              title="Export PDF dossier with SHA-256 manifest and evidence clips"
                              download={`case-${selectedCaseDetail.number}.zip`}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 13, maxHeight: 13, marginRight: 4 }}>
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                              Export Bundle
                            </a>
                          )}
                          <button
                            type="button"
                            className="btn small outline"
                            onClick={handleToggleCaseStatus}
                            title="Toggle case status"
                          >
                            {selectedCaseDetail.status === "open" ? "Close Case" : "Reopen Case"}
                          </button>
                        </div>
                      </div>

                      {/* Quick Assign & Priority Form */}
                      <form
                        onSubmit={handleSaveAssign}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          marginTop: 12,
                          flexWrap: "wrap",
                          fontSize: 12,
                        }}
                      >
                        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
                          <span style={{ color: "var(--muted)" }}>Assignee:</span>
                          <input
                            type="text"
                            className="search-input"
                            style={{ height: 28, fontSize: 12, width: 140, padding: "2px 8px" }}
                            value={assignOwner}
                            onChange={(e) => setAssignOwner(e.target.value)}
                            placeholder="Officer username"
                          />
                        </label>

                        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
                          <span style={{ color: "var(--muted)" }}>Priority:</span>
                          <select
                            className="search-input"
                            style={{ height: 28, fontSize: 12, width: 110, padding: "2px 8px" }}
                            value={assignPriority}
                            onChange={(e) => setAssignPriority(e.target.value)}
                          >
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                          </select>
                        </label>

                        <button
                          type="submit"
                          className="btn ghost small"
                          disabled={savingAssign}
                        >
                          {savingAssign ? "Saving…" : "Save Changes"}
                        </button>
                      </form>
                    </div>

                    {/* Evidence Items Catalog */}
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
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                            Filed Evidence Items
                          </h4>
                          <span
                            style={{
                              fontSize: 11,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "var(--panel2)",
                              border: "1px solid var(--line)",
                              fontWeight: 600,
                            }}
                          >
                            {selectedCaseDetail.items.length}
                          </span>
                        </div>
                      </div>

                      <div style={{ padding: "14px 18px" }}>
                        {selectedCaseDetail.items.length === 0 ? (
                          <div style={{ padding: "24px 0", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
                            No evidence items filed into this case yet. Use &ldquo;+ Case&rdquo; on vehicle search results, bookmarks, or &ldquo;Stitch clips&rdquo; in Vehicle movement.
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {selectedCaseDetail.items.map((it) => {
                              const m = it.meta || {};
                              const cropSrc = m.crop_url ? withTok(m.crop_url) : null;

                              return (
                                <div
                                  key={it.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    padding: "10px 14px",
                                    background: "var(--panel2)",
                                    borderRadius: 6,
                                    border: "1px solid var(--line)",
                                    gap: 12,
                                    fontSize: 13,
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
                                    {/* Thumbnail or Kind Tag */}
                                    {cropSrc ? (
                                      <img
                                        src={cropSrc}
                                        alt="Crop"
                                        style={{
                                          width: 56,
                                          height: 36,
                                          objectFit: "cover",
                                          borderRadius: 4,
                                          border: "1px solid var(--line)",
                                        }}
                                      />
                                    ) : (
                                      <span
                                        style={{
                                          padding: "3px 8px",
                                          borderRadius: 4,
                                          fontSize: 11,
                                          fontWeight: 600,
                                          textTransform: "uppercase",
                                          background: "var(--panel)",
                                          border: "1px solid var(--line)",
                                          color: "var(--text)",
                                        }}
                                      >
                                        {it.kind}
                                      </span>
                                    )}

                                    {/* Item Description */}
                                    <div style={{ flex: 1 }}>
                                      {it.kind === "event" ? (
                                        <div>
                                          <b>{m.plate}</b> • {m.camera_name || m.camera_id} • {fmtTime(m.ts)}
                                          {it.note && (
                                            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                                              {it.note}
                                            </div>
                                          )}
                                        </div>
                                      ) : it.kind === "note" ? (
                                        <div>
                                          <div>{it.note}</div>
                                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                                            Note by {it.added_by} on {fmtTime(it.added_at)}
                                          </div>
                                        </div>
                                      ) : (
                                        <div>
                                          <div>
                                            {it.kind === "stitch"
                                              ? `Stitched timeline: ${m.plate} (${m.segments} camera clips)`
                                              : it.kind === "bookmark"
                                              ? `Bookmark: ${m.label} • ${m.camera_name || m.camera_id} • ${fmtTime(m.ts)}`
                                              : `Video recording: ${m.camera_id} • ${fmtTime(m.start)}`}
                                          </div>
                                          {it.note && (
                                            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                                              {it.note}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Actions: Clip / Delete */}
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    {m.play_url && (
                                      <button
                                        type="button"
                                        className="btn ghost small"
                                        style={{ color: "#3b82f6" }}
                                        onClick={() =>
                                          setVideoModal({
                                            open: true,
                                            url: m.play_url!,
                                            title: `Evidence Playback: ${m.plate || it.kind}`,
                                          })
                                        }
                                        title="Play evidence recording clip"
                                      >
                                        Play Clip
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="btn ghost small"
                                      style={{ color: "#ef4444" }}
                                      onClick={() => handleRemoveItem(it.id)}
                                      title="Remove evidence item"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Add Note Input Bar */}
                        <form
                          onSubmit={handleAddNote}
                          style={{
                            display: "flex",
                            gap: 10,
                            marginTop: 14,
                            paddingTop: 14,
                            borderTop: "1px solid var(--line)",
                          }}
                        >
                          <input
                            type="text"
                            className="search-input"
                            style={{ flex: 1, height: 34, fontSize: 13 }}
                            placeholder="Add an investigation note to this case dossier…"
                            value={newNote}
                            onChange={(e) => setNewNote(e.target.value)}
                            required
                          />
                          <button
                            type="submit"
                            className="btn primary small"
                            disabled={savingNote || !newNote.trim()}
                          >
                            {savingNote ? "Adding…" : "Add Note"}
                          </button>
                        </form>
                      </div>
                    </div>

                    {/* Chain of Custody Audit Trail */}
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
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                            Chain of Custody
                          </h4>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: "2px 8px",
                              borderRadius: 4,
                              background: selectedCaseDetail.custody_chain?.ok
                                ? "rgba(16, 185, 129, 0.15)"
                                : "rgba(239, 68, 68, 0.15)",
                              color: selectedCaseDetail.custody_chain?.ok ? "#10b981" : "#ef4444",
                            }}
                          >
                            {selectedCaseDetail.custody_chain?.ok ? "✓ Chain Intact" : "✗ Broken Integrity"}
                          </span>
                        </div>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>
                          SHA-256 cryptographic audit ledger
                        </span>
                      </div>

                      <div style={{ padding: "14px 18px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                          {selectedCaseDetail.custody && selectedCaseDetail.custody.length > 0 ? (
                            selectedCaseDetail.custody.map((x, idx) => (
                              <div
                                key={idx}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 4,
                                  background: "var(--panel2)",
                                  border: "1px solid var(--line)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  flexWrap: "wrap",
                                  gap: 6,
                                }}
                              >
                                <div>
                                  <span style={{ color: "var(--muted)", marginRight: 8 }}>
                                    {fmtTime(x.ts)}
                                  </span>
                                  <b style={{ textTransform: "capitalize", marginRight: 8 }}>
                                    {x.action.replace(/_/g, " ")}
                                  </b>
                                  <span style={{ color: "var(--text)" }}>by {x.user}</span>
                                  <span style={{ margin: "0 6px", color: "var(--muted)" }}>•</span>
                                  <span style={{ color: "var(--muted)" }}>{x.detail}</span>
                                </div>
                                {x.sha256 && (
                                  <div
                                    style={{
                                      fontFamily: "monospace",
                                      fontSize: 11,
                                      color: "var(--muted)",
                                      background: "var(--panel)",
                                      padding: "1px 6px",
                                      borderRadius: 3,
                                    }}
                                    title={`Full hash: ${x.sha256}`}
                                  >
                                    sha256: {x.sha256.slice(0, 16)}…
                                  </div>
                                )}
                              </div>
                            ))
                          ) : (
                            <div style={{ color: "var(--muted)", textAlign: "center", padding: "16px 0" }}>
                              No custody events recorded yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================================
              MODAL: OPEN NEW INVESTIGATION CASE
             ========================================================================= */}
          {openNewCaseModal && (
            <Modal
              open={openNewCaseModal}
              onClose={() => setOpenNewCaseModal(false)}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Open New Investigation Case</h3>
              <form onSubmit={handleCreateCase} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Case Title:</span>
                  <input
                    type="text"
                    className="search-input"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g. Hit and run suspect, Ring Road junction"
                    required
                    autoFocus
                  />
                </label>

                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>Reference / FIR Number (optional):</span>
                  <input
                    type="text"
                    className="search-input"
                    value={newReference}
                    onChange={(e) => setNewReference(e.target.value)}
                    placeholder="e.g. FIR-2026/04812"
                  />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Priority:</span>
                    <select
                      className="search-input"
                      value={newPriority}
                      onChange={(e) => setNewPriority(e.target.value as "high" | "medium" | "low")}
                    >
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>Assign to Owner:</span>
                    <input
                      type="text"
                      className="search-input"
                      value={newOwner}
                      onChange={(e) => setNewOwner(e.target.value)}
                      placeholder="Username (default: you)"
                    />
                  </label>
                </div>

                <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
                  Opening a case initializes a cryptographic SHA-256 chain of custody for all subsequent evidence.
                </p>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setOpenNewCaseModal(false)}
                    disabled={savingNewCase}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={savingNewCase || !newTitle.trim()}
                  >
                    {savingNewCase ? "Opening…" : "Open Case Dossier"}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {/* =========================================================================
              MODAL: VIDEO PLAYBACK
             ========================================================================= */}
          {videoModal.open && (
            <Modal
              open={videoModal.open}
              onClose={() => setVideoModal((m) => ({ ...m, open: false }))}
              wide
            >
              <h3 style={{ margin: "0 0 10px", fontSize: 16 }}>{videoModal.title}</h3>
              <div style={{ width: "100%", background: "#000", borderRadius: 8, overflow: "hidden" }}>
                <video
                  controls
                  autoPlay
                  playsInline
                  src={withTok(videoModal.url)}
                  style={{ width: "100%", maxHeight: "65vh", display: "block" }}
                />
              </div>
              <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--muted)" }}>
                Streamed from secure object storage archive. Access is logged in the system audit trail.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => setVideoModal((m) => ({ ...m, open: false }))}
                >
                  Close Player
                </button>
              </div>
            </Modal>
          )}
        </div>
      </section>
    </main>
  );
}
