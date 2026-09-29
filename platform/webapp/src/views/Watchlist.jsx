import { useState } from "react";
import { api, apiJson, fmtTime, upload, withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, Plate, useLoad } from "../components/common.jsx";

export default function Watchlist() {
  const app = useApp();
  const { toast } = useUI();
  const [rows, reload] = useLoad(() => api("/api/watchlist"));
  const [hot, reloadHot] = useLoad(() => (app.has("watchlist") ? api("/api/hotlists") : null));

  const add = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const r = await apiJson("/api/watchlist", "POST", { plate: f.plate.value, reason: f.reason.value, priority: f.priority.value, days: +f.days.value });
      toast(`${r.plate} added to watchlist`, "ok"); f.reset(); reload();
    } catch (e) { toast(e.message); }
  };
  const sync = async () => {
    try { const r = await api("/api/hotlists/sync", { method: "POST" }); toast(`Synced: ${Object.values(r).map((x) => `${x.source} +${x.added ?? 0}`).join(", ")}`, "ok"); reload(); reloadHot(); }
    catch (e) { toast(e.message, "err"); }
  };

  return (
    <main id="view-watchlist" className="view">
      <div className="view-head"><div><h2>Watchlist</h2><p>Plates and persons of interest, external hotlists.</p></div></div>
      {app.has("watchlist") && <form id="watch-form" className="panel search-form" onSubmit={add}>
        <label>Plate <input name="plate" required placeholder="MH12AB1234" /></label>
        <label>Reason <input name="reason" placeholder="e.g. stolen vehicle FIR 123/2026" /></label>
        <label>Priority <select name="priority"><option>high</option><option>medium</option><option>low</option></select></label>
        <label>Expires in (days) <input name="days" type="number" defaultValue="30" min="1" max="365" /></label>
        <button className="btn primary">Add to watchlist</button>
      </form>}
      <Persons />
      <div className="panel"><div className="panel-head"><h3>External hotlists</h3>{app.has("watchlist") && <button className="btn ghost small" id="hl-sync" onClick={sync}>Sync now</button>}</div>
        <div className="small muted" id="hl-list">{hot && (hot.sources.length ? hot.sources.map((s) => (
          <div key={s.name}>{s.name} · {s.kind} · every {s.interval_minutes} min · {s.last ? (s.last.ok
            ? <span className="ok-chip">✓ {s.last.entries} entries, {s.last.added} added, {s.last.removed} removed at {fmtTime(s.last.at)}</span>
            : <span className="bad-chip">✗ {s.last.error}</span>) : "not synced yet"}</div>)) : "No hotlist sources configured (config/hotlists.yaml).")}</div></div>
      <div className="panel"><table className="table" id="watch-table"><thead><tr><th>Plate</th><th>Reason</th><th>Priority</th><th>Added by</th><th>Expires</th><th /></tr></thead>
        <tbody>{rows && (rows.length ? rows.map((w) => (
          <tr key={w.plate}><td><Plate plate={w.plate} /></td><td>{w.reason}</td><td>{w.priority}</td><td>{w.added_by}</td><td>{w.expires_at ? fmtTime(w.expires_at) : "never"}</td>
            <td>{app.can("supervisor") && <button className="btn small danger" onClick={() => api(`/api/watchlist/${w.plate}`, { method: "DELETE" }).then(reload)}>Remove</button>}</td></tr>))
          : <EmptyRow cols={6}>Watchlist is empty.</EmptyRow>)}</tbody></table></div>
    </main>
  );
}

/** Persons of interest (face recognition). Also used after enrolling from an uploaded video. */
export function Persons() {
  const app = useApp();
  const ui = useUI();
  const [rows, reload] = useLoad(() => api("/api/persons"));
  const [note, setNote] = useState("");

  const enrol = async (ev) => {
    ev.preventDefault();
    const f = ev.target, fd = new FormData(f);
    if (!fd.getAll("photos").filter((x) => x && x.size).length) { ui.toast("Choose at least one photo", "err"); return; }
    setNote("Detecting faces in the photos…");
    try {
      const j = await upload("/api/persons", fd);
      ui.toast(`${j.name} enrolled with ${j.photos} photo${j.photos > 1 ? "s" : ""}; matching starts within 30 s on face-enabled cameras.`, "ok");
      f.reset(); f.days.value = 90; setNote(""); reload();
    } catch (e) { setNote(""); ui.toast(e.message, "err"); }
  };
  const sightings = async (id) => {
    const r = await api(`/api/persons/${id}/sightings`);
    ui.modal(<><h3>Sightings</h3>{r.length ? <table className="table"><thead><tr><th>When (IST)</th><th>Camera</th><th>Similarity</th><th>Snapshot</th></tr></thead>
      <tbody>{r.map((x, i) => <tr key={i}><td>{fmtTime(x.ts)}</td><td>{app.camName(x.camera_id)}</td><td>{x.score ?? "–"}</td>
        <td>{x.snapshot_url ? <img className="crop" style={{ height: 60 }} src={withTok(x.snapshot_url)} alt="" /> : "–"}</td></tr>)}</tbody></table>
      : <p className="muted">No sightings yet.</p>}</>);
  };
  const remove = async (id) => { if (confirm("Remove this person, their photos and embeddings?")) { await api(`/api/persons/${id}`, { method: "DELETE" }); reload(); } };
  const toggle = async (p) => { await apiJson(`/api/persons/${p.id}`, "PATCH", { active: !p.active }); reload(); };

  return (
    <div className="panel" id="persons-panel">
      <div className="panel-head"><h3>Persons of interest (face recognition)</h3><span className="muted small">Enrol with one or more clear photos; matches on cameras with <code>face: true</code> raise an alert. Every enrolment and match is audited.</span></div>
      {app.has("watchlist") && <form id="person-form" className="search-form" encType="multipart/form-data" onSubmit={enrol}>
        <label>Name <input name="name" required placeholder="Full name" /></label>
        <label>Category <select name="category"><option value="wanted">wanted</option><option value="missing">missing</option><option value="suspect">suspect</option><option value="other">other</option></select></label>
        <label>Priority <select name="priority"><option>high</option><option>medium</option><option>low</option></select></label>
        <label>Reference <input name="reference" placeholder="FIR / order no." /></label>
        <label>Reason <input name="reason" placeholder="why this person is of interest" /></label>
        <label>Expires (days) <input name="days" type="number" defaultValue="90" min="0" max="3650" /></label>
        <label>Photos <input name="photos" type="file" accept="image/*" multiple required /></label>
        <button className="btn primary">Enrol person</button>
        <span className="muted small" id="person-form-note">{note}</span>
      </form>}
      <p className="muted small" style={{ margin: "6px 0 12px" }}>Have a phone video, WhatsApp clip or DVR export? Use <a href="#" onClick={(e) => { e.preventDefault(); app.go("upload"); }}><b>Upload &amp; recognise</b></a> to find every person and plate in it and enrol a face straight from the footage.</p>
      <table className="table" id="persons-table"><thead><tr><th>Photo</th><th>Name</th><th>Category</th><th>Priority</th><th>Reference</th><th>Photos</th><th>Last seen</th><th>Sightings</th><th>Expires</th><th /></tr></thead>
        <tbody>{rows && (rows.length ? rows.map((p) => (
          <tr key={p.id} className={p.active ? "" : "muted"}>
            <td>{p.photo_urls[0] ? <img className="crop" style={{ height: 44 }} src={withTok(p.photo_urls[0])} alt="" /> : "–"}</td>
            <td><b>{p.name}</b>{!p.active && <> <span className="bad-chip">inactive</span></>}<br /><span className="small muted">{p.reason}</span></td>
            <td>{p.category}</td><td>{p.priority}</td><td>{p.reference || "–"}</td><td>{p.photos}</td>
            <td className="small">{p.last_seen_at ? <>{fmtTime(p.last_seen_at)}<br />{app.camName(p.last_seen_camera)}</> : "–"}</td><td>{p.sightings}</td>
            <td className="small">{p.expires_at ? fmtTime(p.expires_at) : "never"}</td>
            <td><button className="btn ghost small" onClick={() => sightings(p.id)}>Sightings</button>
              {app.has("watchlist") && <> <button className="btn ghost small" onClick={() => toggle(p)}>{p.active ? "Pause" : "Resume"}</button> <button className="btn small danger" onClick={() => remove(p.id)}>Remove</button></>}</td></tr>))
          : <EmptyRow cols={10}>No persons enrolled.</EmptyRow>)}</tbody></table>
    </div>
  );
}
