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
              {g.items.filter((i) => visible(i.feature)).map((i) => (
                <NavLink key={i.view} to={`/${i.view}`} className={({ isActive }) => (isActive ? "active" : "")} title={i.label} style={{ display: "flex" }}>
                  {i.icon}<span>{t(i.i18n, i.label)}</span>
                  {i.view === "alerts" && alertsOpen > 0 && <span className="badge">{alertsOpen}</span>}
                  {i.view === "notifications" && unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a href="/m/" className="btn ghost small" target="_blank" title="Field-officer app"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11z" /><circle cx="12" cy="10" r="2.2" /></svg><span className="lbl">Field app</span></a>
          <button className="btn ghost small" onClick={toggleRail} title="Collapse sidebar"><Burger /><span className="lbl">Collapse</span></button>
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
