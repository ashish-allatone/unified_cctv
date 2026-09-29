import { useEffect, useState } from "react";
import { api, fmtTime, withTok } from "../lib/api.js";
import { useApp } from "../context/AppContext.jsx";
import { Kpi, Plate, RateChart, useLoad } from "../components/common.jsx";

export default function Overview() {
  const app = useApp();
  const [data] = useLoad(async () => {
    const [st, lic, sources] = await Promise.all([api("/api/stats?hours=24"), app.license || api("/api/license"), app.has("sources") ? api("/api/sources").catch(() => []) : []]);
    if (!app.license) app.setLicense(lic);
    const recent = await api("/api/events?limit=8").then((r) => r.events).catch(() => []);
    return { st, lic, sources, recent };
  });
  const counts = useLiveCounts();

  const byDept = {};
  app.cameras.forEach((c) => { const d = byDept[c.department] ||= { total: 0, online: 0, anpr: 0 }; d.total++; if (["online", "live"].includes(c.status)) d.online++; if (c.anpr_enabled) d.anpr++; });

  return (
    <main id="view-overview" className="view">
      <div className="view-head"><div><h2>Overview</h2><p>Live state of the platform across all departments.</p></div>
        <div className="quick">
          <button className="btn small" onClick={() => app.go("wall")}>Open video wall</button>
          {app.has("search") && <button className="btn small" onClick={() => app.go("search")}>Search plates</button>}
          <button className="btn small" onClick={() => app.go("alerts")}>Alerts</button>
        </div></div>
      <div className="kpis" id="ov-kpis">{data && <Kpis st={data.st} />}</div>
      <div className="ov-grid">
        <div className="panel">
          <div className="panel-head"><h3>ANPR reads per minute (last hour, IST)</h3><span className="muted small">{app.cfg ? `search backend: ${app.cfg.search_backend} · bus: ${app.cfg.bus}` : ""}</span></div>
          <div className="chart" id="ov-chart">{data && <RateChart pm={data.st.per_minute} />}</div>
          <div className="panel-head" style={{ marginTop: 14 }}><h3>Latest reads</h3></div>
          <div className="recent" id="ov-recent">
            {data && (data.recent.length ? data.recent.map((e) => (
              <div className="r" key={e.id}>{e.crop_url ? <img src={withTok(e.crop_url)} alt="" /> : <span />}
                <span><Plate plate={e.plate} masked={e.plate_masked} /> <span className="muted small">{app.camName(e.camera_id)}</span></span>
                <span className="muted small">{fmtTime(e.ts)}</span></div>)) : <p className="muted small">No plate reads yet.</p>)}
          </div>
        </div>
        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <div className="panel"><div className="panel-head"><h3>Live counts</h3><span className="muted small" id="ov-counts-sub">{counts.sub}</span></div>
            <div className="status-list" id="ov-counts">
              {counts.live.length ? counts.live.slice(0, 8).map((c) => (
                <div className="item" key={c.camera_id}><span className="dot ok" /><span className="name">{c.name}</span>
                  <span className="muted">{c.vehicles} veh · {c.persons} ppl{c.faces ? ` · ${c.faces} face${c.faces > 1 ? "s" : ""}` : ""}
                    {(c.known || []).length > 0 && <> · <span className="bad-chip">{c.known.join(", ")}</span></>}</span></div>))
                : <p className="muted small">Enable <code>traffic:</code> / <code>crowd:</code> / <code>face: true</code> on cameras in config/analytics.yaml to see live counts.</p>}
            </div></div>
          <div className="panel"><div className="panel-head"><h3>Cameras</h3><span className="muted small">{app.cameras.length} registered</span></div>
            <div className="status-list" id="ov-cams">
              {Object.keys(byDept).length ? Object.entries(byDept).map(([d, x]) => (
                <div className="item" key={d}><span className={`dot ${x.online === x.total ? "ok" : x.online ? "online" : "off"}`} /><span className={`name dept-${d}`}>{d}</span>
                  <span className="muted">{x.online}/{x.total} online · {x.anpr} ANPR</span></div>))
                : <p className="muted small">No cameras yet — add a source in config/sources.yaml.</p>}
            </div></div>
          <div className="panel"><div className="panel-head"><h3>Sources</h3></div>
            <div className="status-list" id="ov-sources">
              {data && (data.sources.length ? data.sources.map((s) => (
                <div className="item" key={s.id || s.name}><span className={`dot ${s.status === "ok" ? "ok" : "off"}`} /><span className="name">{s.name}</span>
                  <span className="muted small">{s.adapter} · {s.cameras} cams · {s.active_pulls}/{s.max_concurrent_pulls} pulls</span></div>))
                : <p className="muted small">No sources visible to your role.</p>)}
            </div></div>
          <div className="panel"><div className="panel-head"><h3>Licence &amp; health</h3></div>
            {data && <Health lic={data.lic} wsOk={app.wsOk} />}</div>
        </div>
      </div>
    </main>
  );
}

function Kpis({ st }) {
  const online = st.cameras_online, total = st.cameras;
  return <>
    <Kpi l="Cameras online" v={`${online} / ${total}`} cls={online === total ? "ok" : online ? "warn" : "bad"} />
    <Kpi l="ANPR reads (24 h)" v={st.events} /><Kpi l="Unique plates (24 h)" v={st.unique_plates} />
    <Kpi l="Open alerts" v={st.alerts_open} cls={st.alerts_open ? "bad" : "ok"} /><Kpi l="Watchlist plates" v={st.watchlist} /><Kpi l="ANPR cameras" v={st.anpr_cameras} />
  </>;
}

function Health({ lic, wsOk }) {
  const over = Object.entries(lic.over_limit || {}).filter(([, v]) => v).map(([k]) => k);
  return <div className="kv" id="ov-health">
    <span>Licence</span><span className={lic.mode === "licensed" ? "ok-chip" : "warn-chip"}>{lic.status}</span>
    <span>Cameras / ANPR / analytics</span><span>{lic.usage.cameras_total} / {lic.usage.anpr_channels} / {lic.usage.analytics_channels}{over.length > 0 && <> <span className="bad-chip">over: {over.join(", ")}</span></>}</span>
    <span>Version</span><span>v{lic.version}</span>
    <span>Live channel</span><span className={wsOk ? "ok-chip" : "bad-chip"}>{wsOk ? "connected" : "reconnecting"}</span>
  </div>;
}

/** Live vehicle / people counts, refreshed every 5 s while the overview is open. */
function useLiveCounts() {
  const [s, setS] = useState({ live: [], sub: "" });
  useEffect(() => {
    let timer, alive = true;
    const tick = async () => {
      try {
        const r = await api("/api/counts");
        const live = r.cameras.filter((c) => !c.stale);
        if (alive) setS({ live, sub: live.length ? `${r.total.vehicles} vehicles · ${r.total.persons} people on ${r.total.cameras} cameras now` : "no analytics cameras reporting" });
      } catch (_) {}
      if (alive) timer = setTimeout(tick, 5000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return s;
}
