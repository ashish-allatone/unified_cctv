import { useEffect, useRef, useState } from "react";
import { api, apiJson, fmtTime, session, withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, Kpi, useLoad } from "../components/common.jsx";

/* Centralised CCTV inventory: every camera in the State, integrated or not. */
const REG_FIELDS = [
  ["name", "Name", "text", true], ["department", "Department", "text", true], ["camera_type", "Camera type", ["", "fixed", "dome", "bullet", "ptz", "anpr", "thermal", "other"]],
  ["make_model", "Make / model", "text"], ["resolution", "Resolution", "text"], ["lat", "Latitude", "number"], ["lon", "Longitude", "number"],
  ["heading", "Heading (° from N)", "number"], ["fov", "Field of view (°)", "number"], ["range_m", "Useful range (m)", "number"],
  ["ownership", "Ownership", ["", "department", "vendor-managed", "leased", "private-shared", "other"]], ["owner_contact", "Owner contact", "text"],
  ["connectivity", "Connectivity", ["", "fibre", "lan", "4g", "wifi", "offline-dvr", "none"]], ["storage_type", "Storage", ["", "nvr", "dvr", "cloud", "edge", "none"]],
  ["storage_days", "Retention (days)", "number"], ["install_date", "Installed", "date"], ["warranty_until", "Warranty until", "date"],
  ["maintenance_status", "Maintenance", ["", "ok", "due", "under_repair", "faulty", "decommissioned", "planned"]], ["last_maintenance", "Last maintenance", "date"],
  ["address", "Address", "text"], ["zone", "Zone", "text"], ["ward", "Ward", "text"], ["pole_id", "Pole / mount id", "text"], ["tags", "Tags (; separated)", "text"], ["notes", "Notes", "text"]];
const FILTERS = ["q", "department", "camera_type", "status", "connectivity", "ownership", "maintenance", "integrated"];
const EMPTY_FILTER = Object.fromEntries(FILTERS.map((k) => [k, ""]));

export default function Registry() {
  const app = useApp();
  const ui = useUI();
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [debounced, setDebounced] = useState(EMPTY_FILTER);
  useEffect(() => { const t = setTimeout(() => setDebounced(filter), 250); return () => clearTimeout(t); }, [filter]);
  const [data, reload] = useLoad(async () => {
    const qs = new URLSearchParams(Object.entries(debounced).filter(([, v]) => v));
    const [rows, st] = await Promise.all([api(`/api/registry?${qs}`), api("/api/registry/stats")]);
    return { rows, st };
  }, [debounced]);
  const [departments, setDepartments] = useState([]);
  useEffect(() => { if (data && !departments.length) setDepartments(Object.keys(data.st.by_department).sort()); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setFilter((f) => ({ ...f, [k]: e.target.value }));
  const edit = (id) => openRegEdit(ui, id, data?.rows, reload, app.has("registry_edit"));
  const remove = async (id) => {
    if (!confirm(`Remove ${id} from the registry?`)) return;
    await api(`/api/registry/${id}`, { method: "DELETE" }); ui.toast("removed", "ok"); reload();
  };
  const exportCsv = () => {
    const f = filter;
    window.open(withTok(`/api/registry/export.csv?department=${encodeURIComponent(f.department)}&camera_type=${f.camera_type}&status=${f.status}&integrated=${f.integrated}&q=${encodeURIComponent(f.q)}`));
  };
  const st = data?.st, rows = data?.rows || [];
  const canEdit = app.has("registry_edit");
  const chip = (h) => <span className={h === "online" ? "ok-chip" : h === "offline" ? "bad-chip" : "tagchip"}>{h}</span>;
  const opts = (list) => list.map((o) => <option key={o}>{o}</option>);

  return (
    <main id="view-registry" className="view">
      <div className="view-head"><div><h2>CCTV registry</h2><p>Central inventory of every camera in the State — integrated or not: location, department, type, ownership, connectivity, storage, installation and maintenance. Feeds the GIS map and the gap analysis.</p></div>
        <div className="quick">
          {canEdit && <><button className="btn small" id="reg-add" onClick={() => edit("")}>Add camera</button><button className="btn small" id="reg-import" onClick={() => ui.modal(<ImportDialog onDone={reload} />)}>Import CSV</button></>}
          <button className="btn small ghost" id="reg-template" onClick={() => window.open(withTok("/api/registry/template.csv"))}>CSV template</button>
          <button className="btn small ghost" id="reg-export" onClick={exportCsv}>Export CSV</button>
          {canEdit && <button className="btn small" id="reg-geocode" title="Find coordinates for cameras from their names (OpenStreetMap)" onClick={() => ui.modal(<GeocodeDialog onDone={reload} />)}>Locate by name</button>}
          <button className="btn small primary" id="reg-gaps" onClick={() => ui.modal(<GapsDialog departments={departments} />)}>Gap-analysis report</button>
          <button className="btn small ghost" id="reg-api" onClick={() => ui.modal(<ApiHelp />)}>API</button>
        </div></div>
      {st && <div className="kpis" id="reg-kpis">
        <Kpi l="Cameras registered" v={st.total} /><Kpi l="Integrated (live feed)" v={st.integrated} cls="ok" /><Kpi l="Registry only" v={st.registry_only} />
        <Kpi l="Offline now" v={st.health.offline || 0} cls={st.health.offline ? "bad" : "ok"} /><Kpi l="Maintenance due / faulty" v={st.maintenance_due} cls={st.maintenance_due ? "warn" : "ok"} />
        <Kpi l="Ageing (≥ 5 y) / warranty expired" v={`${st.ageing} / ${st.warranty_expired}`} cls={st.ageing ? "warn" : ""} />
        <Kpi l="Geolocated" v={`${st.geolocated} / ${st.total}`} cls={st.geolocated === st.total ? "ok" : "warn"} />
        <Kpi l="Metadata incomplete" v={st.missing_metadata} cls={st.missing_metadata ? "warn" : "ok"} />
      </div>}
      <div className="panel">
        <form id="reg-filter" className="search-form" onSubmit={(e) => e.preventDefault()}>
          <label>Search <input value={filter.q} onChange={set("q")} placeholder="name, id, address, pole, make…" /></label>
          <label>Department <select value={filter.department} onChange={set("department")}><option value="">all</option>{opts(departments)}</select></label>
          <label>Type <select value={filter.camera_type} onChange={set("camera_type")}><option value="">all</option>{opts(["fixed", "dome", "bullet", "ptz", "anpr", "thermal", "other"])}</select></label>
          <label>Health <select value={filter.status} onChange={set("status")}><option value="">all</option><option value="online">online</option><option value="offline">offline</option><option value="not-integrated">not integrated</option><option value="unknown">unknown</option></select></label>
          <label>Connectivity <select value={filter.connectivity} onChange={set("connectivity")}><option value="">all</option>{opts(["fibre", "lan", "4g", "wifi", "offline-dvr", "none"])}</select></label>
          <label>Ownership <select value={filter.ownership} onChange={set("ownership")}><option value="">all</option>{opts(["department", "vendor-managed", "leased", "private-shared", "other"])}</select></label>
          <label>Maintenance <select value={filter.maintenance} onChange={set("maintenance")}><option value="">all</option>{opts(["ok", "due", "under_repair", "faulty", "decommissioned", "planned"])}</select></label>
          <label>Feed <select value={filter.integrated} onChange={set("integrated")}><option value="">all</option><option value="yes">integrated</option><option value="no">registry only</option></select></label>
          <span className="muted small" id="reg-count">{data && `${rows.length} camera${rows.length === 1 ? "" : "s"} match`}</span>
        </form>
        <div style={{ overflow: "auto" }}><table className="table" id="reg-table"><thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Type</th><th>Health</th><th>Connectivity</th><th>Storage</th><th>Installed</th><th>Maintenance</th><th>Location</th><th /></tr></thead>
          <tbody>{data && (rows.length ? rows.map((r) => (
            <tr key={r.id}>
              <td className="mono small">{r.id}</td><td><b>{r.name}</b>{r.address && <div className="muted small">{r.address}</div>}</td><td>{r.department}</td>
              <td>{r.camera_type || "–"}{r.anpr_enabled && <> <span className="tagchip">ANPR</span></>}</td><td>{chip(r.health)}</td>
              <td>{r.connectivity || "–"}</td><td>{r.storage_type || "–"}{r.storage_days != null ? ` · ${r.storage_days} d` : ""}</td>
              <td>{r.install_date || "–"}{r.age_years != null && <div className="muted small">{r.age_years} y{r.warranty_expired ? " · warranty expired" : ""}</div>}</td>
              <td>{r.maintenance_status && r.maintenance_status !== "ok" ? <span className="bad-chip">{r.maintenance_status}</span> : r.maintenance_status || "–"}</td>
              <td className="small">{r.lat != null ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : <span className="muted">not geolocated</span>}</td>
              <td style={{ whiteSpace: "nowrap" }}><button className="btn small" data-reg-edit={r.id} onClick={() => edit(r.id)}>{canEdit ? "Edit" : "View"}</button>{" "}
                <button className="btn small ghost" onClick={() => ui.modal(<HistoryDialog id={r.id} />)}>History</button>
                {canEdit && r.registry_only && <> <button className="btn small danger" onClick={() => remove(r.id)}>Delete</button></>}</td>
            </tr>)) : <EmptyRow cols={11}>No cameras match.</EmptyRow>)}</tbody></table></div>
      </div>
    </main>
  );
}

/** Edit / add a registry camera. Also used from map popups. */
export async function openRegEdit(ui, id, rows, onSaved, canEdit) {
  let r = {};
  if (id) {
    r = rows?.find((x) => x.id === id);
    if (!r) { try { r = await api(`/api/registry/${id}`); } catch (e) { ui.toast(e.message, "err"); return; } }
  }
  ui.modal(<RegEditDialog key={id || "new"} id={id} r={r} canEdit={canEdit} onSaved={onSaved} />);
}

function RegEditDialog({ id, r, canEdit, onSaved }) {
  const { toast, closeModal } = useUI();
  const form = useRef(null);
  const [found, setFound] = useState(null);   // null | string | candidates[]
  const ro = !canEdit;

  const find = async () => {
    const q = form.current.name.value.trim(); if (!q) { toast("type the camera name first", "err"); return; }
    setFound("searching…");
    try {
      const res = await apiJson("/api/registry/geocode", "POST", { query: q });
      const c = res.candidates.filter((x) => x.lat != null);
      setFound(c.length ? c : "not found — try a shorter name or add the city (e.g. 'Paldi Circle, Ahmedabad')");
    } catch (e) { setFound(e.message); }
  };
  const pick = (x) => { form.current.lat.value = x.lat.toFixed(6); form.current.lon.value = x.lon.toFixed(6); setFound(`set to ${x.label} — Save to keep`); };
  const submit = async (ev) => {
    ev.preventDefault();
    const f = form.current, body = {};
    REG_FIELDS.forEach(([k, , type]) => {
      let v = f[k].value;
      if (type === "number") v = v === "" ? null : Number(v);
      else if (k === "tags") v = v.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
      body[k] = v;
    });
    try {
      if (id) await apiJson(`/api/registry/${id}`, "PATCH", body);
      else await apiJson("/api/registry", "POST", body);
      closeModal(); toast(id ? "saved" : "camera added to the registry", "ok"); onSaved?.();
    } catch (e) { toast(e.message, "err"); }
  };

  return <>
    <h3>{id ? <>{r.name} <span className="muted small mono">{id}</span></> : "Add camera to the registry"}</h3>
    {id && !r.registry_only && <p className="muted small">This camera is fed by a departmental source: its stream comes from sources.yaml, everything else is editable here.</p>}
    <form ref={form} id="reg-form" className="search-form" style={{ maxHeight: "60vh", overflow: "auto" }} onSubmit={submit}>
      {REG_FIELDS.map(([k, label, type, req]) => {
        const v = k === "tags" ? (r.tags || []).join("; ") : (r[k] ?? "");
        return <label key={k}>{label} {Array.isArray(type)
          ? <select name={k} defaultValue={String(v)} disabled={ro}>{type.map((o) => <option key={o} value={o}>{o || "–"}</option>)}</select>
          : <input name={k} type={type} step={type === "number" ? "any" : undefined} defaultValue={v} required={req} readOnly={ro} />}</label>;
      })}
      {canEdit && <div style={{ width: "100%" }}><button className="btn small ghost" type="button" onClick={find}>Find on map by name</button>{" "}
        <span className="muted small">{Array.isArray(found) ? found.map((x, i) => <span key={i}>{i > 0 && " · "}<a href="#" onClick={(e) => { e.preventDefault(); pick(x); }}>{x.label}</a></span>) : found}</span></div>}
      {canEdit && <div style={{ width: "100%", display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn primary">{id ? "Save changes" : "Add camera"}</button></div>}
    </form>
  </>;
}

function HistoryDialog({ id }) {
  const [h] = useLoad(() => api(`/api/registry/${id}/history`));
  if (!h) return <p className="muted">Loading…</p>;
  return <>
    <h3>History · {h.camera.name} <span className="muted small mono">{id}</span></h3>
    <p className="muted small">Created {h.camera.created_at ? fmtTime(h.camera.created_at) : "with the source config"} by {h.camera.created_by || "adapter"} · last change {h.camera.updated_at ? fmtTime(h.camera.updated_at) : "–"} by {h.camera.updated_by || "–"}</p>
    <h4>Metadata changes (audit trail)</h4>
    <table className="table"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>{h.changes.length ? h.changes.map((c, i) => <tr key={i}><td>{fmtTime(c.ts)}</td><td>{c.user}</td><td>{c.action}</td><td className="small">{c.detail}</td></tr>) : <EmptyRow cols={4}>no changes recorded</EmptyRow>}</tbody></table>
    <h4 style={{ marginTop: 12 }}>Health transitions</h4>
    <table className="table"><thead><tr><th>When</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>{h.status.length ? h.status.slice(0, 40).map((x, i) => <tr key={i}><td>{fmtTime(x.ts)}</td><td>{x.status}</td><td className="small">{x.detail}</td></tr>) : <EmptyRow cols={3}>no transitions (not integrated, or always up)</EmptyRow>}</tbody></table>
  </>;
}

function ImportDialog({ onDone }) {
  const { toast } = useUI();
  const form = useRef(null);
  const [j, setJ] = useState(null);
  const send = async (apply) => {
    const fd = new FormData(); fd.append("file", form.current.file.files[0]);
    const r = await fetch(`/api/registry/import?apply=${apply}`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` }, body: fd });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.detail || r.statusText);
    return res;
  };
  const check = async (ev) => { ev.preventDefault(); try { setJ(await send(0)); } catch (e) { toast(e.message, "err"); } };
  const apply = async () => {
    try { const res = await send(1); setJ(res); if (res.created + res.updated) { toast(`${res.created} created, ${res.updated} updated`, "ok"); onDone(); } }
    catch (e) { toast(e.message, "err"); }
  };
  const cols = ["id", "name", "department", "lat", "lon", "heading", "fov", "range_m", "camera_type", "make_model", "resolution", "ownership", "owner_contact", "connectivity", "storage_type", "storage_days", "install_date", "warranty_until", "maintenance_status", "last_maintenance", "address", "zone", "ward", "pole_id", "tags", "notes"];
  return <>
    <h3>Bulk import from CSV</h3>
    <p className="muted small">Columns as in the <a href="#" onClick={(e) => { e.preventDefault(); window.open(withTok("/api/registry/template.csv")); }}>template</a>: {cols.map((c, i) => <span key={c}>{i > 0 && ", "}<code>{c}</code>{c === "id" ? " (optional, otherwise generated from department + name)" : ""}</span>)}. Unknown columns are kept as extra metadata. Existing ids are updated, new ones created. The file is checked first; nothing is written while any row has an error.</p>
    <form ref={form} id="reg-import-form" className="search-form" onSubmit={check}>
      <label>CSV file <input name="file" type="file" accept=".csv,text/csv" required /></label>
      <button className="btn">Check file</button>
      {j && !j.apply && !j.errors.length && j.valid > 0 && <button className="btn primary" type="button" onClick={apply}>Import</button>}
      <span className="muted small">{j && (j.apply ? `${j.created} created · ${j.updated} updated · ${j.unchanged} unchanged · ${j.errors.length} rejected` : `${j.rows} rows · ${j.valid} valid · ${j.errors.length} with errors`)}</span>
    </form>
    {j && <div>
      {j.errors.length > 0 && <><h4 style={{ marginTop: 10 }}>Rows with errors</h4><table className="table"><thead><tr><th>Row</th><th>ID</th><th>Problem</th></tr></thead>
        <tbody>{j.errors.map((e, i) => <tr key={i}><td>{e.row}</td><td className="mono small">{e.id}</td><td className="small">{e.errors.join("; ")}</td></tr>)}</tbody></table></>}
      {!j.apply && j.preview.length > 0 && <><h4 style={{ marginTop: 10 }}>Preview (first {j.preview.length})</h4><table className="table"><thead><tr><th>Row</th><th>ID</th><th>Name</th><th>Department</th><th>Type</th><th>Location</th></tr></thead>
        <tbody>{j.preview.map((p, i) => <tr key={i}><td>{p.row}</td><td className="mono small">{p.id}</td><td>{p.name}</td><td>{p.department}</td><td>{p.camera_type || "–"}</td><td className="small">{p.lat != null ? `${p.lat}, ${p.lon}` : "–"}</td></tr>)}</tbody></table></>}
      {j.note && <p className="bad-chip">{j.note}</p>}
    </div>}
  </>;
}

function GapsDialog({ departments }) {
  const app = useApp();
  const { closeModal } = useUI();
  const form = useRef(null);
  const qs = () => { const f = form.current; return new URLSearchParams({ cell_m: f.cell_m.value, age_years: f.age_years.value, min_storage_days: f.min_storage_days.value, department: f.department.value }); };
  return <>
    <h3>Gap-analysis report</h3>
    <p className="muted small">Grid the area spanned by the cameras and list every cell no working camera covers (largest holes first), plus ageing, maintenance, offline and retention findings. Opens as a printable page; the map can overlay the uncovered cells (Map → “Uncovered zones”).</p>
    <form ref={form} id="reg-gaps-form" className="search-form" onSubmit={(ev) => { ev.preventDefault(); window.open(withTok(`/api/registry/gaps?format=html&${qs()}`)); }}>
      <label>Grid cell (m) <input name="cell_m" type="number" defaultValue="100" min="50" max="5000" /></label>
      <label>Ageing threshold (years) <input name="age_years" type="number" defaultValue="5" min="1" max="30" /></label>
      <label>Retention policy (days) <input name="min_storage_days" type="number" defaultValue="30" min="1" max="3650" /></label>
      <label>Department <select name="department"><option value="">all</option>{departments.map((d) => <option key={d}>{d}</option>)}</select></label>
      <button className="btn primary">Open report</button>
      <button className="btn ghost" type="button" onClick={() => window.open(withTok(`/api/registry/gaps?format=csv&${qs()}`))}>Uncovered cells CSV</button>
      <button className="btn ghost" type="button" onClick={() => { closeModal(); app.go("map", { gaps: true }); }}>Show on map</button>
    </form>
  </>;
}

function GeocodeDialog({ onDone }) {
  const { toast, closeModal } = useUI();
  const [note, setNote] = useState("");
  const [r, setR] = useState(null);
  const [picked, setPicked] = useState({});
  const find = async (ev) => {
    ev.preventDefault(); setNote("looking up… (one camera per second)"); setR(null);
    try {
      const res = await apiJson("/api/registry/geocode", "POST", { limit: +ev.target.limit.value });
      setNote(`${res.rows.length} looked up · ${res.rows.filter((x) => x.best).length} found · ${res.remaining_without_coordinates} still without coordinates`);
      setR(res); setPicked(Object.fromEntries(res.rows.filter((x) => x.best).map((x) => [x.id, true])));
    } catch (e) { setNote(""); toast(e.message, "err"); }
  };
  const apply = async () => {
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return;
    try {
      const a = await apiJson("/api/registry/geocode", "POST", { ids, apply: true, limit: 25 });
      toast(`${a.applied} camera(s) placed on the map · ${a.remaining_without_coordinates} still without coordinates`, "ok"); closeModal(); onDone();
    } catch (e) { toast(e.message, "err"); }
  };
  const all = r ? r.rows.filter((x) => x.best).every((x) => picked[x.id]) : false;
  return <>
    <h3>Locate cameras by name</h3>
    <p className="muted small">Looks each camera <b>without coordinates</b> up on OpenStreetMap (Nominatim) using its name — e.g. <i>Paldi Circle</i>, <i>Timbavadi gate, Junagadh</i> — and proposes a position. Review the proposals, then apply the ones that look right; you can always fine-tune lat/lon with <b>Edit</b>. About one camera per second.</p>
    <form id="reg-geo-form" className="search-form" onSubmit={find}><label>Cameras per run <input name="limit" type="number" min="1" max="25" defaultValue="10" /></label><button className="btn">Find proposals</button><span className="muted small">{note}</span></form>
    {r && (!r.rows.length ? <p className="muted small">Every camera you can see already has coordinates.</p> : <>
      <table className="table"><thead><tr><th><input type="checkbox" checked={all} onChange={(e) => setPicked(Object.fromEntries(r.rows.filter((x) => x.best).map((x) => [x.id, e.target.checked])))} /></th><th>Camera</th><th>Searched for</th><th>Proposed place</th><th>Lat, lon</th></tr></thead>
        <tbody>{r.rows.map((x) => (
          <tr key={x.id}><td>{x.best && <input type="checkbox" checked={!!picked[x.id]} onChange={(e) => setPicked((p) => ({ ...p, [x.id]: e.target.checked }))} />}</td>
            <td><b>{x.name}</b><div className="muted small mono">{x.id}</div></td><td className="small">{x.query}</td>
            <td className="small">{x.best ? x.best.label : <span className="bad-chip">{(x.candidates[0] || {}).error || "not found — set it with Edit"}</span>}</td>
            <td className="small mono">{x.best ? `${x.best.lat.toFixed(5)}, ${x.best.lon.toFixed(5)}` : "–"}</td></tr>))}</tbody></table>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}><button className="btn primary" onClick={apply}>Apply selected</button></div>
    </>)}
  </>;
}

function ApiHelp() {
  return <>
    <h3>Registry API</h3>
    <p className="muted small">Same endpoints the console uses. Authenticate with a session token (<code>Authorization: Bearer …</code>) or a machine API key (<code>X-API-Key</code>, Admin → API keys, feature <code>registry_edit</code>). Full OpenAPI: <a href="/docs" target="_blank" rel="noreferrer">/docs</a>.</p>
    <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{`GET    /api/registry?department=&camera_type=&status=&connectivity=&ownership=&maintenance=&zone=&integrated=yes|no&q=
GET    /api/registry/{id}                 one camera
POST   /api/registry                      onboard one camera (JSON body: name, department, lat, lon, camera_type, ownership, …)
PATCH  /api/registry/{id}                 change any metadata fields
DELETE /api/registry/{id}                 registry-only cameras
GET    /api/registry/{id}/history         audit trail + health transitions
POST   /api/registry/import?apply=0|1     multipart CSV (dry run, then apply)
GET    /api/registry/template.csv         import template
GET    /api/registry/export.csv?…filters  filtered export (audited)
GET    /api/registry/stats                counts by department / type / health / connectivity / ownership, ageing, maintenance
GET    /api/registry/gaps?format=json|csv|html&cell_m=100&age_years=5&min_storage_days=30&department=

curl -s -X POST http://HOST:8000/api/registry -H "X-API-Key: $KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Paldi cross roads","department":"Municipal","lat":23.0117,"lon":72.5606,"camera_type":"bullet","ownership":"department","connectivity":"fibre","storage_type":"nvr","storage_days":30,"install_date":"2019-06-01"}'`}</pre>
  </>;
}
