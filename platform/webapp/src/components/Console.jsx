import { Component, useEffect, useState } from "react";
import { api, apiJson, post, session, store } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { SPEAK, setSpeakOn, speak, speakVoice } from "../lib/speak.js";
import { useApp } from "../context/AppContext.jsx";
import { ICONS, NAV } from "../nav.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import Overview from "../views/Overview.jsx";
import Wall from "../views/Wall.jsx";
import MapView from "../views/MapView.jsx";
import Registry from "../views/Registry.jsx";
import Alerts from "../views/Alerts.jsx";
import Counts from "../views/Counts.jsx";
import Search from "../views/Search.jsx";
import Movement from "../views/Movement.jsx";
import Playback from "../views/Playback.jsx";
import Cases from "../views/Cases.jsx";
import Violations from "../views/Violations.jsx";
import Watchlist from "../views/Watchlist.jsx";
import Upload from "../views/Upload.jsx";
import Sources from "../views/Sources.jsx";
import Audit from "../views/Audit.jsx";
import Admin from "../views/Admin.jsx";

const VIEWS = { overview: Overview, map: MapView, registry: Registry, alerts: Alerts, counts: Counts, search: Search, movement: Movement,
  playback: Playback, cases: Cases, violations: Violations, watchlist: Watchlist, upload: Upload, sources: Sources, audit: Audit, admin: Admin };

export default function Console({ offerMfa }) {
  const app = useApp();
  const { t } = useI18n();
  // sidebar starts as an icon rail; the toggle opens it (choice remembered per browser)
  const [rail, setRail] = useState(store.get("uvp-rail") !== "0");
  const visible = NAV.filter((n) => n.view && (!n.feature || app.has(n.feature)));

  // Alt+1..9 jumps to the n-th visible section
  useEffect(() => {
    const onKey = (e) => { if (e.altKey && /^[1-9]$/.test(e.key)) { const n = visible[+e.key - 1]; if (n) app.go(n.view); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!app.ready) return null;
  const item = NAV.find((n) => n.view === app.view);
  const View = VIEWS[app.view];
  const sub = { wall: `${app.wallCount} feeds`, overview: new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) }[app.view] || "";
  const toggleRail = () => { setRail(!rail); store.set("uvp-rail", !rail ? "1" : "0"); };
  const brandTitle = app.user.branding?.title;

  return (
    <div id="app" className={rail ? "rail" : ""}>
      <aside className="sidebar">
        <div className="brand"><img className="logo-img" src="/brand/mark.svg" alt="Allatone" width="30" height="30" />
          <span className="name">{brandTitle || <>Unified CCTV<span className="sub">by Allatone</span></>}</span></div>
        <div className="side-foot side-top">
          <button id="sidebar-toggle" className="btn ghost small" type="button" title={rail ? "Open sidebar" : "Collapse sidebar"}
            aria-label={rail ? "Open sidebar" : "Collapse sidebar"} aria-expanded={!rail} onClick={toggleRail}>
            {rail ? ICONS.menu : ICONS.collapse}<span className="lbl">Collapse</span></button>
        </div>
        <nav id="tabs" aria-label="Sections">
          {NAV.map((n, i) => {
            if (n.group) return <div key={i} className="group">{n.group}</div>;
            if (n.feature && !app.has(n.feature)) return null;
            return <button key={n.view} data-view={n.view} className={app.view === n.view ? "active" : ""} title={n.label} onClick={() => app.go(n.view)}>
              {ICONS[n.view]}<span>{t(n.key, n.label)}</span>
              {n.badge && <span id="alert-badge" className={`badge${app.alertsOpen ? "" : " hidden"}`}>{app.alertsOpen}</span>}
            </button>;
          })}
        </nav>
        <div className="side-foot">
          <a href="/m/" className="btn ghost small" target="_blank" rel="noreferrer" title="Field-officer app (installable on phones)">{ICONS.map}<span className="lbl">{t("btn.field", "Field app")}</span></a>
        </div>
      </aside>

      <Topbar title={item ? t(item.key, item.label) : ""} sub={sub} offerMfa={offerMfa} />
      <Banners />
      <div id="main-content" tabIndex={-1} />

      {/* The wall stays mounted so live tiles keep playing while other sections are open. */}
      <Wall hidden={app.view !== "wall"} />
      {View && <ViewBoundary key={`${app.view}-${app.reconnect}`}><View intent={app.intent} /></ViewBoundary>}
    </div>
  );
}

/** A section that fails to render shows its error instead of blanking the whole console. */
class ViewBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="view"><div className="panel"><h3>This section failed to load</h3>
      <p className="bad-chip" style={{ whiteSpace: "normal" }}>{String(this.state.error.message || this.state.error)}</p>
      <button className="btn small" onClick={() => this.setState({ error: null })}>Retry</button></div></main>;
  }
}

function Topbar({ title, sub, offerMfa }) {
  const app = useApp();
  const { t, lang, cycleLang } = useI18n();
  const { toast, modal } = useUI();
  const [speakOn, setSpeakState] = useState(SPEAK.on);
  const [mfa, setMfa] = useState(null);
  const u = app.user;

  const refreshMfa = async () => {
    if (u.provider === "oidc") { setMfa(null); return; }
    const st = await api("/api/auth/mfa/status").catch(() => null);
    setMfa(st || { state: u.mfa ? "enrolled" : "none", unknown: true });
  };
  useEffect(() => { refreshMfa(); if (offerMfa) setTimeout(() => modal(<MfaSetupDialog onDone={refreshMfa} />), 800); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSpeak = () => {
    const on = !speakOn; setSpeakOn(on); setSpeakState(on);
    toast(on ? t("speak.on", "Alerts will be spoken") : t("speak.off", "Alerts muted"), "ok");
    if (on) speak(t("speak.test", "Spoken alerts are on."));
    if (on && window.speechSynthesis && !speakVoice(lang) && lang !== "en") toast(`No ${lang === "hi" ? "Hindi" : "Gujarati"} voice installed in this browser / OS — alerts are spoken in English. Windows: Settings → Time & language → Speech → Add voices.`, "warn");
  };
  const mfaClick = async () => {
    if (mfa.state !== "enrolled") return modal(<MfaSetupDialog onDone={refreshMfa} />);
    if (mfa.required) return toast("Two-factor sign-in is required for your role and cannot be turned off.", "warn");
    const code = prompt("Turn off two-factor sign-in: enter the current 6-digit code from your authenticator app");
    if (!code) return;
    try { app.setSession(await post("/api/auth/mfa/disable", { code }, session.token)); toast("Two-factor sign-in turned off", "ok"); refreshMfa(); }
    catch (e) { toast(e.message, "err"); }
  };
  const showBreakGlass = app.providers.break_glass && ["supervisor", "admin"].includes(u.role) && !u.break_glass;
  const mfaLabel = !mfa ? "" : mfa.state === "enrolled" ? "2FA on" : mfa.required ? "Set up 2FA (required)" : "2FA";
  const mfaHidden = !mfa || (mfa.unknown && u.mfa);

  return (
    <header className="topbar">
      <h1 id="page-title">{title}</h1>
      <span className="crumb" id="page-sub">{sub}</span>
      <span className="spacer" />
      <div className="user">
        <span id="ws-dot" className={`dot ${app.wsOk ? "ok" : "off"}`} title="Live alert channel" />
        <span id="user-name">{`${u.username} · ${u.role}${u.mfa ? " · 2FA" : ""}${u.tenant ? " · " + u.tenant : ""}`}</span>
        <button id="break-glass" className={`btn ghost small${showBreakGlass ? "" : " hidden"}`} title="Emergency access with justification (audited)" onClick={() => modal(<BreakGlassDialog />)}>{t("btn.breakglass", "Break glass")}</button>
        <button id="mfa-setup" className={`btn ghost small${mfaHidden ? " hidden" : ""}`} onClick={mfaClick}
          title={mfa?.state === "enrolled" ? (mfa.required ? "Two-factor sign-in is required for your role" : "Two-factor sign-in is on · click to turn off") : "Enable two-factor sign-in"}>{mfaLabel}</button>
        <button id="lang-toggle" className="btn ghost small" title="Language / भाषा / ભાષા" onClick={cycleLang}>{t("lang", "हिंदी")}</button>
        <button id="speak-toggle" className="btn ghost icon" type="button" title="Speak alerts aloud" aria-label="Speak alerts aloud" aria-pressed={speakOn ? "true" : "false"} onClick={toggleSpeak}>{ICONS.speaker}</button>
        <ThemeToggle />
        <button id="logout" className="btn ghost small" onClick={app.logout}>{t("btn.signout", "Sign out")}</button>
      </div>
    </header>
  );
}

function Banners() {
  const app = useApp();
  const { t } = useI18n();
  const u = app.user, l = app.license;
  const over = l ? Object.entries(l.over_limit || {}).filter(([, v]) => v).map(([k]) => k) : [];
  const showLic = !!l && (l.mode !== "licensed" || over.length > 0);
  const endBreakGlass = async () => { app.setSession(await api("/api/auth/break-glass/end", { method: "POST" })); location.reload(); };
  return (
    <div id="banners">
      <div id="bg-banner" className={`bg-banner${u.break_glass ? "" : " hidden"}`}>{u.break_glass && <>
        <span>⚠ Break-glass access active for {u.username}: every action is audited and admins have been notified.</span><button id="bg-end" className="btn ghost small" onClick={endBreakGlass}>End now</button></>}</div>
      <div id="lic-banner" className={`lic-banner${showLic ? "" : " hidden"}`}>{showLic ? `${t("license.title", "Licence")}: ${l.status}${over.length ? " · over limit: " + over.join(", ") + " (extra cameras stay unlicensed)" : ""}` : ""}</div>
    </div>
  );
}

function MfaSetupDialog({ onDone }) {
  const app = useApp();
  const { toast, modal } = useUI();
  const [e, setE] = useState(null);
  useEffect(() => { post("/api/auth/mfa/enrol", {}, session.token).then(setE).catch((x) => toast(x.message, "err")); }, [toast]);
  const submit = async (ev) => {
    ev.preventDefault();
    try {
      const j = await post("/api/auth/mfa/confirm", { code: ev.target.code.value }, session.token);
      app.setSession(j);
      modal(<><h3>Two-factor sign-in enabled</h3><p>Backup codes (each works once):</p><pre>{j.backup_codes.join("\n")}</pre></>);
      onDone?.();
    } catch (x) { toast(x.message, "err"); }
  };
  if (!e) return <p className="muted">Loading…</p>;
  return <>
    <h3>Enable two-factor sign-in</h3><p className="muted">Scan with Google/Microsoft Authenticator, then enter the code.</p>
    <img src={e.qr} alt="QR" style={{ width: 180, height: 180, background: "#fff", borderRadius: 8 }} />
    <p className="small muted">Manual key: <code>{e.secret}</code></p>
    <form id="mfa-app-form" className="search-form" onSubmit={submit}><label>Code <input name="code" inputMode="numeric" required /></label><button className="btn primary">Activate</button></form>
  </>;
}

function BreakGlassDialog() {
  const app = useApp();
  const { toast, closeModal } = useUI();
  const submit = async (ev) => {
    ev.preventDefault();
    try { app.setSession(await apiJson("/api/auth/break-glass", "POST", { reason: ev.target.reason.value })); closeModal(); location.reload(); }
    catch (e) { toast(e.message, "err"); }
  };
  return <>
    <h3>Break-glass access</h3>
    <p className="muted">Grants all departments and playback/export for a limited time. Your justification is recorded in the tamper-evident audit log and administrators are alerted immediately.</p>
    <form id="bg-form" className="search-form" onSubmit={submit}><label style={{ flex: 1 }}>Justification <input name="reason" required minLength={10} placeholder="e.g. hit-and-run pursuit, FIR 123/2026" /></label><button className="btn danger">Activate</button></form>
  </>;
}
