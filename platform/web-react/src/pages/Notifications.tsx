import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { toast } from "../lib/toast";
import { useWsMessage } from "../lib/ws";
import Modal from "../components/Modal";
import Pager from "../components/Pager";

type N = { id: string; kind: string; title: string; body?: string; severity: "info" | "warn" | "critical"; ts: string; read: boolean; link?: string };
type Summary = { unread: number; today: number; total: number; by_kind: Record<string, number>; by_severity: Record<string, number>; per_day: { day: string; info: number; warn: number; critical: number }[]; kinds: string[] };
const SEV: Record<string, string> = { critical: "critical", warn: "warning", info: "info" };
const KIND_LABEL: Record<string, string> = { alert: "Watchlist / challan alerts", incident: "Analytics incidents", camera: "Camera offline / online", device: "Devices connected / removed", detection: "AI detection switch", security: "Security (accounts, roles, lock-outs)", archival: "Archival runs", report: "Scheduled reports", geofence: "Geofence events", system: "System" };

export default function Notifications() {
  const nav = useNavigate();
  const [sm, setSm] = useState<Summary | null>(null);
  const [items, setItems] = useState<N[]>([]); const [page, setPage] = useState(1); const [pages, setPages] = useState(1); const [total, setTotal] = useState(0); const [size, setSize] = useState(50);
  const [q, setQ] = useState(""); const [kind, setKind] = useState(""); const [sev, setSev] = useState(""); const [unread, setUnread] = useState(false);
  const [prefs, setPrefs] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api<Summary>("/api/notifications/summary?days=7"),
        api(`/api/notifications?page=${page}&page_size=${size}&kind=${encodeURIComponent(kind)}&severity=${sev}&unread=${unread ? 1 : 0}&q=${encodeURIComponent(q.trim())}`)]);
      setSm(s); setItems(r.items); setPages(r.pages); setTotal(r.total);
    } catch (e: any) { toast(e.message, "err"); }
  }, [page, size, kind, sev, unread, q]);
  useEffect(() => { const t = setTimeout(load, q ? 350 : 0); return () => clearTimeout(t); }, [load, q]);
  useWsMessage("inbox", useCallback(() => load(), [load]));

  const open = async (n: N) => {
    if (!n.read) { try { await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }); } catch { /* */ } }
    if (n.link) nav(`/${n.link}`); else load();
  };
  const toggleRead = async (n: N) => { try { await api(n.read ? "/api/notifications/unread" : "/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }); load(); } catch (e: any) { toast(e.message, "err"); } };
  const readAll = async () => { try { await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }); toast("All notifications marked read", "ok"); load(); } catch (e: any) { toast(e.message, "err"); } };

  const kpi = (l: string, v: number | string, cls = "") => <div className={`kpi ${cls}`} key={l}><div className="v">{v}</div><div className="l">{l}</div></div>;
  const max = Math.max(1, ...(sm?.per_day || []).map((d) => d.info + d.warn + d.critical));

  return (
    <main className="view">
      <div className="view-head"><div><h2>Notifications</h2><p>Alerts, incidents, camera health, devices, detection, security and archival events — scoped to your departments and cameras.</p></div>
        <div className="quick"><button className="btn small ghost" onClick={() => setPrefs(true)}>Preferences</button><button className="btn small" onClick={readAll}>Mark all read</button></div></div>
      {sm && <>
        <div className="kpis">{[kpi("Unread", sm.unread, sm.unread ? "warn" : "ok"), kpi("Today", sm.today), kpi("Last 7 days", sm.total), kpi("Critical (7 d)", sm.by_severity.critical || 0, sm.by_severity.critical ? "bad" : "ok"),
          kpi("Warnings (7 d)", sm.by_severity.warn || 0, sm.by_severity.warn ? "warn" : ""), kpi("Alerts (7 d)", sm.by_kind.alert || 0), kpi("Camera events (7 d)", sm.by_kind.camera || 0), kpi("Security (7 d)", sm.by_kind.security || 0)]}</div>
        <div className="cards">
          <div className="card"><b>Last 7 days</b>
            <div className="chart"><div className="bars">{sm.per_day.map((d) => { const tot = d.info + d.warn + d.critical; return (
              <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", position: "relative", minWidth: 4 }} title={`${d.day}: ${tot}`}>
                {tot > 0 && <span className="bar-lbl">{tot}</span>}
                {d.critical > 0 && <div className="bar b3" style={{ height: `${Math.max(2, (d.critical / max) * 100)}%`, position: "static", width: "100%" }} />}
                {d.warn > 0 && <div className="bar b2" style={{ height: `${Math.max(2, (d.warn / max) * 100)}%`, position: "static", width: "100%" }} />}
                {d.info > 0 && <div className="bar" style={{ height: `${Math.max(2, (d.info / max) * 100)}%`, position: "static", width: "100%" }} />}
              </div>); })}</div>
              <div className="bars-x">{sm.per_day.map((d) => <span key={d.day}>{d.day.slice(5)}</span>)}</div>
              <div className="legend"><span><i /> info</span><span><i className="b2" /> warning</span><span><i className="b3" /> critical</span></div></div></div>
          <div className="card"><b>By kind</b><div className="kv">{Object.entries(sm.by_kind).sort((a, b) => b[1] - a[1]).flatMap(([k, v]) => [<span key={k}>{k}</span>, <span key={k + "v"}>{v}</span>])}{!Object.keys(sm.by_kind).length && <span className="muted">none yet</span>}</div></div>
          <div className="card"><b>By severity</b><div className="kv">{["critical", "warn", "info"].flatMap((k) => [<span key={k}>{SEV[k]}</span>, <span key={k + "v"} className={k === "critical" && sm.by_severity[k] ? "bad-chip" : ""}>{sm.by_severity[k] || 0}</span>])}</div></div>
        </div>
      </>}
      <div className="panel">
        <form className="search-form" onSubmit={(e) => e.preventDefault()}>
          <label>Search <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="title, text, camera, plate…" /></label>
          <label>Kind <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}><option value="">all</option>{(sm?.kinds || []).map((k) => <option key={k}>{k}</option>)}</select></label>
          <label>Severity <select value={sev} onChange={(e) => { setSev(e.target.value); setPage(1); }}><option value="">all</option><option value="critical">critical</option><option value="warn">warning</option><option value="info">info</option></select></label>
          <label className="check"><input type="checkbox" checked={unread} onChange={(e) => { setUnread(e.target.checked); setPage(1); }} /> unread only</label>
        </form>
        <div className="panel-head"><h3>Notifications</h3><span className="muted small">{total} notification{total === 1 ? "" : "s"}</span></div>
        <div className="notif-list">
          {items.length ? items.map((n) => (
            <div key={n.id} className={`notif-item ${n.read ? "" : "unread"}`} role="button" tabIndex={0} onClick={() => open(n)}>
              <span className={`sev ${n.severity}`} title={SEV[n.severity] || n.severity} />
              <div><div className="t"><span className="kind">{n.kind}</span>{n.title}</div>{n.body && <div className="b">{n.body}</div>}</div>
              <div className="when">{ago(n.ts)}<br /><button className="btn ghost small" onClick={(e) => { e.stopPropagation(); toggleRead(n); }}>{n.read ? "Mark unread" : "Mark read"}</button></div>
            </div>
          )) : <div className="muted small" style={{ padding: 12 }}>Nothing here. Alerts, camera health, device, detection, security and archival events appear as they happen.</div>}
        </div>
        <Pager page={page} pages={pages} total={total} onPage={setPage} size={size} onSize={(n) => { setSize(n); setPage(1); }} />
      </div>
      {prefs && <PrefsDialog onClose={() => setPrefs(false)} />}
    </main>
  );
}

function PrefsDialog({ onClose }: { onClose: () => void }) {
  const [r, setR] = useState<any>(null);
  useEffect(() => { api("/api/notifications/preferences").then(setR).catch((e) => { toast(e.message, "err"); onClose(); }); }, [onClose]);
  if (!r) return null;
  const p = r.preferences;
  const set = (k: string, v: any) => setR({ ...r, preferences: { ...p, [k]: v } });
  const save = async (e: React.FormEvent) => { e.preventDefault(); try { await api("/api/notifications/preferences", { method: "PUT", body: JSON.stringify(p) }); toast("Preferences saved", "ok"); onClose(); } catch (err: any) { toast(err.message, "err"); } };
  return (
    <Modal open onClose={onClose}>
      <h3>Notification preferences</h3><p className="muted small">What reaches you — in the bell, the menu badge, as pop-ups and spoken aloud. Permissions still apply: you only ever see events from your departments and cameras.</p>
      <form className="search-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} onSubmit={save}>
        <div style={{ gridColumn: "1/3" }}><b className="small">Notify me about</b><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 6 }}>
          {r.kinds.map((k: string) => <label key={k} className="check"><input type="checkbox" checked={p.kinds.includes(k)} onChange={(e) => set("kinds", e.target.checked ? [...p.kinds, k] : p.kinds.filter((x: string) => x !== k))} /> {KIND_LABEL[k] || k}</label>)}</div></div>
        <label>Minimum severity <select value={p.min_severity} onChange={(e) => set("min_severity", e.target.value)}>{r.severities.map((x: string) => <option key={x} value={x}>{x === "warn" ? "warning" : x}</option>)}</select></label>
        <label>Speak aloud from <select value={p.speak_min_severity} onChange={(e) => set("speak_min_severity", e.target.value)}>{r.severities.map((x: string) => <option key={x} value={x}>{x === "warn" ? "warning" : x}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={p.toast} onChange={(e) => set("toast", e.target.checked)} /> pop-up toasts</label>
        <label className="check"><input type="checkbox" checked={p.speak} onChange={(e) => set("speak", e.target.checked)} /> speak aloud</label>
        <label className="check"><input type="checkbox" checked={p.badge} onChange={(e) => set("badge", e.target.checked)} /> badge on the menu / bell</label>
        <div style={{ gridColumn: "1/3", display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn ghost" type="button" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}
