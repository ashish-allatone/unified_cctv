import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, token } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtTime } from "../lib/format";
import { toast } from "../lib/toast";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

export interface WatchlistSectionItem {
  id: string;
  tabKey: "plates" | "persons" | "hotlists" | "sightings";
  label: string;
  desc: string;
  iconName: "plates" | "persons" | "hotlists" | "sightings";
}

export const WATCHLIST_SECTIONS: WatchlistSectionItem[] = [
  {
    id: "plates",
    tabKey: "plates",
    label: "Watchlist Plates",
    desc: "Vehicles of interest & stolen vehicle alerts",
    iconName: "plates",
  },
  {
    id: "persons",
    tabKey: "persons",
    label: "Persons of Interest",
    desc: "Facial recognition watch catalog & suspects",
    iconName: "persons",
  },
  {
    id: "hotlists",
    tabKey: "hotlists",
    label: "External Hotlists",
    desc: "Automated police feeds & central sync",
    iconName: "hotlists",
  },
  {
    id: "sightings",
    tabKey: "sightings",
    label: "Live Sightings",
    desc: "Camera detections and alert events",
    iconName: "sightings",
  },
];

export interface WatchlistPlate {
  plate: string;
  reason: string;
  priority: "high" | "medium" | "low";
  added_by?: string;
  expires_at?: string | null;
  created_at?: string;
}

export interface EnrolledPerson {
  id: string;
  name: string;
  category: "wanted" | "missing" | "suspect" | "other";
  priority: "high" | "medium" | "low";
  reference?: string;
  reason?: string;
  photos: number;
  photo_urls: string[];
  active: boolean;
  last_seen_at?: string | null;
  last_seen_camera?: string | null;
  sightings: number;
  expires_at?: string | null;
}

export interface HotlistSource {
  name: string;
  kind: string;
  interval_minutes: number;
  last?: {
    ok: boolean;
    entries: number;
    added: number;
    removed: number;
    at: string;
    error?: string;
  } | null;
}

export interface PersonSighting {
  ts: string;
  camera_id: string;
  camera_name?: string;
  score?: number | string;
  snapshot_url?: string;
}

export function withToken(url?: string | null): string {
  if (!url) return "";
  const tok = token();
  if (!tok) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(tok)}`;
}

export default function Watchlist() {
  const { has } = useAuth();
  const canSupervisor = has("supervisor") || has("admin");
  const canManageWatchlist = has("watchlist") || has("admin");
  const { section } = useParams<{ section?: string }>();
  const navigate = useNavigate();

  // Tab mapping
  const tabFromSection = useMemo<"plates" | "persons" | "hotlists" | "sightings">(() => {
    if (!section || section === "plates" || section === "vehicles") return "plates";
    if (section === "persons" || section === "faces") return "persons";
    if (section === "hotlists" || section === "sync") return "hotlists";
    if (section === "sightings" || section === "alerts") return "sightings";
    return "plates";
  }, [section]);

  const [tab, setTab] = useState<"plates" | "persons" | "hotlists" | "sightings">(tabFromSection);

  useEffect(() => {
    setTab(tabFromSection);
  }, [tabFromSection]);

  const handleTabChange = (nextTab: "plates" | "persons" | "hotlists" | "sightings") => {
    setTab(nextTab);
    navigate(`/watchlist/${nextTab}`);
  };

  // Data states
  const [plates, setPlates] = useState<WatchlistPlate[]>([]);
  const [persons, setPersons] = useState<EnrolledPerson[]>([]);
  const [hotlists, setHotlists] = useState<HotlistSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncingHotlists, setSyncingHotlists] = useState(false);

  // Filters & Pagination for Plates
  const [plateSearch, setPlateSearch] = useState("");
  const [platePriority, setPlatePriority] = useState<"all" | "high" | "medium" | "low">("all");
  const [platePage, setPlatePage] = useState(1);
  const [platePageSize, setPlatePageSize] = useState(25);

  // Filters & Pagination for Persons
  const [personSearch, setPersonSearch] = useState("");
  const [personCategory, setPersonCategory] = useState<"all" | "wanted" | "missing" | "suspect" | "other">("all");
  const [personPriority, setPersonPriority] = useState<"all" | "high" | "medium" | "low">("all");
  const [personStatus, setPersonStatus] = useState<"all" | "active" | "paused">("all");
  const [personPage, setPersonPage] = useState(1);
  const [personPageSize, setPersonPageSize] = useState(25);

  // Modal: Add Plate
  const [showAddPlateModal, setShowAddPlateModal] = useState(false);
  const [newPlate, setNewPlate] = useState("");
  const [newPlateReason, setNewPlateReason] = useState("");
  const [newPlatePriority, setNewPlatePriority] = useState<"high" | "medium" | "low">("high");
  const [newPlateDays, setNewPlateDays] = useState(30);
  const [savingPlate, setSavingPlate] = useState(false);

  // Modal: Enrol Person
  const [showEnrolPersonModal, setShowEnrolPersonModal] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [newPersonCategory, setNewPersonCategory] = useState<"wanted" | "missing" | "suspect" | "other">("suspect");
  const [newPersonPriority, setNewPersonPriority] = useState<"high" | "medium" | "low">("high");
  const [newPersonReference, setNewPersonReference] = useState("");
  const [newPersonReason, setNewPersonReason] = useState("");
  const [newPersonDays, setNewPersonDays] = useState(90);
  const [newPersonPhotos, setNewPersonPhotos] = useState<File[]>([]);
  const [enrollingPerson, setEnrollingPerson] = useState(false);

  // Modal: Person Sightings
  const [sightingsPerson, setSightingsPerson] = useState<EnrolledPerson | null>(null);
  const [sightings, setSightings] = useState<PersonSighting[]>([]);
  const [loadingSightings, setLoadingSightings] = useState(false);

  // Load all data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [plateRes, personRes, hotlistRes] = await Promise.all([
        api<WatchlistPlate[]>("/api/watchlist").catch(() => []),
        api<EnrolledPerson[]>("/api/persons").catch(() => []),
        api<{ sources: HotlistSource[] }>("/api/hotlists").catch(() => ({ sources: [] })),
      ]);
      setPlates(plateRes || []);
      setPersons(personRes || []);
      setHotlists(hotlistRes?.sources || []);
    } catch (e: any) {
      toast(e.message || "Failed to load watchlist data", "err");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // KPIs
  const kpis = useMemo(() => {
    const totalPlates = plates.length;
    const highPlates = plates.filter((p) => p.priority === "high").length;
    const totalPersons = persons.length;
    const activePersons = persons.filter((p) => p.active).length;
    const totalSightings = persons.reduce((acc, p) => acc + (p.sightings || 0), 0);
    const hotlistCount = hotlists.length;

    return { totalPlates, highPlates, totalPersons, activePersons, totalSightings, hotlistCount };
  }, [plates, persons, hotlists]);

  // Filtered Plates
  const filteredPlates = useMemo(() => {
    const q = plateSearch.trim().toLowerCase();
    return plates.filter((p) => {
      if (platePriority !== "all" && p.priority !== platePriority) return false;
      if (q && !p.plate.toLowerCase().includes(q) && !p.reason.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [plates, plateSearch, platePriority]);

  const plateTotalPages = Math.max(1, Math.ceil(filteredPlates.length / platePageSize));
  const pagedPlates = useMemo(() => {
    const start = (platePage - 1) * platePageSize;
    return filteredPlates.slice(start, start + platePageSize);
  }, [filteredPlates, platePage, platePageSize]);

  // Filtered Persons
  const filteredPersons = useMemo(() => {
    const q = personSearch.trim().toLowerCase();
    return persons.filter((p) => {
      if (personCategory !== "all" && p.category !== personCategory) return false;
      if (personPriority !== "all" && p.priority !== personPriority) return false;
      if (personStatus === "active" && !p.active) return false;
      if (personStatus === "paused" && p.active) return false;
      if (q) {
        const nameMatch = p.name.toLowerCase().includes(q);
        const refMatch = (p.reference || "").toLowerCase().includes(q);
        const reasonMatch = (p.reason || "").toLowerCase().includes(q);
        if (!nameMatch && !refMatch && !reasonMatch) return false;
      }
      return true;
    });
  }, [persons, personSearch, personCategory, personPriority, personStatus]);

  const personTotalPages = Math.max(1, Math.ceil(filteredPersons.length / personPageSize));
  const pagedPersons = useMemo(() => {
    const start = (personPage - 1) * personPageSize;
    return filteredPersons.slice(start, start + personPageSize);
  }, [filteredPersons, personPage, personPageSize]);

  // Reset page when filters change
  useEffect(() => {
    setPlatePage(1);
  }, [plateSearch, platePriority]);

  useEffect(() => {
    setPersonPage(1);
  }, [personSearch, personCategory, personPriority, personStatus]);

  // Add Watchlist Plate Action
  const handleAddPlate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlate.trim()) return;

    setSavingPlate(true);
    try {
      const res = await api<WatchlistPlate>("/api/watchlist", {
        method: "POST",
        body: JSON.stringify({
          plate: newPlate.trim().toUpperCase(),
          reason: newPlateReason.trim(),
          priority: newPlatePriority,
          days: Number(newPlateDays),
        }),
      });
      toast(`Plate "${res.plate}" added to watchlist`, "ok");
      setShowAddPlateModal(false);
      setNewPlate("");
      setNewPlateReason("");
      setNewPlatePriority("high");
      setNewPlateDays(30);
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to add plate to watchlist", "err");
    } finally {
      setSavingPlate(false);
    }
  };

  // Remove Watchlist Plate
  const handleRemovePlate = async (plateStr: string) => {
    if (!confirm(`Remove vehicle plate "${plateStr}" from watchlist?`)) return;
    try {
      await api(`/api/watchlist/${encodeURIComponent(plateStr)}`, { method: "DELETE" });
      toast(`Plate "${plateStr}" removed from watchlist`, "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to remove plate", "err");
    }
  };

  // Enrol Person Action
  const handleEnrolPerson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonName.trim() || newPersonPhotos.length === 0) {
      toast("Please provide person name and at least one photo", "warn");
      return;
    }

    setEnrollingPerson(true);
    const fd = new FormData();
    fd.append("name", newPersonName.trim());
    fd.append("category", newPersonCategory);
    fd.append("priority", newPersonPriority);
    if (newPersonReference.trim()) fd.append("reference", newPersonReference.trim());
    if (newPersonReason.trim()) fd.append("reason", newPersonReason.trim());
    fd.append("days", String(newPersonDays));
    newPersonPhotos.forEach((file) => fd.append("photos", file));

    try {
      const tok = token();
      const res = await fetch("/api/persons", {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || res.statusText || "Enrolment failed");

      toast(`${data.name} enrolled with ${data.photos} photo(s). Active on cameras in 30s.`, "ok");
      setShowEnrolPersonModal(false);
      setNewPersonName("");
      setNewPersonReference("");
      setNewPersonReason("");
      setNewPersonPhotos([]);
      setNewPersonDays(90);
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to enrol person", "err");
    } finally {
      setEnrollingPerson(false);
    }
  };

  // Toggle Person Tracking (Active/Paused)
  const handleTogglePersonActive = async (p: EnrolledPerson) => {
    const nextActive = !p.active;
    try {
      await api(`/api/persons/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: nextActive }),
      });
      toast(`${p.name} tracking ${nextActive ? "resumed" : "paused"}`, "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to update person tracking status", "err");
    }
  };

  // Remove Enrolled Person
  const handleRemovePerson = async (p: EnrolledPerson) => {
    if (!confirm(`Permanently remove "${p.name}", face embeddings, and all sightings?`)) return;
    try {
      await api(`/api/persons/${p.id}`, { method: "DELETE" });
      toast(`${p.name} removed from watchlist`, "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to remove person", "err");
    }
  };

  // View Person Sightings
  const handleOpenSightings = async (p: EnrolledPerson) => {
    setSightingsPerson(p);
    setLoadingSightings(true);
    try {
      const res = await api<PersonSighting[]>(`/api/persons/${p.id}/sightings`);
      setSightings(res || []);
    } catch (e: any) {
      toast(e.message || "Failed to load sightings", "err");
    } finally {
      setLoadingSightings(false);
    }
  };

  // Hotlists Manual Sync
  const handleSyncHotlists = async () => {
    setSyncingHotlists(true);
    try {
      const res = await api<Record<string, { source: string; added: number }>>("/api/hotlists/sync", { method: "POST" });
      const summary = Object.values(res)
        .map((x) => `${x.source} (+${x.added ?? 0})`)
        .join(", ");
      toast(`Hotlists synced: ${summary || "All up to date"}`, "ok");
      loadData();
    } catch (e: any) {
      toast(e.message || "Failed to sync external hotlists", "err");
    } finally {
      setSyncingHotlists(false);
    }
  };

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        <div className="perm-console-root">
          {/* Header & Quick Action Buttons */}
          <div className="perm-header-row">
            <div>
              <h2 className="perm-page-title">Watchlist & Persons of Interest</h2>
              <p className="perm-page-desc">
                High-priority stolen vehicle plates, wanted suspects, missing persons, and automated central hotlist integrations across all CCTV feeds.
              </p>
            </div>
            <div className="perm-actions-group">
              <button
                type="button"
                className="btn ghost small"
                onClick={loadData}
                disabled={loading}
                title="Refresh watchlist targets and sync states"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>

              {canManageWatchlist && (
                <>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setShowAddPlateModal(true)}
                    title="Add a vehicle number plate to watchlist"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add Plate
                  </button>

                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => setShowEnrolPersonModal(true)}
                    title="Enrol person of interest with photo for face recognition"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ maxWidth: 14, maxHeight: 14, marginRight: 6 }}>
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                      <line x1="20" y1="8" x2="20" y2="14" />
                      <line x1="23" y1="11" x2="17" y2="11" />
                    </svg>
                    Enrol Person
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Top KPI Metrics Strip */}
          <div className="perm-kpis-grid">
            {/* Watchlist Plates */}
            <div className="perm-kpi-card" title="Total active vehicle registration plates tracked in watchlist">
              <div className="kpi-icon-box sober-icon-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="5" width="20" height="14" rx="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Monitored Plates</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalPlates}</span>
                  <span className="kpi-sub-pill sober-pill">{kpis.highPlates} High Priority</span>
                </div>
                <span className="kpi-desc">Stolen & flagged vehicles</span>
              </div>
            </div>

            {/* Enrolled Persons */}
            <div className="perm-kpi-card" title="Total persons enrolled for real-time facial recognition">
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
                  <span className="kpi-label">Persons of Interest</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalPersons}</span>
                  <span className="kpi-sub-pill sober-pill">{kpis.activePersons} Active</span>
                </div>
                <span className="kpi-desc">Face embeddings in camera cache</span>
              </div>
            </div>

            {/* Total Sightings */}
            <div className="perm-kpi-card" title="Cumulative camera sightings recorded for enrolled targets">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(16, 185, 129, 0.12)", color: "#10b981" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 14 14" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Camera Sightings</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.totalSightings.toLocaleString("en-IN")}</span>
                  <span className="kpi-sub-pill sober-pill">Recorded</span>
                </div>
                <span className="kpi-desc">Matches flagged on face cameras</span>
              </div>
            </div>

            {/* Hotlists Active */}
            <div className="perm-kpi-card" title="External state and central police hotlist data feeds">
              <div
                className="kpi-icon-box sober-icon-box"
                style={{ background: "rgba(245, 158, 11, 0.12)", color: "#f59e0b" }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </div>
              <div className="kpi-meta">
                <div className="kpi-title-row">
                  <span className="kpi-label">Hotlist Feeds</span>
                </div>
                <div className="kpi-value-row">
                  <span className="kpi-value">{kpis.hotlistCount}</span>
                  <span className="kpi-sub-pill sober-pill">Syncing</span>
                </div>
                <span className="kpi-desc">Automated database integrations</span>
              </div>
            </div>
          </div>

          {/* Sub-Navigation Tabs Bar */}
          <div className="admin-tabs-bar" role="tablist" style={{ marginTop: 6, marginBottom: 14 }}>
            <button
              type="button"
              className={`admin-tab-item ${tab === "plates" ? "active" : ""}`}
              onClick={() => handleTabChange("plates")}
              role="tab"
            >
              <span>Watchlist Plates</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{plates.length}</span>
              {tab === "plates" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "persons" ? "active" : ""}`}
              onClick={() => handleTabChange("persons")}
              role="tab"
            >
              <span>Persons of Interest</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{persons.length}</span>
              {tab === "persons" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "hotlists" ? "active" : ""}`}
              onClick={() => handleTabChange("hotlists")}
              role="tab"
            >
              <span>External Hotlists</span>
              <span className="tab-tag" style={{ marginLeft: 6 }}>{hotlists.length}</span>
              {tab === "hotlists" && <div className="tab-active-indicator" />}
            </button>
            <button
              type="button"
              className={`admin-tab-item ${tab === "sightings" ? "active" : ""}`}
              onClick={() => handleTabChange("sightings")}
              role="tab"
            >
              <span>Live Sightings Feed</span>
              {tab === "sightings" && <div className="tab-active-indicator" />}
            </button>
          </div>

          {/* =========================================================================
              TAB 1: Watchlist Plates
              ========================================================================= */}
          {tab === "plates" && (
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
                      value={plateSearch}
                      onChange={(e) => setPlateSearch(e.target.value)}
                      placeholder="Search plate or reason…"
                      className="search-input"
                    />
                    {plateSearch && (
                      <button type="button" className="clear-btn" onClick={() => setPlateSearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={platePriority}
                      onChange={(e) => setPlatePriority(e.target.value as any)}
                    >
                      <option value="all">All Priorities</option>
                      <option value="high">High Priority</option>
                      <option value="medium">Medium Priority</option>
                      <option value="low">Low Priority</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Table */}
              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "22%" }}>Registration Plate</th>
                      <th style={{ width: "28%" }}>Flag Reason / FIR</th>
                      <th style={{ width: "14%" }}>Priority</th>
                      <th style={{ width: "14%" }}>Added By</th>
                      <th style={{ width: "12%" }}>Expires</th>
                      <th style={{ width: "10%", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPlates.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No watchlist plates match criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedPlates.map((w) => (
                        <tr key={w.plate}>
                          <td>
                            <code style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", background: "var(--panel)", padding: "3px 8px", borderRadius: 4 }}>
                              {w.plate}
                            </code>
                          </td>
                          <td>
                            <span style={{ fontSize: 12.5 }}>{w.reason || "—"}</span>
                          </td>
                          <td>
                            <span
                              className={`kpi-sub-pill ${w.priority === "high" ? "warn-pill" : "sober-pill"}`}
                              style={{ textTransform: "capitalize", fontSize: 11 }}
                            >
                              {w.priority}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, color: "var(--muted)" }}>{w.added_by || "System"}</span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, color: "var(--muted)" }}>
                              {w.expires_at ? fmtTime(w.expires_at) : "Never"}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {canSupervisor && (
                              <button
                                type="button"
                                className="btn ghost small"
                                style={{ padding: "3px 8px", fontSize: 11.5, color: "#ef4444" }}
                                onClick={() => handleRemovePlate(w.plate)}
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {filteredPlates.length > 0 && (
                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                  <Pager
                    page={platePage}
                    pages={plateTotalPages}
                    total={filteredPlates.length}
                    onPage={setPlatePage}
                    size={platePageSize}
                    onSize={(s) => {
                      setPlatePageSize(s);
                      setPlatePage(1);
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 2: Persons of Interest
              ========================================================================= */}
          {tab === "persons" && (
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
                      value={personSearch}
                      onChange={(e) => setPersonSearch(e.target.value)}
                      placeholder="Search person by name, FIR or reason…"
                      className="search-input"
                    />
                    {personSearch && (
                      <button type="button" className="clear-btn" onClick={() => setPersonSearch("")}>×</button>
                    )}
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={personCategory}
                      onChange={(e) => setPersonCategory(e.target.value as any)}
                    >
                      <option value="all">All Categories</option>
                      <option value="wanted">Wanted</option>
                      <option value="missing">Missing Person</option>
                      <option value="suspect">Suspect</option>
                      <option value="other">Other / POI</option>
                    </select>
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={personPriority}
                      onChange={(e) => setPersonPriority(e.target.value as any)}
                    >
                      <option value="all">All Priorities</option>
                      <option value="high">High Priority</option>
                      <option value="medium">Medium Priority</option>
                      <option value="low">Low Priority</option>
                    </select>
                  </div>
                  <div className="perm-select-wrap">
                    <select
                      value={personStatus}
                      onChange={(e) => setPersonStatus(e.target.value as any)}
                    >
                      <option value="all">All Statuses</option>
                      <option value="active">Active Monitoring</option>
                      <option value="paused">Paused</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Table */}
              <div className="perm-table-container">
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th style={{ width: "8%" }}>Photo</th>
                      <th style={{ width: "20%" }}>Name / Subject</th>
                      <th style={{ width: "12%" }}>Category</th>
                      <th style={{ width: "10%" }}>Priority</th>
                      <th style={{ width: "14%" }}>Reference / FIR</th>
                      <th style={{ width: "14%" }}>Last Seen</th>
                      <th style={{ width: "8%" }}>Sightings</th>
                      <th style={{ width: "14%", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPersons.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                          No persons of interest enrolled matching criteria.
                        </td>
                      </tr>
                    ) : (
                      pagedPersons.map((p) => (
                        <tr key={p.id} style={{ opacity: p.active ? 1 : 0.65 }}>
                          <td>
                            {p.photo_urls?.[0] ? (
                              <img
                                src={withToken(p.photo_urls[0])}
                                alt={p.name}
                                style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }}
                              />
                            ) : (
                              <div style={{ width: 44, height: 44, background: "var(--panel)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "var(--muted)" }}>
                                No pic
                              </div>
                            )}
                          </td>
                          <td>
                            <strong>{p.name}</strong>
                            {!p.active && <span className="bad-chip" style={{ marginLeft: 6, fontSize: 10 }}>PAUSED</span>}
                            {p.reason && (
                              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>{p.reason}</div>
                            )}
                          </td>
                          <td>
                            <span className="tagchip" style={{ fontSize: 11, textTransform: "capitalize" }}>
                              {p.category}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`kpi-sub-pill ${p.priority === "high" ? "warn-pill" : "sober-pill"}`}
                              style={{ textTransform: "capitalize", fontSize: 11 }}
                            >
                              {p.priority}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, fontFamily: "monospace" }}>{p.reference || "—"}</span>
                          </td>
                          <td>
                            {p.last_seen_at ? (
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>{fmtTime(p.last_seen_at)}</div>
                                <div style={{ fontSize: 11, color: "var(--muted)" }}>{p.last_seen_camera || "Camera"}</div>
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: "var(--muted)" }}>—</span>
                            )}
                          </td>
                          <td>
                            <strong style={{ fontSize: 13 }}>{p.sightings}</strong>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                type="button"
                                className="btn ghost small"
                                style={{ padding: "3px 8px", fontSize: 11.5 }}
                                onClick={() => handleOpenSightings(p)}
                              >
                                Sightings
                              </button>
                              {canManageWatchlist && (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ padding: "3px 8px", fontSize: 11.5 }}
                                  onClick={() => handleTogglePersonActive(p)}
                                >
                                  {p.active ? "Pause" : "Resume"}
                                </button>
                              )}
                              {canSupervisor && (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  style={{ padding: "3px 8px", fontSize: 11.5, color: "#ef4444" }}
                                  onClick={() => handleRemovePerson(p)}
                                >
                                  Remove
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
              {filteredPersons.length > 0 && (
                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)" }}>
                  <Pager
                    page={personPage}
                    pages={personTotalPages}
                    total={filteredPersons.length}
                    onPage={setPersonPage}
                    size={personPageSize}
                    onSize={(s) => {
                      setPersonPageSize(s);
                      setPersonPage(1);
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 3: External Hotlists
              ========================================================================= */}
          {tab === "hotlists" && (
            <div className="perm-panel-card" style={{ padding: "20px 24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 14, marginBottom: 16 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                    Automated External Hotlists & Feeds
                  </h3>
                  <p style={{ margin: "4px 0 0 0", fontSize: 12.5, color: "var(--muted)" }}>
                    Central databases of stolen vehicles, national crime registries, and transport department hotlists synchronized into CCTV edge nodes.
                  </p>
                </div>
                {canManageWatchlist && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={handleSyncHotlists}
                    disabled={syncingHotlists}
                  >
                    {syncingHotlists ? "Syncing Feeds…" : "Sync All Hotlists"}
                  </button>
                )}
              </div>

              {hotlists.length === 0 ? (
                <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--muted)", background: "var(--bg2)", borderRadius: 8 }}>
                  No external hotlist sources configured in <code>config/hotlists.yaml</code>.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                  {hotlists.map((h, i) => (
                    <div
                      key={i}
                      style={{
                        background: "var(--bg2)",
                        border: "1px solid var(--line)",
                        borderRadius: 8,
                        padding: 16,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: 14 }}>{h.name}</strong>
                        <span className="tagchip" style={{ fontSize: 11, textTransform: "uppercase" }}>
                          {h.kind}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        Scheduled sync interval: <strong>every {h.interval_minutes} minutes</strong>
                      </div>
                      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: "auto" }}>
                        {h.last ? (
                          h.last.ok ? (
                            <div style={{ fontSize: 12 }}>
                              <span className="ok-chip" style={{ fontSize: 11, display: "inline-block", marginBottom: 4 }}>
                                ✓ Synchronized ({h.last.entries} active entries)
                              </span>
                              <div style={{ color: "var(--muted)", fontSize: 11 }}>
                                +{h.last.added} added, -{h.last.removed} removed at {fmtTime(h.last.at)}
                              </div>
                            </div>
                          ) : (
                            <span className="bad-chip" style={{ fontSize: 11 }}>
                              ✗ Sync failed: {h.last.error || "Network error"}
                            </span>
                          )
                        ) : (
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>Awaiting initial sync</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 4: Live Sightings Feed
              ========================================================================= */}
          {tab === "sightings" && (
            <div className="perm-panel-card" style={{ padding: "20px 24px" }}>
              <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 14, marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                  Live Camera Sightings & Face Matches
                </h3>
                <p style={{ margin: "4px 0 0 0", fontSize: 12.5, color: "var(--muted)" }}>
                  Real-time face recognition and license plate detections flagged across deployed edge cameras.
                </p>
              </div>

              {persons.filter((p) => p.sightings > 0).length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 16px", color: "var(--muted)" }}>
                  No camera sightings recorded yet for enrolled persons.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
                  {persons
                    .filter((p) => p.sightings > 0)
                    .map((p) => (
                      <div
                        key={p.id}
                        style={{
                          background: "var(--bg2)",
                          border: "1px solid var(--line)",
                          borderRadius: 8,
                          padding: 14,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          cursor: "pointer",
                        }}
                        onClick={() => handleOpenSightings(p)}
                      >
                        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                          {p.photo_urls?.[0] ? (
                            <img
                              src={withToken(p.photo_urls[0])}
                              alt=""
                              style={{ width: 50, height: 50, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }}
                            />
                          ) : (
                            <div style={{ width: 50, height: 50, background: "var(--panel)", borderRadius: 6 }} />
                          )}
                          <div>
                            <strong style={{ fontSize: 13.5 }}>{p.name}</strong>
                            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                              {p.sightings} sighting{p.sightings === 1 ? "" : "s"} total
                            </div>
                            <span className="tagchip" style={{ fontSize: 10.5, marginTop: 4 }}>
                              {p.category}
                            </span>
                          </div>
                        </div>
                        {p.last_seen_at && (
                          <div style={{ fontSize: 11.5, color: "var(--muted)", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                            Last seen at {fmtTime(p.last_seen_at)} ({p.last_seen_camera || "Camera"})
                          </div>
                        )}
                        <button
                          type="button"
                          className="btn ghost small"
                          style={{ width: "100%", fontSize: 11.5, marginTop: "auto" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenSightings(p);
                          }}
                        >
                          View Sighting Snapshots
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Modal: Add Plate to Watchlist */}
      <Modal open={showAddPlateModal} onClose={() => setShowAddPlateModal(false)}>
        <form onSubmit={handleAddPlate} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Add Vehicle to Watchlist
          </h3>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
            Flag a vehicle number plate for real-time alerting on all ANPR cameras.
          </p>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
              Registration Number Plate
            </label>
            <input
              type="text"
              value={newPlate}
              onChange={(e) => setNewPlate(e.target.value.toUpperCase())}
              placeholder="e.g. MH12AB1234 or DL01XY9999"
              required
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                background: "var(--bg2)",
                color: "var(--text)",
                fontSize: 14,
                fontFamily: "monospace",
                fontWeight: 700,
              }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
              Reason / FIR Reference
            </label>
            <input
              type="text"
              value={newPlateReason}
              onChange={(e) => setNewPlateReason(e.target.value)}
              placeholder="e.g. Stolen vehicle FIR 123/2026, Crime Branch"
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Priority Level
              </label>
              <select
                value={newPlatePriority}
                onChange={(e) => setNewPlatePriority(e.target.value as any)}
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
                <option value="high">High Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="low">Low Priority</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Valid Duration (Days)
              </label>
              <input
                type="number"
                value={newPlateDays}
                onChange={(e) => setNewPlateDays(parseInt(e.target.value) || 30)}
                min={1}
                max={365}
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
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
            <button
              type="button"
              className="btn outline"
              onClick={() => setShowAddPlateModal(false)}
              disabled={savingPlate}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={savingPlate || !newPlate.trim()}
            >
              {savingPlate ? "Adding…" : "Add to Watchlist"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal: Enrol Person of Interest */}
      <Modal open={showEnrolPersonModal} onClose={() => setShowEnrolPersonModal(false)}>
        <form onSubmit={handleEnrolPerson} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Enrol Person of Interest
          </h3>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted)", lineHeight: 1.45 }}>
            Upload clear portrait photos. High-accuracy 512-dim facial embeddings are extracted and deployed to all face-enabled CCTV cameras.
          </p>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
              Subject Full Name / Alias
            </label>
            <input
              type="text"
              value={newPersonName}
              onChange={(e) => setNewPersonName(e.target.value)}
              placeholder="e.g. Ramesh Kumar / Babloo"
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Category
              </label>
              <select
                value={newPersonCategory}
                onChange={(e) => setNewPersonCategory(e.target.value as any)}
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
                <option value="wanted">Wanted Subject</option>
                <option value="missing">Missing Person</option>
                <option value="suspect">Suspect</option>
                <option value="other">Other / POI</option>
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Priority
              </label>
              <select
                value={newPersonPriority}
                onChange={(e) => setNewPersonPriority(e.target.value as any)}
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
                <option value="high">High Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="low">Low Priority</option>
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
                Reference / FIR / Order No.
              </label>
              <input
                type="text"
                value={newPersonReference}
                onChange={(e) => setNewPersonReference(e.target.value)}
                placeholder="FIR #88/2026"
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
                Retention Days
              </label>
              <input
                type="number"
                value={newPersonDays}
                onChange={(e) => setNewPersonDays(parseInt(e.target.value) || 90)}
                min={1}
                max={3650}
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
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
              Reason for Interest
            </label>
            <input
              type="text"
              value={newPersonReason}
              onChange={(e) => setNewPersonReason(e.target.value)}
              placeholder="Why this person is tracked (e.g. robbery suspect, bail jumper)"
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
              Reference Portrait Photos (1 or more)
            </label>
            <input
              type="file"
              accept="image/*"
              multiple
              required
              onChange={(e) => {
                if (e.target.files) setNewPersonPhotos(Array.from(e.target.files));
              }}
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
            {newPersonPhotos.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 4 }}>
                {newPersonPhotos.length} photo(s) selected
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
            <button
              type="button"
              className="btn outline"
              onClick={() => setShowEnrolPersonModal(false)}
              disabled={enrollingPerson}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={enrollingPerson || !newPersonName.trim() || newPersonPhotos.length === 0}
            >
              {enrollingPerson ? "Enrolling…" : "Enrol Person"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal: Person Sightings */}
      <Modal open={!!sightingsPerson} onClose={() => setSightingsPerson(null)}>
        {sightingsPerson && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
                Camera Sightings: {sightingsPerson.name}
              </h3>
              <span className="tagchip" style={{ fontSize: 11 }}>
                {sightingsPerson.category}
              </span>
            </div>

            {loadingSightings ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                Loading sightings log…
              </div>
            ) : sightings.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                No camera sightings recorded yet for this person.
              </div>
            ) : (
              <div className="perm-table-container" style={{ maxHeight: 380, overflowY: "auto" }}>
                <table className="perm-table sober-perm-table">
                  <thead>
                    <tr>
                      <th>Time (IST)</th>
                      <th>Camera Location</th>
                      <th>Similarity Score</th>
                      <th>Snapshot</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sightings.map((s, idx) => (
                      <tr key={idx}>
                        <td>
                          <strong>{fmtTime(s.ts)}</strong>
                        </td>
                        <td>
                          <span style={{ fontSize: 12.5 }}>{s.camera_name || s.camera_id}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{s.score ?? "—"}</span>
                        </td>
                        <td>
                          {s.snapshot_url ? (
                            <img
                              src={withToken(s.snapshot_url)}
                              alt=""
                              style={{ height: 48, borderRadius: 4, border: "1px solid var(--line)" }}
                            />
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" onClick={() => setSightingsPerson(null)}>
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}
