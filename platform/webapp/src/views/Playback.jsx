import { useEffect, useRef, useState } from "react";
import { api, apiJson, fmtTime, toIso, withTok } from "../lib/api.js";
import { tr } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, useLoad } from "../components/common.jsx";
import { addToCase } from "./Cases.jsx";

/** Archived clip / recording in the modal. */
export function playArchive(ui, url, title, download) {
  const src = url.startsWith("http") ? url : withTok(url);
  ui.modal(<><h3>{title}</h3>
    <video controls autoPlay playsInline style={{ width: "min(90vw,960px)", maxHeight: "70vh", background: "#000" }} src={src} />
    <p className="small muted">Streamed from the video archive (object storage). This access is written to the audit log.
      {download && <> <a className="btn ghost small" href={withTok(download.url)} download={download.filename}>Download this video</a></>}</p></>);
}

/* ---- custom time range helpers ---- */
const pad = (n) => String(n).padStart(2, "0");
/** Date -> value of a datetime-local input (browser local time, with seconds). */
const toLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const toUnix = (v) => Math.floor(new Date(v).getTime() / 1000);
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return [h && `${h} h`, m && `${m} min`, (x || (!h && !m)) && `${x} s`].filter(Boolean).join(" ");
};
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const QUICK = [[5, "Last 5 min"], [15, "Last 15 min"], [30, "Last 30 min"], [60, "Last 1 hour"], [120, "Last 2 hours"]];
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
  const [job, setJob] = useState(null);          // combined video being prepared: { mode: "play" | "download", status, progress }
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const now = new Date();
  const [bookmarks, reloadBookmarks] = useLoad(() => api("/api/bookmarks"));
  const camOpts = app.cameras.map((c) => <option key={c.id} value={c.id}>{`${c.department} · ${c.name}`}</option>);

  const listRecordings = async (ev) => {
    ev.preventDefault(); const f = pbForm.current;
    if (!f.from.value || !f.to.value) return ui.toast("Choose both a From and a To time", "warn");
    const a = toUnix(f.from.value), b = toUnix(f.to.value);
    if (!(b > a)) return ui.toast("'To' must be later than 'From'", "warn");
    try { setRec(await api(`/api/cameras/${encodeURIComponent(f.camera.value)}/recordings/range?from=${a}&to=${b}`)); } catch (e) { ui.toast(e.message, "err"); }
  };
  const quick = (minutes) => {
    const f = pbForm.current, t = new Date();
    f.to.value = toLocal(t); f.from.value = toLocal(new Date(t.getTime() - minutes * 60000));
    f.requestSubmit();
  };
  /** Ask the server for ONE video of the listed range, wait until it is ready, then play or download it. */
  const combined = async (mode) => {
    if (!rec || job) return;
    const base = `/api/cameras/${encodeURIComponent(rec.camera_id)}/recordings`;
    setJob({ mode, status: "queued", progress: 0 });
    try {
      let j = await apiJson(`${base}/combine`, "POST", { from: rec.from_unix, to: rec.to_unix });
      const name = j.name;
      while (j.status === "queued" || j.status === "building") {
        if (!alive.current) return;
        setJob({ mode, status: j.status, progress: j.progress || 0 });
        await new Promise((r) => setTimeout(r, 1500));
        j = await api(`${base}/combined/${name}/status`);
      }
      if (!alive.current) return;
      if (j.status !== "ready") throw new Error(j.error || "Could not prepare the combined video");
      const dl = app.has("export") ? { url: j.download_url, filename: j.filename } : null;
      if (mode === "download") {
        const a = document.createElement("a");
        a.href = withTok(j.download_url); a.download = j.filename; document.body.appendChild(a); a.click(); a.remove();
        ui.toast(`Downloading ${j.filename} (${fmtMB(j.bytes)})`, "ok");
      } else {
        playArchive(ui, j.url, `${app.camName(rec.camera_id)} · ${fmtTime(rec.from)} → ${fmtTime(rec.to)} · ${fmtDur(j.duration_s)}`, dl);
      }
    } catch (e) { if (alive.current) ui.toast(e.message, "err"); }
    finally { if (alive.current) setJob(null); }
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
        <label>From (IST) <input name="from" type="datetime-local" step="1" defaultValue={toLocal(new Date(now.getTime() - 15 * 60000))} required /></label>
        <label>To (IST) <input name="to" type="datetime-local" step="1" defaultValue={toLocal(now)} required /></label>
        <button className="btn primary">Show recordings</button>
        <span className="pb-quick">{QUICK.map(([m, label]) => <button key={m} type="button" className="btn ghost small" onClick={() => quick(m)}>{label}</button>)}</span>
        <span className="muted small">Pick any time range: it plays and downloads as one combined video. Recorded cameras only (RECORD_MODE).</span>
      </form>
      <div className="panel">
        <div className="panel-head"><h3 id="pb-title">{rec ? `${rec.count} recorded segments` : "Recordings"}</h3><span className="muted small" id="pb-sub">{rec ? `${app.camName(rec.camera_id)} · ${fmtTime(rec.from)} → ${fmtTime(rec.to)}` : ""}</span></div>
        {rec && rec.count > 0 && (
          <div className="pb-combined" id="pb-combined">
            <div>
              <b>Recorded {fmtDur(rec.recorded_s)}</b> of the {fmtDur(rec.requested_s)} requested · about {fmtMB(rec.bytes)}
              {rec.gaps.length > 0 && <div className="small muted">Not recorded: {rec.gaps.slice(0, 4).map((g) => `${fmtTime(g.from)} for ${fmtDur(g.seconds)}`).join("; ")}{rec.gaps.length > 4 ? `; and ${rec.gaps.length - 4} more` : ""}. The combined video joins the recorded parts back to back.</div>}
            </div>
            <div className="pb-actions">
              <button type="button" className="btn primary" id="pb-play-all" disabled={!!job} onClick={() => combined("play")}>▶ Play combined video</button>
              {app.has("export") && <button type="button" className="btn" id="pb-download-all" disabled={!!job} onClick={() => combined("download")}>⬇ Download combined video</button>}
              {job && <span className="small muted" role="status">Preparing video… {job.status === "queued" ? "queued" : `${job.progress}%`}</span>}
            </div>
          </div>)}
        <table className="table" id="pb-table"><thead><tr><th>Start (IST)</th><th>Length</th><th>Size</th><th /></tr></thead>
          <tbody>{rec && (rec.segments.length ? rec.segments.map((x) => (
            <tr key={x.start}><td>{fmtTime(x.start)}</td><td>{Math.round(x.duration_s)} s</td><td>{(x.bytes / 1048576).toFixed(1)} MB</td>
              <td><button type="button" className="btn ghost small" data-url={x.url} onClick={() => playArchive(ui, x.url, `${app.camName(rec.camera_id)} · ${fmtTime(x.start)}`)}>Play</button></td></tr>))
            : <EmptyRow cols={4}>No recording for this camera in that time range. Recording only runs for cameras selected by RECORD_MODE (default: ANPR cameras), and the latest minute or two may not be archived yet.</EmptyRow>)}</tbody></table>
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
