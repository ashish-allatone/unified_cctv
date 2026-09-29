import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtTime, RANK, saveSession, session, setApiHooks, store } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { speak, speakAlert } from "../lib/speak.js";
import { tr } from "../lib/i18n.jsx";
import { NAV } from "../nav.jsx";
import { AlertToast } from "../components/common.jsx";

/* Everything a signed-in console needs: user, config, cameras, live websocket bus, navigation. */
const AppCtx = createContext(null);

export function AppProvider({ onLogout, children }) {
  const ui = useUI();
  const [user, setUser] = useState(session.user);
  const [cfg, setCfg] = useState(null);
  const [cameras, setCameras] = useState([]);          // cameras with a feed (wall, search)
  const [camById, setCamById] = useState({});          // every registered camera
  const [license, setLicense] = useState(null);
  const [providers, setProviders] = useState({});
  const [wsOk, setWsOk] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(0);
  const [nav, setNav] = useState({ view: null, intent: null });
  const [reconnect, setReconnect] = useState(0);        // bumps when the server answers again after an outage
  const [wallCount, setWallCount] = useState(0);
  const listeners = useRef({});
  const camRef = useRef({}); camRef.current = camById;
  const userRef = useRef(user); userRef.current = user;
  const wsRef = useRef(null);

  const has = useCallback((f) => !!(user && (user.features || []).includes(f)), [user]);
  const can = useCallback((role) => !!(user && RANK[user.role] >= RANK[role]), [user]);
  const camName = useCallback((id) => camRef.current[id]?.name || id, []);
  const setSession = useCallback((j) => { saveSession(j); setUser(j.user); }, []);

  const subscribe = useCallback((type, fn) => {
    (listeners.current[type] ||= new Set()).add(fn);
    return () => listeners.current[type].delete(fn);
  }, []);
  const emit = (type, msg) => listeners.current[type]?.forEach((fn) => { try { fn(msg); } catch (e) { console.error(e); } });

  const go = useCallback((view, intent = null) => {
    setNav({ view, intent: intent ? { ...intent, nonce: Date.now() } : null });
    store.set("uvp-view", view);
  }, []);
  const traceVehicle = useCallback((plate) => go("movement", { plate }), [go]);

  const loadCameras = useCallback(async () => {
    const all = await api("/api/cameras");
    setCamById(Object.fromEntries(all.map((c) => [c.id, c])));
    setCameras(all.filter((c) => !c.registry_only));   // the wall / search list cameras with a feed; the registry tab lists all
    return all;
  }, []);
  const refreshAlertBadge = useCallback(async () => {
    try { setAlertsOpen((await api("/api/alerts?open_only=true")).length); } catch (_) {}
  }, []);

  // ---------------------------------------------------------------- server-down watcher
  const watch = useRef({ timer: null, downAt: 0, lastToast: 0 });
  const connectWsRef = useRef(null);
  useEffect(() => {
    setApiHooks({
      unauthorized: onLogout,
      unreachable: () => {
        const w = watch.current;
        if (Date.now() - w.lastToast > 8000) { w.lastToast = Date.now(); ui.toast("Cannot reach the server (your network, or the API restarting). Reconnecting automatically…", "err"); }
        if (w.timer) return;
        w.downAt = Date.now(); setWsOk(false);
        w.timer = setInterval(async () => {
          try {
            const r = await fetch("/api/version", { cache: "no-store" });
            if (!r.ok) return;
            clearInterval(w.timer); w.timer = null;
            ui.toast(`Server reachable again after ${Math.round((Date.now() - w.downAt) / 1000)} s — reconnecting streams`, "ok");
            if (wsRef.current && wsRef.current.readyState !== 1) connectWsRef.current?.();
            try { await loadCameras(); } catch (_) {}
            setReconnect((n) => n + 1);
          } catch (_) { /* still down */ }
        }, 3000);
      },
    });
    return () => clearInterval(watch.current.timer);
  }, [onLogout, ui, loadCameras]);

  // ---------------------------------------------------------------- live alert channel
  useEffect(() => {
    let closed = false, retry, ping;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/alerts?token=${encodeURIComponent(session.token)}`);
      wsRef.current = ws;
      ws.onopen = () => setWsOk(true);
      ws.onclose = () => { setWsOk(false); if (!closed) retry = setTimeout(connect, 3000); };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        emit(msg.type, msg);
        if (msg.type === "alert") onAlert(msg);
        if (msg.type === "break_glass") onBreakGlass(msg);
        if (msg.type === "incident") {
          ui.toast(`${msg.label} on ${camName(msg.camera_id)}${msg.zone ? " (" + msg.zone + ")" : ""}`, "err");
          if (msg.kind === "crowd") speak(`${tr("speak.crowd", "crowd alert")}. ${camName(msg.camera_id)}.`);
        }
        if (msg.type === "camera_health") ui.toast(`Camera ${camName(msg.camera_id)}: ${msg.status}${msg.detail ? " · " + msg.detail : ""}`, msg.status === "offline" ? "err" : "warn");
      };
    };
    const onAlert = (a) => {
      try { speakAlert(a, camName(a.camera_id)); } catch (_) {}
      setAlertsOpen((n) => n + 1);
      ui.richToast(<AlertToast a={a} camName={camName(a.camera_id)} />, { onClick: () => go("movement", { plate: a.plate }) });
    };
    const onBreakGlass = (m) => {
      if (userRef.current?.role !== "admin") return;
      ui.toast(`Break-glass used by ${m.user}: ${m.reason}`, "err");
      ui.modal(<><h3>⚠ Break-glass access activated</h3><p><b>{m.user}</b> elevated their access until {fmtTime(m.until)}.</p><p>Justification: {m.reason}</p><p className="muted small">Recorded in the audit log. Review under Admin → Active grants.</p></>);
    };
    connectWsRef.current = connect;
    connect();
    ping = setInterval(() => wsRef.current?.readyState === 1 && wsRef.current.send("ping"), 25000);
    return () => { closed = true; clearTimeout(retry); clearInterval(ping); wsRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- start
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer;
    (async () => {
      const u = session.user;
      if (u.branding?.title) document.title = u.branding.title;
      if (u.branding?.accent) document.documentElement.style.setProperty("--accent", u.branding.accent);
      api("/api/license").then(setLicense).catch(() => {});
      setCfg(await api("/api/config"));
      setProviders(await fetch("/api/auth/providers").then((r) => r.json()).catch(() => ({})));
      await loadCameras();
      refreshAlertBadge();
      timer = setInterval(() => loadCameras().catch(() => {}), 15000);
      let last = store.get("uvp-view", "overview");
      const item = NAV.find((n) => n.view === last);
      if (!item || (item.feature && !(u.features || []).includes(item.feature))) last = "wall";
      setNav({ view: last, intent: null });
      setReady(true);
    })().catch((e) => { console.error(e); onLogout(); });
    return () => clearInterval(timer);
  }, [loadCameras, refreshAlertBadge, onLogout]);

  const value = useMemo(() => ({
    user, setSession, cfg, cameras, camById, camName, license, setLicense, providers, wsOk, alertsOpen, refreshAlertBadge,
    has, can, view: nav.view, intent: nav.intent, go, traceVehicle, subscribe, loadCameras, reconnect, wallCount, setWallCount, logout: onLogout, ready,
  }), [user, setSession, cfg, cameras, camById, camName, license, providers, wsOk, alertsOpen, refreshAlertBadge, has, can, nav, go, traceVehicle, subscribe, loadCameras, reconnect, wallCount, onLogout, ready]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export const useApp = () => useContext(AppCtx);
