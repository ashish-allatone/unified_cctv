import { useRef, useState } from "react";
import { api, apiJson, fmtTime, toIso, withTok } from "../lib/api.js";
import { tr } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, useLoad } from "../components/common.jsx";
import { addToCase } from "./Cases.jsx";

/** Archived clip / recording in the modal. */
export function playArchive(ui, url, title) {
  const src = url.startsWith("http") ? url : withTok(url);
  ui.modal(<><h3>{title}</h3>
    <video controls autoPlay playsInline style={{ width: "min(90vw,960px)", maxHeight: "70vh", background: "#000" }} src={src} />
    <p className="small muted">Streamed from the video archive (object storage). This access is written to the audit log.</p></>);
}
export async function openClip(ui, app, eid) {
  let c;
  try { c = await api(`/api/events/${eid}/clip`); } catch (e) { ui.toast(e.message, "err"); return; }
  if (c.status === "pending") return ui.toast(tr("toast.clip_pending", "Clip is still being archived; try again in a few seconds"), "warn");
  if (c.status === "none") return ui.toast("No recording for this camera at that time (camera not in RECORD_MODE or analysed from a file)", "warn");
  playArchive(ui, c.url, `${c.plate} · ${app.camName(c.camera_id)} · ${fmtTime(c.ts)}`);
}

export default function Playback() {
  const app = useApp();
  const ui = useUI();
  const pbForm = useRef(null);
  const [rec, setRec] = useState(null);
  const [bookmarks, reloadBookmarks] = useLoad(() => api("/api/bookmarks"));
  const camOpts = app.cameras.map((c) => <option key={c.id} value={c.id}>{`${c.department} · ${c.name}`}</option>);

  const listRecordings = async (ev) => {
    ev.preventDefault(); const f = pbForm.current;
    try { setRec(await api(`/api/cameras/${encodeURIComponent(f.camera.value)}/recordings?day=${f.day.value}`)); } catch (e) { ui.toast(e.message, "err"); }
  };
  const addBookmark = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const b = await apiJson("/api/bookmarks", "POST", { camera_id: f.camera.value, ts: f.ts.value ? toIso(f.ts.value) : null, label: f.label.value, before_s: +f.before_s.value, after_s: +f.after_s.value });
      ui.toast("Bookmark added; cutting clip…", "ok"); f.label.value = "";
      setTimeout(async () => { try { await api(`/api/bookmarks/${b.id}/cut`, { method: "POST" }); } catch (_) {} reloadBookmarks(); }, 500);
      reloadBookmarks();
    } catch (e) { ui.toast(e.message, "err"); }
  };
  const cut = async (id) => {
    try { const r = await api(`/api/bookmarks/${id}/cut`, { method: "POST" }); ui.toast(r.clip === "ready" ? "Clip ready" : "No recording covers that window", r.clip === "ready" ? "ok" : "warn"); reloadBookmarks(); }
    catch (e) { ui.toast(e.message, "err"); }
  };

  return (
    <main id="view-playback" className="view">
      <div className="view-head"><div><h2>Playback</h2><p>Archived recordings and bookmarks, streamed from object storage.</p></div></div>
      <form ref={pbForm} id="pb-form" className="panel search-form" onSubmit={listRecordings}>
        <label>Camera <select name="camera" id="pb-camera">{camOpts}</select></label>
        <label>Day (UTC) <input name="day" type="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
        <button className="btn primary">List recordings</button>
        <span className="muted small">Recorded cameras only (RECORD_MODE). Segments are stored in object storage and streamed from there.</span>
      </form>
      <div className="panel">
        <div className="panel-head"><h3 id="pb-title">{rec ? `${rec.count} recorded segments` : "Recordings"}</h3><span className="muted small" id="pb-sub">{rec ? `${app.camName(rec.camera_id)} · ${rec.day} (UTC day)` : ""}</span></div>
        <table className="table" id="pb-table"><thead><tr><th>Start (IST)</th><th>Length</th><th>Size</th><th /></tr></thead>
          <tbody>{rec && (rec.segments.length ? rec.segments.map((x) => (
            <tr key={x.start}><td>{fmtTime(x.start)}</td><td>{Math.round(x.duration_s)} s</td><td>{(x.bytes / 1048576).toFixed(1)} MB</td>
              <td><button type="button" className="btn ghost small" data-url={x.url} onClick={() => playArchive(ui, x.url, `${app.camName(rec.camera_id)} · ${fmtTime(x.start)}`)}>Play</button></td></tr>))
            : <EmptyRow cols={4}>No archived segments for this day. Recording only runs for cameras selected by RECORD_MODE (default: ANPR cameras).</EmptyRow>)}</tbody></table>
      </div>
      <form id="bm-form" className="panel search-form" onSubmit={addBookmark}>
        <label>Bookmark camera <select name="camera" id="bm-camera">{camOpts}</select></label>
        <label>At (IST) <input name="ts" type="datetime-local" /></label>
        <label>Before (s) <input name="before_s" type="number" defaultValue="10" min="1" max="120" /></label>
        <label>After (s) <input name="after_s" type="number" defaultValue="10" min="1" max="120" /></label>
        <label>Label <input name="label" placeholder="what happened" /></label>
        <button className="btn primary">Add bookmark</button>
      </form>
      <div className="panel"><div className="panel-head"><h3>Bookmarks</h3><span className="muted small">Clips are cut from the recording buffer or the archive and can be filed into a case</span></div>
        <table className="table" id="bm-table"><thead><tr><th>When (IST)</th><th>Camera</th><th>Label</th><th>Window</th><th>By</th><th>Clip</th><th /></tr></thead>
          <tbody>{bookmarks && (bookmarks.length ? bookmarks.map((b) => (
            <tr key={b.id}><td>{fmtTime(b.ts)}</td><td>{b.camera_name}</td><td>{b.label}</td><td>-{b.before_s}s / +{b.after_s}s</td><td>{b.created_by}</td>
              <td>{b.clip === "ready" ? <button type="button" className="btn ghost small" onClick={() => playArchive(ui, b.play_url, `${b.camera_name} · ${fmtTime(b.ts)}`)}>Play</button>
                : b.clip === "none" ? <span className="muted">not recorded</span>
                : <button type="button" className="btn ghost small" onClick={() => cut(b.id)}>Cut clip</button>}</td>
              <td>{app.has("cases") && <><button type="button" className="btn ghost small" onClick={() => addToCase(ui, "bookmark", b.id)}>+ Case</button> </>}
                <button type="button" className="btn ghost small" onClick={() => api(`/api/bookmarks/${b.id}`, { method: "DELETE" }).then(reloadBookmarks)}>✕</button></td></tr>))
            : <EmptyRow cols={7}>No bookmarks yet. Use "Bookmark" on a wall tile, or the form above for a past moment.</EmptyRow>)}</tbody></table></div>
    </main>
  );
}
