import { useEffect, useRef, useState } from "react";
import { api, fmtTime, toIso, withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { Crop, useLoad } from "../components/common.jsx";

export default function Movement({ intent }) {
  const app = useApp();
  const { toast } = useUI();
  const form = useRef(null);
  const [r, setR] = useState(null);
  const [cases] = useLoad(() => (app.has("cases") ? api("/api/cases?status=open") : []), [], []);

  const run = async (ev) => {
    ev?.preventDefault();
    const f = form.current, plate = f.plate.value.trim();
    if (!plate) return;
    const q = new URLSearchParams({ fuzzy: f.fuzzy.checked });
    if (f.since.value) q.set("since", toIso(f.since.value));
    try { setR(await api(`/api/vehicles/${encodeURIComponent(plate)}/movements?${q}`)); } catch (e) { toast(e.message, "err"); }
  };
  // a plate clicked anywhere in the console arrives here as an intent
  useEffect(() => { if (intent?.plate) { form.current.plate.value = intent.plate; run(); } }, [intent?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const stitch = () => {
    const f = form.current, p = f.plate.value.trim();
    if (!p) return toast("Enter a plate first", "warn");
    const q = new URLSearchParams();
    if (f.since.value) q.set("since", toIso(f.since.value));
    if (f.until.value) q.set("until", toIso(f.until.value));
    if (f.case_id?.value) q.set("case_id", f.case_id.value);
    toast("Stitching clips… the download starts when ready", "ok");
    location.href = withTok(`/api/vehicles/${encodeURIComponent(p)}/stitch?${q}`);
  };

  const pts = r?.sightings || [];
  return (
    <main id="view-movement" className="view">
      <div className="view-head"><div><h2>Vehicle movement</h2><p>Trace one vehicle across cameras and stitch the clips into one file.</p></div></div>
      <form ref={form} id="move-form" className="panel search-form" onSubmit={run}>
        <label>Plate <input name="plate" placeholder="e.g. MH12AB1234" required defaultValue={intent?.plate || ""} /></label>
        <label className="check"><input type="checkbox" name="fuzzy" /> Include 1-character OCR variants</label>
        <label>From <input name="since" type="datetime-local" /></label>
        <label>To <input name="until" type="datetime-local" /></label>
        <button className="btn primary">Trace vehicle</button>
        {app.has("export") && <button className="btn ghost" type="button" id="stitch-btn" title="One MP4 of every archived clip, captioned per camera" onClick={stitch}>Stitch clips</button>}
        {app.has("cases") && <label>File into case <select name="case_id" id="move-case"><option value="">— none —</option>{(cases || []).map((c) => <option key={c.id} value={c.id}>{`${c.number} · ${c.title}`}</option>)}</select></label>}
      </form>
      <div className="move-grid">
        <div className="panel"><div className="panel-head"><h3 id="move-title">{r ? <>Route of <span className="platebox plate">{r.plate}</span></> : "Route"}</h3>
          <span className="muted small" id="move-sub">{r ? `${pts.length} sightings · ${r.cameras.length} cameras · ${r.departments.join(" + ") || "no departments"}` : ""}</span></div>
          <div className="move-map" id="move-map">{r && <RouteMap cams={app.cameras.filter((c) => c.lat != null)} pts={pts} />}</div></div>
        <div className="panel"><div className="panel-head"><h3>Sightings</h3></div>
          <ol className="timeline" id="move-list">{r && (pts.length ? pts.map((p, i) => (
            <li key={i}><span className="n">{i + 1}</span>
              <div><b>{p.camera_name}</b> <span className={`dept-${p.department} small`}>{p.department}</span><br />
                <span className="small muted">{fmtTime(p.ts)} · {p.direction} · {Math.round(p.confidence * 100)}%{p.plate !== r.plate ? ` · read as ${p.plate}` : ""}</span></div>
              <Crop src={p.crop_url} frame={p.frame_url} className="" /></li>)) : <li className="muted">No sightings.</li>)}</ol></div>
      </div>
    </main>
  );
}

function RouteMap({ cams, pts }) {
  if (!cams.length) return <p className="muted" style={{ padding: 12 }}>Camera locations are not configured.</p>;
  const W = 800, H = 460, P = 50;
  const lats = cams.map((c) => c.lat), lons = cams.map((c) => c.lon);
  const [a0, a1, o0, o1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const x = (lon) => P + ((lon - o0) / (o1 - o0 || 1)) * (W - 2 * P);
  const y = (lat) => H - P - ((lat - a0) / (a1 - a0 || 1)) * (H - 2 * P);
  const route = pts.filter((p) => p.lat != null);
  return (
    <svg viewBox={`0 0 ${W} ${H}`}>
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f59e0b" /></marker></defs>
      {cams.map((c) => <g key={c.id}><circle cx={x(c.lon)} cy={y(c.lat)} r="7" fill={c.department === "Police" ? "#60a5fa" : "#a78bfa"} stroke="#0d1117" strokeWidth="2" />
        <text x={x(c.lon)} y={y(c.lat) + 22} textAnchor="middle" fontSize="11" fill="#8b98a8">{c.name}</text></g>)}
      {route.slice(1).map((p, i) => <line key={i} x1={x(route[i].lon)} y1={y(route[i].lat)} x2={x(p.lon)} y2={y(p.lat)} stroke="#f59e0b" strokeWidth="3" markerEnd="url(#arr)" opacity=".9" />)}
      {route.map((p, i) => { const cx = x(p.lon) + 16 + (i % 3) * 4, cy = y(p.lat) - 16 - (i % 3) * 4;
        return <g key={`n${i}`}><circle cx={cx} cy={cy} r="10" fill="#3b82f6" /><text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="#fff" fontWeight="700">{i + 1}</text></g>; })}
      <g fontSize="11" fill="#8b98a8"><circle cx="16" cy="16" r="6" fill="#60a5fa" /><text x="28" y="20">Police camera</text><circle cx="130" cy="16" r="6" fill="#a78bfa" /><text x="142" y="20">Municipal camera</text></g>
    </svg>
  );
}
