import { useRef, useState } from "react";
import { api, apiJson, fmtTime } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { Dept, EmptyRow, formData, useLoad } from "../components/common.jsx";

export default function Sources() {
  const app = useApp();
  const ui = useUI();
  const [sources] = useLoad(() => api("/api/sources"));
  const [devices, reloadDevices] = useLoad(() => api("/api/devices").catch(() => null));
  const [cap] = useLoad(() => api("/api/capacity").catch(() => null));
  const [archive] = useLoad(() => api("/api/archive/stats").catch(() => null));
  const [slaDays, setSlaDays] = useState("7");
  const [sla] = useLoad(() => api(`/api/health/sla?days=${slaDays}`).catch(() => null), [slaDays]);

  const openDevice = async (existing) => {
    let types;
    try { types = await api("/api/devices/types"); } catch (e) { ui.toast(e.message, "err"); return; }
    ui.modal(<DeviceDialog types={types} existing={existing} onSaved={(isNew) => {
      reloadDevices(); setTimeout(() => app.loadCameras().catch(() => {}), 12000); setTimeout(reloadDevices, 15000);
      ui.toast(isNew ? "device saved — cameras appear on the wall and in the registry within ~15 s" : "saved — the adapters re-sync within seconds", "ok");
    }} />);
  };
  const disconnect = async (id) => {
    if (!confirm(`Disconnect ${id}? Its cameras leave the wall and the registry.`)) return;
    const r = await api(`/api/devices/${id}`, { method: "DELETE" });
    ui.toast(`disconnected, ${r.cameras_removed} camera(s) removed`, "ok"); reloadDevices(); app.loadCameras();
  };

  return (
    <main id="view-sources" className="view">
      <div className="view-head"><div><h2>Sources</h2><p>Departmental systems, capacity, camera health and the video archive.</p></div>
        {app.has("admin") && <div className="quick"><button className="btn small primary" id="dev-connect" onClick={() => openDevice(null)}>Connect a device</button></div>}</div>
      <div className="cards" id="source-cards">{sources && (sources.length ? sources.map((s) => (
        <div className="card" key={s.id || s.name}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b className={`dept-${s.department}`}>{s.department}</b><span><span className={`dot ${s.status === "ok" ? "ok" : "off"}`} /> {s.status}</span></div>
          <div><b>{s.name}</b></div>
          <div className="row"><span>Integration</span><b>{s.adapter}</b></div>
          <div className="row"><span>Cameras</span><b>{s.cameras}</b></div>
          <div className="row"><span>Streams pulled now / cap</span><b>{s.active_pulls} / {s.max_concurrent_pulls}</b></div>
          <div className="meter"><i style={{ width: `${Math.min(100, (100 * s.active_pulls) / s.max_concurrent_pulls)}%` }} /></div>
          <div className="row"><span>Viewers served by relay</span><b>{s.viewers}</b></div>
          <div className="small muted">{s.detail}{s.checked_at ? ` · checked ${fmtTime(s.checked_at)}` : ""}</div>
        </div>)) : <p className="muted">No sources yet. The adapter service registers them on start.</p>)}</div>

      {devices && <div className="panel" id="dev-panel"><div className="panel-head"><h3>Devices connected from the console</h3><span className="muted small">Stored encrypted in the platform database; the adapters connect within seconds. Systems defined in sources.yaml are listed above.</span></div>
        <table className="table" id="dev-table"><thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Type</th><th>Host</th><th>Cameras</th><th>Status</th><th /></tr></thead>
          <tbody>{devices.length ? devices.map((d) => (
            <tr key={d.id}><td className="mono small">{d.id}</td><td><b>{d.name}</b></td><td>{d.department}</td>
              <td>{d.config.vendor || d.adapter}</td><td className="small">{d.config.host || (d.config.streams || [])[0]?.main || ""}</td><td>{d.cameras} / {d.channels}</td>
              <td>{d.status === "ok" ? <span className="ok-chip">ok</span> : d.status === "error" ? <span className="bad-chip" title={d.status_detail}>error</span> : <span className="muted">connecting…</span>}
                {d.status_detail && d.status !== "ok" && <div className="muted small">{d.status_detail.slice(0, 90)}</div>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{app.has("admin") && <><button className="btn small" onClick={() => openDevice(d)}>Edit</button> <button className="btn small danger" onClick={() => disconnect(d.id)}>Disconnect</button></>}</td></tr>))
            : <EmptyRow cols={8}>No devices connected from the console yet — click <b>Connect a device</b>.</EmptyRow>}</tbody></table></div>}

      <div className="panel note">
        <h3>How departmental systems stay unaffected</h3>
        <ul>
          <li>Each source is read with one read-only account. Adapters block every non-read call in code.</li>
          <li>The relay pulls each stream once, however many operators watch it. Pulls start on demand and stop 10 s after the last viewer leaves.</li>
          <li>Each source has an agreed cap on concurrent pulls. New streams are refused once the cap is reached.</li>
          <li>ANPR reads from the relay, not from the departmental system.</li>
          <li>Departmental recordings stay in each department's VMS. The platform's own archive (event clips, plate crops and the streams it already pulls for ANPR) is written to object storage from the relay, never re-read from the departmental system.</li>
        </ul>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Capacity per department</h3><span className="muted small" id="cap-sub">{cap && `relays: ${Object.entries(cap.relays).map(([n, r]) => `${n} ${r.healthy ? "✓" : "✗"}`).join(", ")} · record mode ${cap.record_mode}`}</span></div>
        <table className="table" id="cap-table"><thead><tr><th>Department</th><th>Cameras online</th><th>ANPR channels</th><th>Recorded</th><th>Pulls / cap</th><th>Viewers</th><th>Events 24 h</th><th>Archive</th><th>Relays</th></tr></thead>
          <tbody>{cap && (cap.departments.length ? cap.departments.map((d) => (
            <tr key={d.department}><td><Dept d={d.department} /></td><td>{d.online}/{d.cameras}</td><td>{d.anpr_channels}</td><td>{d.recorded}</td>
              <td>{d.pulls}/{d.pull_cap}</td><td>{d.viewers}</td><td>{d.events_24h}</td><td>{d.archive_gb} GB (+{d.archive_gb_per_day}/day, est. {d.storage_estimate_gb_per_day}/day)</td>
              <td className="small">{Object.entries(d.relays).map(([r, n]) => `${r}: ${n}`).join(", ")}</td></tr>))
            : <EmptyRow cols={9}>No cameras.</EmptyRow>)}</tbody></table>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Camera health (SLA)</h3><span><select className="small" id="sla-days" value={slaDays} onChange={(e) => setSlaDays(e.target.value)}><option value="1">24 h</option><option value="7">7 days</option><option value="30">30 days</option></select>{" "}
          <span className="muted small" id="sla-sub">{sla && `fleet uptime ${sla.fleet_uptime_pct}% over ${sla.days} day(s)`}</span></span></div>
        <table className="table" id="sla-table"><thead><tr><th>Camera</th><th>Department</th><th>Status</th><th>Uptime</th><th>Outages</th><th>Downtime</th><th>Longest</th><th>Image quality</th><th>SLA ≥ 99%</th></tr></thead>
          <tbody>{sla && (sla.cameras.length ? sla.cameras.map((c) => (
            <tr key={c.camera_id || c.name}><td>{c.name}</td><td><Dept d={c.department} /></td><td><span className={`dot ${c.status === "offline" ? "off" : "ok"}`} /> {c.status}</td>
              <td><b>{c.uptime_pct}%</b></td><td>{c.outages}</td><td>{c.downtime_min} min</td><td>{c.longest_outage_min} min</td>
              <td>{c.quality ? <><span className={c.quality.verdict === "ok" ? "ok-chip" : "bad-chip"}>{c.quality.verdict}</span> <span className="muted small">sharp {c.quality.sharpness} · bright {c.quality.brightness}</span></> : <span className="muted">no sample yet</span>}</td>
              <td>{c.sla_met ? <span className="ok-chip">✓</span> : <span className="bad-chip">✗</span>}</td></tr>))
            : <EmptyRow cols={9}>No cameras.</EmptyRow>)}</tbody></table>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>Video archive</h3><span className="muted small" id="archive-sub">{archive && `${archive.storage} · record mode: ${archive.record_mode}`}</span></div>
        <table className="table" id="archive-table"><thead><tr><th>Department</th><th>Recorded segments</th><th>Storage</th><th>Event clips</th><th>Oldest</th><th>Newest</th></tr></thead>
          <tbody>{archive && (archive.departments.length ? archive.departments.map((d) => (
            <tr key={d.department}><td><Dept d={d.department} /></td><td>{d.segments}</td><td>{(d.bytes / 1073741824).toFixed(2)} GB</td><td>{d.clips}</td><td>{d.from ? fmtTime(d.from) : "–"}</td><td>{d.to ? fmtTime(d.to) : "–"}</td></tr>))
            : <EmptyRow cols={6}>Nothing archived yet.</EmptyRow>)}</tbody></table>
      </div>
    </main>
  );
}

function DeviceDialog({ types, existing, onSaved }) {
  const { toast, closeModal } = useUI();
  const c = existing?.config || {};
  const firstStream = (c.streams || [])[0] || {};
  const [type, setType] = useState(existing ? (c.streams ? "camera" : c.vendor ? "nvr" : c.adapter === "onvif" ? "onvif" : "template") : "nvr");
  const [vendor, setVendor] = useState(c.vendor || Object.keys(types.vendors)[0]);
  const [result, setResult] = useState(null);
  const form = useRef(null);
  const show = (kinds) => (kinds.split(" ").includes(type) ? "" : "hidden");

  const read = () => {
    const b = formData(form.current);
    b.type = type;
    ["lat", "lon", "rtsp_port", "onvif_port", "channels", "max_concurrent_pulls"].forEach((k) => { b[k] = b[k] === "" || b[k] == null ? null : Number(b[k]); });
    return b;
  };
  const test = async () => {
    setResult(<>testing… (up to 20 s)</>);
    try {
      const r = await apiJson("/api/devices/test", "POST", read());
      setResult(r.ok ? <><span className="ok-chip">stream OK</span> {r.codec} {r.size || ""} {r.note ? `· ${r.note}` : ""} · {r.cameras} camera(s) will be added</> : <span className="bad-chip">{r.error}</span>);
    } catch (e) { setResult(<span className="bad-chip">{e.message}</span>); }
  };
  const submit = async (ev) => {
    ev.preventDefault();
    try {
      if (existing) await apiJson(`/api/devices/${existing.id}`, "PATCH", read());
      else await apiJson("/api/devices", "POST", read());
      closeModal(); onSaved(!existing);
    } catch (e) { toast(e.message, "err"); }
  };

  return <>
    <h3>{existing ? `Edit device · ${existing.name}` : "Connect a device"}</h3>
    <p className="muted small">Give the platform a <b>read-only</b> account on the device. Credentials are stored encrypted and never shown again; the relay pulls each stream once, however many people watch.</p>
    <form ref={form} id="dev-form" className="search-form" onSubmit={submit}>
      <label>Device type <select value={type} disabled={!!existing} onChange={(e) => setType(e.target.value)}>
        {Object.entries(types.types).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <span className="muted small" style={{ flexBasis: "100%" }}>{types.types[type]?.help}{type === "nvr" && types.vendors[vendor]?.notes ? ` ${types.vendors[vendor].notes}` : ""}</span>
      <label>Name <input name="name" required defaultValue={existing?.name || ""} placeholder="e.g. Sola police station NVR" /></label>
      <label>Department <input name="department" required defaultValue={existing?.department || ""} placeholder="Police / Municipal / Transport…" /></label>
      <label className={show("nvr")}>Vendor <select name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)}>
        {Object.entries(types.vendors).map(([k, v]) => <option key={k} value={k}>{k}{v.adapter === "onvif" ? " (ONVIF)" : ""}</option>)}</select></label>
      <label className={show("nvr template onvif")}>Host / IP <input name="host" defaultValue={c.host || ""} placeholder="10.20.30.40 or nvr.police.gov.in" /></label>
      <label className={show("nvr template")}>RTSP port <input name="rtsp_port" type="number" defaultValue={c.rtsp_port || 554} /></label>
      <label className={show("onvif")}>ONVIF port <input name="onvif_port" type="number" defaultValue={c.onvif_port || 80} /></label>
      <label className={show("template")} style={{ flexBasis: "100%" }}>Main stream template <input name="main_template" defaultValue={c.main || ""} placeholder="rtsp://{host}:{rtsp_port}/stream/cam{channel:02d}" /></label>
      <label className={show("template")} style={{ flexBasis: "100%" }}>Sub stream template (optional) <input name="sub_template" defaultValue={c.sub || ""} placeholder="leave blank if the device has one stream per channel" /></label>
      <label className={show("camera")} style={{ flexBasis: "100%" }}>Main stream URL <input name="main_url" defaultValue={firstStream.main || ""} placeholder="rtsp://10.0.0.9:554/Streaming/Channels/101 (no user:pass in the URL)" /></label>
      <label className={show("camera")} style={{ flexBasis: "100%" }}>Sub stream URL (optional) <input name="sub_url" defaultValue={firstStream.sub || ""} /></label>
      <label className={show("camera")}>Latitude <input name="lat" type="number" step="any" defaultValue={firstStream.lat ?? ""} /></label>
      <label className={show("camera")}>Longitude <input name="lon" type="number" step="any" defaultValue={firstStream.lon ?? ""} /></label>
      <label className={show("nvr template")}>Channels <input name="channels" type="number" min="1" max="512" defaultValue={(c.channels || []).length || 4} /></label>
      <label>Username <input name="username" autoComplete="off" defaultValue={existing?.username || ""} placeholder="read-only account" /></label>
      <label>Password <input name="password" type="password" autoComplete="new-password" placeholder={existing ? "leave blank to keep" : ""} /></label>
      <label className="check"><input type="checkbox" name="anpr" defaultChecked={(c.channels || c.streams || []).some((x) => x.anpr)} /> ANPR on these cameras</label>
      <label>Record <select name="record" defaultValue={c.record || "anpr"}><option value="anpr">ANPR cameras only</option><option value="all">all cameras</option><option value="none">none</option></select></label>
      <label>Max streams pulled at once <input name="max_concurrent_pulls" type="number" min="1" defaultValue={c.max_concurrent_pulls || ""} placeholder="= channels" /></label>
      <div style={{ flexBasis: "100%", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" type="button" id="dev-test" onClick={test}>Test connection</button>
        <button className="btn primary">{existing ? "Save changes" : "Save & connect"}</button>
        <span className="small" id="dev-result">{result}</span>
      </div>
    </form>
  </>;
}
