import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, Kpi, Spark } from "../components/common.jsx";

/* Vehicles + people per camera: live (refreshed every 5 s) and per minute for the selected period. */
export default function Counts() {
  const app = useApp();
  const { toast } = useUI();
  const [hours, setHours] = useState("1");
  const [d, setD] = useState(null);
  const timer = useRef(null);

  const gen = useRef(0);   // one refresh loop per period selection; a stale loop stops itself
  const load = async (my = gen.current) => {
    clearTimeout(timer.current);
    try {
      const [live, tl, st] = await Promise.all([api("/api/counts"), api(`/api/counts/timeline?hours=${hours}`), api("/api/counts/status").catch(() => null)]);
      if (my !== gen.current) return;
      setD({ live, tl, st });
    } catch (e) { toast(e.message, "err"); return; }
    if (my === gen.current) timer.current = setTimeout(() => load(my), 5000);
  };
  useEffect(() => { load(++gen.current); return () => { gen.current++; clearTimeout(timer.current); }; }, [hours]); // eslint-disable-line react-hooks/exhaustive-deps

  let body = null;
  if (d) {
    const { live, tl, st } = d;
    const liveBy = Object.fromEntries((live.cameras || []).map((c) => [c.camera_id, c]));
    const tlBy = Object.fromEntries(tl.cameras.map((c) => [c.camera_id, c]));
    const ids = [...new Set([...Object.keys(liveBy), ...Object.keys(tlBy)])];
    const cams = ids.map((id) => ({ id, l: liveBy[id], t: tlBy[id], cam: app.camById[id] }))
      .filter((x) => !x.cam || !x.cam.registry_only)
      .map((x) => ({ ...x, name: x.l?.name || x.t?.name || x.cam?.name || x.id, dept: x.l?.department || x.t?.department || x.cam?.department || "",
        v: x.l && !x.l.stale ? x.l.vehicles : null, p: x.l && !x.l.stale ? x.l.persons : null, max: x.t?.crowd_max ?? tl.crowd_default ?? 25 }))
      .sort((a, b) => ((b.v ?? 0) + (b.p ?? 0)) - ((a.v ?? 0) + (a.p ?? 0)) || a.name.localeCompare(b.name));
    const crowded = cams.filter((x) => x.p != null && x.p > x.max), busy = cams.filter((x) => x.p != null && x.p > x.max * 0.7 && x.p <= x.max);
    const totV = cams.reduce((n, x) => n + (x.v || 0), 0), totP = cams.reduce((n, x) => n + (x.p || 0), 0);
    const crowdChip = (x) => x.p == null ? <span className="muted small">no signal</span>
      : x.p > x.max ? <span className="bad-chip">crowded {x.p} / {x.max}</span>
      : x.p > x.max * 0.7 ? <span className="tagchip" style={{ background: "#f59e0b33" }}>busy {x.p} / {x.max}</span>
      : <span className="ok-chip">normal {x.p} / {x.max}</span>;
    const ok = st && st.detecting_count > 0 && st.cameras_last_5min > 0;
    const age = st?.last_row_age_s;

    body = <>
      <div className="small" id="counts-status" style={{ margin: "-4px 0 12px" }}>{st && <>
        <span className={ok ? "ok-chip" : st.detecting_count ? "tagchip" : "bad-chip"}>{ok ? "counting" : st.detecting_count ? "starting" : "not counting"}</span>{" "}
        <span className="muted">{st.expected_count} camera{st.expected_count === 1 ? "" : "s"} selected · {st.detecting_count} sending detections now · last per-minute row {age == null ? "never" : age < 90 ? `${Math.round(age)} s ago` : `${Math.round(age / 60)} min ago`} · {st.cameras_last_5min} camera{st.cameras_last_5min === 1 ? "" : "s"} with rows in the last 5 min</span>
        {st.hint && <div className="bad-chip" style={{ marginTop: 6, whiteSpace: "normal" }}>{st.hint}</div>}</>}</div>
      <div className="kpis" id="counts-kpis">
        <Kpi l="Vehicles in view now" v={totV} /><Kpi l="People in view now" v={totP} />
        <Kpi l="Cameras counting" v={`${cams.filter((x) => x.v != null).length} / ${cams.length}`} />
        <Kpi l="Crowded now" v={crowded.length} cls={crowded.length ? "bad" : "ok"} /><Kpi l="Busy (> 70 % of threshold)" v={busy.length} cls={busy.length ? "warn" : ""} />
        <Kpi l={`Peak people (${hours} h)`} v={Math.max(0, ...cams.map((x) => x.t?.peak_persons || 0))} /><Kpi l={`Peak vehicles (${hours} h)`} v={Math.max(0, ...cams.map((x) => x.t?.peak_vehicles || 0))} />
      </div>
      <div className="panel">
        <table className="table" id="counts-table"><thead><tr><th>Camera</th><th>Department</th><th>Vehicles now</th><th>People now</th><th>Crowd</th><th>Avg vehicles</th><th>Peak vehicles</th><th>Avg people</th><th>Peak people</th><th>Flow (line)</th><th>Trend (vehicles · people)</th></tr></thead>
          <tbody>{cams.length ? cams.map((x) => {
            const pts = x.t?.points || []; const mv = Math.max(1, ...pts.map((p) => p[1])), mp = Math.max(1, ...pts.map((p) => p[2]));
            return <tr key={x.id}><td><b>{x.name}</b><div className="muted small mono">{x.id}</div></td><td>{x.dept}</td>
              <td><b>{x.v ?? "–"}</b></td><td><b>{x.p ?? "–"}</b></td><td>{crowdChip(x)}</td>
              <td>{x.t?.avg_vehicles ?? "–"}</td><td>{x.t?.peak_vehicles ?? "–"}</td><td>{x.t?.avg_persons ?? "–"}</td><td>{x.t?.peak_persons ?? "–"}</td>
              <td className="small">{x.t && (x.t.flow.a_to_b || x.t.flow.b_to_a) ? `${x.t.flow.a_to_b} → · ${x.t.flow.b_to_a} ←` : <span className="muted">no line</span>}</td>
              <td><Spark points={pts} idx={1} colour="#06d6a0" max={mv} /> <Spark points={pts} idx={2} colour="#ef476f" max={mp} /></td></tr>;
          }) : <EmptyRow cols={11}>No counts yet — the analytics worker counts every pulled camera; rows appear about a minute after a camera comes online.</EmptyRow>}</tbody></table>
        <p className="muted small" style={{ marginTop: 8 }}>Live = objects in the last detection (≤ 10 s). Per-minute averages and peaks come from the analytics worker (ANALYTICS_FPS frames/s). Crowd threshold: {tl.crowd_default ?? 25} persons by default (CROWD_MAX_PERSONS), per camera under crowd.max_persons in config/analytics.yaml.</p>
      </div>
    </>;
  }

  return (
    <main id="view-counts" className="view">
      <div className="view-head"><div><h2>Vehicle &amp; crowd counts</h2><p>Vehicles and people in view on every camera — live (refreshed every 5 s) and per minute for the selected period. A camera goes <b>crowded</b> when persons exceed its threshold; that also raises an alert.</p></div>
        <div className="quick"><label className="small">Period <select id="counts-hours" value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="1">last hour</option><option value="3">3 hours</option><option value="12">12 hours</option><option value="24">24 hours</option><option value="168">7 days</option></select></label>
          <button className="btn small ghost" id="counts-refresh" onClick={() => load()}>Refresh</button></div></div>
      {body}
    </main>
  );
}
