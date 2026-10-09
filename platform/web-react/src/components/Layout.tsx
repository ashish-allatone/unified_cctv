import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ALL_ITEMS, NAV } from "../nav";
import { useAuth } from "../lib/auth";
import { useI18n, NEXT_LANG, LANG_LABEL } from "../lib/i18n";
import { useWs, useWsMessage } from "../lib/ws";
import { api } from "../lib/api";
import { getTheme, toggleTheme } from "../lib/theme";
import { ago } from "../lib/format";
import { toast } from "../lib/toast";
import { ADMIN_SECTIONS } from "../pages/admin/AdminLayout";
import { SOURCES_SECTIONS } from "../pages/Sources";
import { UPLOAD_SECTIONS } from "../pages/UploadRecognise";
import { WATCHLIST_SECTIONS } from "../pages/Watchlist";
import { VIOLATIONS_SECTIONS } from "../pages/Violations";
import { CASES_SECTIONS } from "../pages/Cases";
import { PLAYBACK_SECTIONS } from "../pages/Playback";
import { MULTICAM_SECTIONS } from "../pages/Multicam";
import { MOVEMENT_SECTIONS } from "../pages/Movement";
import { SEARCH_SECTIONS } from "../pages/Search";
import { ALERTS_SECTIONS } from "../pages/Alerts";
import { COUNTS_SECTIONS } from "../pages/Counts";

const Sun = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
const Moon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>;
const Burger = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
const BellIco = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;

type Notif = { id: string; kind: string; title: string; body?: string; severity: string; ts: string; read: boolean; link?: string };

export default function Layout() {
  const { user, has, signOut } = useAuth();
  const { t, lang, setLang } = useI18n();
  const { connected } = useWs();
  const nav = useNavigate();
  const loc = useLocation();
  const [rail, setRail] = useState(() => { try { return localStorage.getItem("uvp-rail") === "1"; } catch { return false; } });
  const [theme, setThemeState] = useState(getTheme());
  const [unread, setUnread] = useState(0);
  const [bellOpen, setBellOpen] = useState(false);
  const [latest, setLatest] = useState<Notif[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(0);
  const [adminOpen, setAdminOpen] = useState(() => loc.pathname.startsWith("/admin"));
  const [sourcesOpen, setSourcesOpen] = useState(() => loc.pathname.startsWith("/sources"));
  const [uploadOpen, setUploadOpen] = useState(() => loc.pathname.startsWith("/upload"));
  const [watchlistOpen, setWatchlistOpen] = useState(() => loc.pathname.startsWith("/watchlist"));
  const [violationsOpen, setViolationsOpen] = useState(() => loc.pathname.startsWith("/violations"));
  const [casesOpen, setCasesOpen] = useState(() => loc.pathname.startsWith("/cases"));
  const [playbackOpen, setPlaybackOpen] = useState(() => loc.pathname.startsWith("/playback"));
  const [multicamOpen, setMulticamOpen] = useState(() => loc.pathname.startsWith("/multicam"));
  const [movementOpen, setMovementOpen] = useState(() => loc.pathname.startsWith("/movement"));
  const [searchOpen, setSearchOpen] = useState(() => loc.pathname.startsWith("/search"));
  const [alertsNavOpen, setAlertsNavOpen] = useState(() => loc.pathname.startsWith("/alerts"));
  const [countsNavOpen, setCountsNavOpen] = useState(() => loc.pathname.startsWith("/counts"));

  useEffect(() => {
    if (loc.pathname.startsWith("/admin")) {
      setAdminOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/sources")) {
      setSourcesOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/upload")) {
      setUploadOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/watchlist")) {
      setWatchlistOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/violations")) {
      setViolationsOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/cases")) {
      setCasesOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/playback")) {
      setPlaybackOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/multicam")) {
      setMulticamOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/movement")) {
      setMovementOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/search")) {
      setSearchOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/alerts")) {
      setAlertsNavOpen(true);
    }
  }, [loc.pathname]);

  useEffect(() => {
    if (loc.pathname.startsWith("/counts")) {
      setCountsNavOpen(true);
    }
  }, [loc.pathname]);

  const refreshInbox = useCallback(async () => {
    try { const r = await api("/api/notifications/unread"); setUnread(r.unread ?? r.count ?? 0); } catch { /* */ }
    try { const a = await api("/api/alerts?open=1&limit=100"); setAlertsOpen(Array.isArray(a) ? a.length : (a.count ?? 0)); } catch { /* */ }
  }, []);
  useEffect(() => { refreshInbox(); const i = setInterval(refreshInbox, 30000); return () => clearInterval(i); }, [refreshInbox]);
  useWsMessage("inbox", useCallback((m) => { setUnread((n) => n + 1); if (m.severity === "critical" && m.kind !== "alert") toast(m.title, "err"); }, []));
  useWsMessage("alert", useCallback(() => setAlertsOpen((n) => n + 1), []));

  const openBell = async () => {
    if (!bellOpen) { try { const r = await api("/api/notifications?page=1&page_size=8"); setLatest(r.items); } catch { /* */ } }
    setBellOpen(!bellOpen);
  };
  const openNotif = async (n: Notif) => {
    if (!n.read) { try { const r = await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }); setUnread(r.unread ?? Math.max(0, unread - 1)); } catch { /* */ } }
    setBellOpen(false);
    nav(n.link ? `/${n.link}` : "/notifications");
  };
  const markAll = async () => { try { await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }); setUnread(0); setLatest((xs) => xs.map((x) => ({ ...x, read: true }))); } catch (e: any) { toast(e.message, "err"); } };

  const current = ALL_ITEMS.find((i) => loc.pathname.startsWith(`/${i.view}`));
  const toggleRail = () => { setRail((r) => { try { localStorage.setItem("uvp-rail", r ? "0" : "1"); } catch { /* */ } return !r; }); };
  const visible = (f?: string) => !f || has(f);

  return (
    <div id="app" className={rail ? "rail" : ""}>
      <aside className="sidebar">
        <div className="brand"><img className="logo-img" src="/legacy/brand/mark.svg" alt="Allatone" width={30} height={30} /><span className="name">Unified CCTV<span className="sub">by Allatone</span></span></div>
        <nav id="tabs" aria-label="Sections">
          {NAV.map((g) => (
            <div key={g.label}>
              <div className="group">{t(g.i18n, g.label)}</div>
              {g.items.filter((i) => visible(i.feature)).map((i) => {
                if (i.view === "admin") {
                  const isAdminActive = loc.pathname.startsWith("/admin");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/admin"
                        className={`admin-nav-main-link ${isAdminActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setAdminOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${adminOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setAdminOpen(!adminOpen);
                          }}
                          title={adminOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {adminOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {adminOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Admin sub menu">
                          {ADMIN_SECTIONS.map((cat) => {
                            const isCatActive =
                              isAdminActive &&
                              cat.items.some(
                                (it) =>
                                  loc.pathname === `/admin/${it.id}` ||
                                  (loc.pathname === `/admin` && cat.id === "access")
                              );
                            return (
                              <NavLink
                                key={cat.id}
                                to={`/admin/${cat.items[0].id}`}
                                className={`admin-subcat-link ${isCatActive ? "active" : ""}`}
                                title={cat.desc}
                              >
                                {cat.iconName === "access" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                  </svg>
                                )}
                                {cat.iconName === "data" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <ellipse cx="12" cy="5" rx="9" ry="3" />
                                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                                  </svg>
                                )}
                                {cat.iconName === "integrations" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="2" y="2" width="20" height="8" rx="2" />
                                    <rect x="2" y="14" width="20" height="8" rx="2" />
                                  </svg>
                                )}
                                {cat.iconName === "overview" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                    <polyline points="22 4 12 14.01 9 11.01" />
                                  </svg>
                                )}
                                <span className="subcat-title">{cat.group}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "sources") {
                  const isSourcesActive = loc.pathname.startsWith("/sources");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/sources"
                        className={`admin-nav-main-link ${isSourcesActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setSourcesOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${sourcesOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSourcesOpen(!sourcesOpen);
                          }}
                          title={sourcesOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {sourcesOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {sourcesOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Sources sub menu">
                          {SOURCES_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/sources/${sub.id}` ||
                              (sub.id === "gateways" && (loc.pathname === "/sources" || loc.pathname === "/sources/gateways" || loc.pathname === "/sources/sources"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/sources/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "gateways" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                                    <line x1="6" y1="6" x2="6.01" y2="6" />
                                    <line x1="6" y1="18" x2="6.01" y2="18" />
                                  </svg>
                                )}
                                {sub.iconName === "devices" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="4" width="18" height="12" rx="2" />
                                    <line x1="2" y1="20" x2="22" y2="20" />
                                    <line x1="12" y1="16" x2="12" y2="20" />
                                  </svg>
                                )}
                                {sub.iconName === "capacity" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                                  </svg>
                                )}
                                {sub.iconName === "sla" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                    <polyline points="22 4 12 14.01 9 11.01" />
                                  </svg>
                                )}
                                {sub.iconName === "archive" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <polyline points="21 8 21 21 3 21 3 8" />
                                    <rect x="1" y="3" width="22" height="5" />
                                    <line x1="10" y1="12" x2="14" y2="12" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "upload") {
                  const isUploadActive = loc.pathname.startsWith("/upload");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/upload"
                        className={`admin-nav-main-link ${isUploadActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setUploadOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${uploadOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setUploadOpen(!uploadOpen);
                          }}
                          title={uploadOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {uploadOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {uploadOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Upload sub menu">
                          {UPLOAD_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/upload/${sub.id}` ||
                              (sub.id === "upload" && (loc.pathname === "/upload" || loc.pathname === "/upload/new"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/upload/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "upload" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="17 8 12 3 7 8" />
                                    <line x1="12" y1="3" x2="12" y2="15" />
                                  </svg>
                                )}
                                {sub.iconName === "history" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "persons" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                  </svg>
                                )}
                                {sub.iconName === "plates" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="2" y="5" width="20" height="14" rx="2" />
                                    <line x1="2" y1="10" x2="22" y2="10" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "watchlist") {
                  const isWatchlistActive = loc.pathname.startsWith("/watchlist");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/watchlist"
                        className={`admin-nav-main-link ${isWatchlistActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setWatchlistOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${watchlistOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setWatchlistOpen(!watchlistOpen);
                          }}
                          title={watchlistOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {watchlistOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {watchlistOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Watchlist sub menu">
                          {WATCHLIST_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/watchlist/${sub.id}` ||
                              (sub.id === "plates" && (loc.pathname === "/watchlist" || loc.pathname === "/watchlist/plates"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/watchlist/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "plates" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="2" y="5" width="20" height="14" rx="2" />
                                    <line x1="2" y1="10" x2="22" y2="10" />
                                  </svg>
                                )}
                                {sub.iconName === "persons" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                  </svg>
                                )}
                                {sub.iconName === "hotlists" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                  </svg>
                                )}
                                {sub.iconName === "sightings" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 14 14" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "violations") {
                  const isViolationsActive = loc.pathname.startsWith("/violations");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/violations"
                        className={`admin-nav-main-link ${isViolationsActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setViolationsOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${violationsOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setViolationsOpen(!violationsOpen);
                          }}
                          title={violationsOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {violationsOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {violationsOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Violations sub menu">
                          {VIOLATIONS_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/violations/${sub.id}` ||
                              (sub.id === "challans" && (loc.pathname === "/violations" || loc.pathname === "/violations/challans"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/violations/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "challans" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="4" width="18" height="16" rx="2" />
                                    <line x1="7" y1="8" x2="17" y2="8" />
                                    <line x1="7" y1="12" x2="13" y2="12" />
                                    <line x1="7" y1="16" x2="11" y2="16" />
                                  </svg>
                                )}
                                {sub.iconName === "incidents" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                  </svg>
                                )}
                                {sub.iconName === "review" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                    <line x1="11" y1="8" x2="11" y2="14" />
                                    <line x1="8" y1="11" x2="14" y2="11" />
                                  </svg>
                                )}
                                {sub.iconName === "accuracy" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                                  </svg>
                                )}
                                {sub.iconName === "traffic" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="2" y="5" width="20" height="14" rx="2" />
                                    <line x1="2" y1="10" x2="22" y2="10" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "cases") {
                  const isCasesActive = loc.pathname.startsWith("/cases");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/cases"
                        className={`admin-nav-main-link ${isCasesActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setCasesOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${casesOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCasesOpen(!casesOpen);
                          }}
                          title={casesOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {casesOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {casesOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Cases sub menu">
                          {CASES_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/cases/${sub.id}` ||
                              (sub.id === "active" && (loc.pathname === "/cases" || loc.pathname === "/cases/active"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/cases/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "active" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "mine" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                  </svg>
                                )}
                                {sub.iconName === "closed" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                    <polyline points="22 4 12 14.01 9 11.01" />
                                  </svg>
                                )}
                                {sub.iconName === "custody" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "playback") {
                  const isPlaybackActive = loc.pathname.startsWith("/playback");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/playback"
                        className={`admin-nav-main-link ${isPlaybackActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setPlaybackOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${playbackOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPlaybackOpen(!playbackOpen);
                          }}
                          title={playbackOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {playbackOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {playbackOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Playback sub menu">
                          {PLAYBACK_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/playback/${sub.id}` ||
                              (sub.id === "recordings" && (loc.pathname === "/playback" || loc.pathname === "/playback/recordings"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/playback/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "recordings" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "bookmarks" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                                  </svg>
                                )}
                                {sub.iconName === "create-bookmark" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "multicam") {
                  const isMulticamActive = loc.pathname.startsWith("/multicam");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/multicam"
                        className={`admin-nav-main-link ${isMulticamActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setMulticamOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${multicamOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setMulticamOpen(!multicamOpen);
                          }}
                          title={multicamOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {multicamOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {multicamOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Multi-camera sub menu">
                          {MULTICAM_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/multicam/${sub.id}` ||
                              (sub.id === "cross-camera" && (loc.pathname === "/multicam" || loc.pathname === "/multicam/cross-camera"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/multicam/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "cross-camera" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="5" width="8" height="6" rx="1.5" />
                                    <rect x="13" y="5" width="8" height="6" rx="1.5" />
                                    <rect x="3" y="14" width="8" height="6" rx="1.5" />
                                    <path d="M17 14v6M14 17h6" />
                                  </svg>
                                )}
                                {sub.iconName === "route-trace" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M4 18c4-1 5-6 9-7s5 4 7 3" />
                                    <circle cx="4" cy="18" r="2" />
                                    <circle cx="20" cy="14" r="2" />
                                  </svg>
                                )}
                                {sub.iconName === "corridors" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "matrix" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="3" width="7" height="7" />
                                    <rect x="14" y="3" width="7" height="7" />
                                    <rect x="14" y="14" width="7" height="7" />
                                    <rect x="3" y="14" width="7" height="7" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "movement") {
                  const isMovementActive = loc.pathname.startsWith("/movement");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/movement"
                        className={`admin-nav-main-link ${isMovementActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setMovementOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${movementOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setMovementOpen(!movementOpen);
                          }}
                          title={movementOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {movementOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {movementOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Vehicle movement sub menu">
                          {MOVEMENT_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/movement/${sub.id}` ||
                              (sub.id === "trace" && (loc.pathname === "/movement" || loc.pathname === "/movement/trace"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/movement/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "trace" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M4 18c4-1 5-6 9-7s5 4 7 3" />
                                    <circle cx="4" cy="18" r="2" />
                                    <circle cx="20" cy="14" r="2" />
                                  </svg>
                                )}
                                {sub.iconName === "stitch" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M23 7l-7 5 7 5V7z" />
                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                  </svg>
                                )}
                                {sub.iconName === "trips" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "patterns" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="3" width="7" height="7" />
                                    <rect x="14" y="3" width="7" height="7" />
                                    <rect x="14" y="14" width="7" height="7" />
                                    <rect x="3" y="14" width="7" height="7" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "search") {
                  const isSearchActive = loc.pathname.startsWith("/search");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/search"
                        className={`admin-nav-main-link ${isSearchActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setSearchOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${searchOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSearchOpen(!searchOpen);
                          }}
                          title={searchOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {searchOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {searchOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Search sub menu">
                          {SEARCH_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/search/${sub.id}` ||
                              (sub.id === "events" && (loc.pathname === "/search" || loc.pathname === "/search/events"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/search/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "events" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                  </svg>
                                )}
                                {sub.iconName === "lookup" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <rect x="3" y="4" width="18" height="16" rx="2" />
                                    <line x1="7" y1="8" x2="17" y2="8" />
                                    <line x1="7" y1="12" x2="13" y2="12" />
                                  </svg>
                                )}
                                {sub.iconName === "review" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M9 11l3 3L22 4" />
                                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                                  </svg>
                                )}
                                {sub.iconName === "analytics" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <line x1="18" y1="20" x2="18" y2="10" />
                                    <line x1="12" y1="20" x2="12" y2="4" />
                                    <line x1="6" y1="20" x2="6" y2="14" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "alerts") {
                  const isAlertsActive = loc.pathname.startsWith("/alerts");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/alerts"
                        className={`admin-nav-main-link ${isAlertsActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setAlertsNavOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        {alertsOpen > 0 && (
                          <span className="badge" style={{ marginRight: 6 }}>
                            {alertsOpen > 99 ? "99+" : alertsOpen}
                          </span>
                        )}
                        <span
                          className={`admin-toggle-badge ${alertsNavOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setAlertsNavOpen(!alertsNavOpen);
                          }}
                          title={alertsNavOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {alertsNavOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {alertsNavOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Alerts sub menu">
                          {ALERTS_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/alerts/${sub.id}` ||
                              (sub.id === "live" && (loc.pathname === "/alerts" || loc.pathname === "/alerts/live" || loc.pathname === "/alerts/open"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/alerts/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "live" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="12" y1="8" x2="12" y2="12" />
                                    <line x1="12" y1="16" x2="12.01" y2="16" />
                                  </svg>
                                )}
                                {sub.iconName === "history" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                  </svg>
                                )}
                                {sub.iconName === "incidents" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                                    <line x1="12" y1="9" x2="12" y2="13" />
                                    <line x1="12" y1="17" x2="12.01" y2="17" />
                                  </svg>
                                )}
                                {sub.iconName === "dispatch" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                if (i.view === "counts") {
                  const isCountsActive = loc.pathname.startsWith("/counts");
                  return (
                    <div key={i.view} className="admin-nav-group">
                      <NavLink
                        to="/counts"
                        className={`admin-nav-main-link ${isCountsActive ? "active" : ""}`}
                        title={i.label}
                        onClick={() => setCountsNavOpen(true)}
                      >
                        {i.icon}
                        <span className="nav-main-text">{t(i.i18n, i.label)}</span>
                        <span
                          className={`admin-toggle-badge ${countsNavOpen ? "open" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCountsNavOpen(!countsNavOpen);
                          }}
                          title={countsNavOpen ? "Collapse sub menu" : "Expand sub menu"}
                          role="button"
                          tabIndex={0}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="toggle-svg-ico">
                            {countsNavOpen ? (
                              <line x1="5" y1="12" x2="19" y2="12" />
                            ) : (
                              <>
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </>
                            )}
                          </svg>
                        </span>
                      </NavLink>
                      {countsNavOpen && !rail && (
                        <div className="admin-side-submenu" role="menu" aria-label="Counts sub menu">
                          {COUNTS_SECTIONS.map((sub) => {
                            const isSubActive =
                              loc.pathname === `/counts/${sub.id}` ||
                              (sub.id === "live" && (loc.pathname === "/counts" || loc.pathname === "/counts/live"));
                            return (
                              <NavLink
                                key={sub.id}
                                to={`/counts/${sub.id}`}
                                className={`admin-subcat-link ${isSubActive ? "active" : ""}`}
                                title={sub.desc}
                              >
                                {sub.iconName === "live" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <circle cx="12" cy="12" r="10" />
                                    <circle cx="12" cy="12" r="3" />
                                    <line x1="12" y1="2" x2="12" y2="5" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                  </svg>
                                )}
                                {sub.iconName === "crowd" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                    <circle cx="9" cy="7" r="4" />
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                  </svg>
                                )}
                                {sub.iconName === "traffic" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <polyline points="17 1 21 5 17 9" />
                                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                                    <polyline points="7 23 3 19 7 15" />
                                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                                  </svg>
                                )}
                                {sub.iconName === "trends" && (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="admin-subcat-ico">
                                    <line x1="18" y1="20" x2="18" y2="10" />
                                    <line x1="12" y1="20" x2="12" y2="4" />
                                    <line x1="6" y1="20" x2="6" y2="14" />
                                  </svg>
                                )}
                                <span className="subcat-title">{sub.label}</span>
                              </NavLink>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <NavLink
                    key={i.view}
                    to={`/${i.view}`}
                    className={({ isActive }) => (isActive ? "active" : "")}
                    title={i.label}
                    style={{ display: "flex" }}
                  >
                    {i.icon}
                    <span>{t(i.i18n, i.label)}</span>
                    {i.view === "alerts" && alertsOpen > 0 && <span className="badge">{alertsOpen}</span>}
                    {i.view === "notifications" && unread > 0 && (
                      <span className="badge">{unread > 99 ? "99+" : unread}</span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a href="/m/" className="btn ghost small" target="_blank" title="Field-officer app"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11z" /><circle cx="12" cy="10" r="2.2" /></svg><span className="lbl">Field app</span></a>
        </div>
      </aside>

      <header className="topbar">
        <button className="btn ghost icon" onClick={toggleRail} title="Show / hide the menu" aria-label="Show or hide the menu"><Burger /></button>
        <h1>{current ? t(current.i18n, current.label) : "Unified CCTV"}</h1>
        <span className="spacer" />
        <span className={`dot ${connected ? "ok" : "off"}`} title="Live alert channel" />
        <span>{user?.username} · {user?.role}{user?.tenant ? ` · ${user.tenant}` : ""}</span>
        <div className="bell-wrap">
          <button className="btn ghost icon" onClick={openBell} title="Notifications" aria-haspopup="true" aria-expanded={bellOpen}><BellIco />{unread > 0 && <span className="badge bell-count">{unread > 99 ? "99+" : unread}</span>}</button>
          {bellOpen && (
            <div className="bell-panel" role="menu">
              <div className="bell-head"><b>Notifications</b><span><button className="btn ghost small" onClick={markAll}>Mark all read</button> <button className="btn ghost small" onClick={() => { setBellOpen(false); nav("/notifications"); }}>Open all</button></span></div>
              <div className="bell-list">
                {latest.length ? latest.map((n) => (
                  <div key={n.id} className={`notif-item ${n.read ? "" : "unread"}`} role="menuitem" tabIndex={0} onClick={() => openNotif(n)}>
                    <span className={`sev ${n.severity}`} />
                    <div><div className="t"><span className="kind">{n.kind}</span>{n.title}</div>{n.body && <div className="b">{n.body.slice(0, 90)}{n.body.length > 90 ? "…" : ""}</div>}</div>
                    <div className="when">{ago(n.ts)}</div>
                  </div>
                )) : <div className="muted small" style={{ padding: 12 }}>Nothing yet.</div>}
              </div>
            </div>
          )}
        </div>
        <button className="btn ghost small" onClick={() => setLang(NEXT_LANG[lang])} title="Language / भाषा / ભાષા">{LANG_LABEL[lang]}</button>
        <button className="btn ghost icon" onClick={() => setThemeState(toggleTheme())} title="Switch theme">{theme === "dark" ? <Sun /> : <Moon />}</button>
        <button className="btn ghost small" onClick={signOut}>{t("btn.signout", "Sign out")}</button>
      </header>
      <div id="banners" />
      <Outlet />
    </div>
  );
}
