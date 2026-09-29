import { useEffect, useRef, useState } from "react";
import { api, apiJson, fmtTime, session, withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, Plate, useLoad } from "../components/common.jsx";

const summary = (a) => {
  const t = a.timing || {};
  return `${a.frames} frames · ${a.faces} face detections · ${a.persons.length} distinct person${a.persons.length === 1 ? "" : "s"} · ${a.plates.length} plate${a.plates.length === 1 ? "" : "s"}`
    + (t.total ? ` · analysed in ${t.total}s (faces ${t.faces}s, plates ${t.plates}s, decode ${t.decode}s)` : "");
};

/** POST with upload progress (XHR: fetch cannot report it), so a 150 MB phone video shows how far it has got. */
function uploadWithProgress(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url); x.setRequestHeader("Authorization", `Bearer ${session.token}`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    x.onload = () => { let b = {}; try { b = JSON.parse(x.responseText); } catch (_) {} x.status < 300 ? resolve(b) : reject(new Error(b.detail || x.statusText)); };
    x.onerror = () => reject(new Error("upload failed (network)"));
    x.send(fd);
  });
}

export default function Upload() {
  const app = useApp();
  const { toast } = useUI();
  const [rows, reload] = useLoad(() => api("/api/analyses"));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);        // string or node (progress bars)
  const [result, setResult] = useState(null);
  const resultRef = useRef(null);
  const pollTimer = useRef(null);
  useEffect(() => () => clearTimeout(pollTimer.current), []);

  const run = async (ev) => {
    ev.preventDefault();
    const f = ev.target, files = [...f.files.files];
    if (!files.length) { toast("Choose a video or photos", "err"); return; }
    const fd = new FormData();
    files.forEach((x) => fd.append("files", x));
    fd.append("plates", f.plates.checked ? "1" : "0"); fd.append("note", f.note.value);
    const mb = files.reduce((n, x) => n + x.size, 0) / 1048576;
    setResult(null); setBusy(true);
    setNote(<>Uploading {mb.toFixed(1)} MB… <progress max="100" value="0" style={{ width: 180, verticalAlign: "middle" }} /> 0%</>);
    const t0 = Date.now();
    try {
      const j = await uploadWithProgress("/api/analyses", fd, (loaded, total) => {
        const pct = Math.round((loaded / total) * 100);
        const rate = loaded / 1048576 / Math.max((Date.now() - t0) / 1000, 0.5);
        setNote(<>Uploading {mb.toFixed(1)} MB… <progress max="100" value={pct} style={{ width: 180, verticalAlign: "middle" }} />{" "}
          {`${pct}% · ${rate.toFixed(1)} MB/s${pct < 100 ? ` · ~${Math.max(1, Math.round((total - loaded) / 1048576 / rate))}s left` : " · starting analysis"}`}</>);
      });
      const poll = async () => {
        let a;
        try { a = await api(`/api/analyses/${j.id}`); } catch (e) { setBusy(false); setNote(""); toast(e.message, "err"); return; }
        if (a.status === "running") {
          const tot = a.total || 0, pct = tot ? Math.min(99, Math.round((a.progress / tot) * 100)) : 0;
          setNote(<>Analysing… <progress max="100" value={pct} style={{ width: 180, verticalAlign: "middle" }} /> frame {a.progress}{tot ? ` of ~${tot}` : ""}</>);
          pollTimer.current = setTimeout(poll, 1000); return;
        }
        setBusy(false);
        if (a.status === "failed") { setNote(""); toast(`Analysis failed: ${a.error}`, "err"); return; }
        setNote(summary(a)); setResult(a); reload();
      };
      poll();
    } catch (e) { setNote(""); setBusy(false); toast(e.message, "err"); }
  };

  const open = async (id) => {
    let a; try { a = await api(`/api/analyses/${id}`); } catch (e) { toast(e.message, "err"); return; }
    setNote(a.status === "done" ? summary(a) : a.status);
    setResult(a.status === "done" ? a : null);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const remove = async (id) => {
    if (!confirm("Delete this upload, its crops and results?")) return;
    await api(`/api/analyses/${id}`, { method: "DELETE" });
    reload();
  };

  return (
    <main id="view-upload" className="view">
      <div className="view-head"><div><h2>Upload &amp; recognise</h2><p>Footage that is not on any camera — a phone recording, WhatsApp clip, DVR export or photos: find every person and number plate in it, check them against the watchlist, and enrol a face straight from the video.</p></div></div>
      <div className="card">
        <form id="analysis-form" className="search-form" encType="multipart/form-data" onSubmit={run}>
          <label>Video / photos <input name="files" type="file" accept="video/*,image/*" multiple required /></label>
          <label>Note <input name="note" placeholder="e.g. WhatsApp video from complainant, 26 Sep" /></label>
          <label className="check"><input type="checkbox" name="plates" defaultChecked /> Read number plates too</label>
          <button className="btn primary" disabled={busy}>Upload &amp; analyse</button>
          <span className="muted small" id="analysis-note">{note}</span>
        </form>
        <p className="muted small" style={{ margin: "8px 0 0" }}>mp4 / mov / mkv / avi / webm or jpg / png, several files at once, up to 300 MB. Faces need to be roughly 40 px wide or more in the footage; the job samples 2 frames per second (max 7.5 min of video). Every upload and enrolment is audited.</p>
        <div ref={resultRef} id="analysis-result">{result && <AnalysisResult a={result} onChange={setResult} />}</div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="panel-head"><h3>Previous uploads</h3><button className="btn small ghost" id="upload-refresh" onClick={() => { setNote(""); setResult(null); reload(); }}>Refresh</button></div>
        <table className="table" id="upload-table"><thead><tr><th>When</th><th>Files</th><th>Note</th><th>Status</th><th>Persons</th><th>Plates</th><th /></tr></thead>
          <tbody>{rows && (rows.length ? rows.map((r) => (
            <tr key={r.id}><td>{fmtTime(r.created_at)}</td><td>{(r.files || []).join(", ")}</td><td>{r.note || ""}</td>
              <td>{r.status === "done" ? <span className="ok-chip">done</span> : r.status === "failed" ? <span className="bad-chip">failed</span> : <span className="muted">running…</span>}</td>
              <td>{r.persons ?? ""}</td><td>{r.plates ?? ""}</td>
              <td><button className="btn small" onClick={() => open(r.id)}>Open</button>{app.can("supervisor") && <> <button className="btn small danger" onClick={() => remove(r.id)}>Delete</button></>}</td></tr>))
            : <EmptyRow cols={7}>Nothing uploaded yet.</EmptyRow>)}</tbody></table>
      </div>
    </main>
  );
}

function AnalysisResult({ a, onChange }) {
  const app = useApp();
  const { toast } = useUI();
  const enrol = async (ev, c) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const r = await apiJson(`/api/analyses/${a.id}/enrol`, "POST", { cluster: c.cluster, name: f.name.value, category: f.category.value });
      toast(`${r.name} enrolled from the video (${r.embeddings} face samples). Face-enabled cameras start watching within 30 s.`, "ok");
      onChange(await api(`/api/analyses/${a.id}`));
    } catch (e) { toast(e.message, "err"); }
  };
  return <>
    {a.persons.length ? <div className="cards" style={{ marginTop: 12 }}>{a.persons.map((c) => (
      <div className="card" style={{ gap: 6 }} key={c.cluster}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {c.best_crop_url && <img src={withTok(c.best_crop_url)} alt="" style={{ height: 96, borderRadius: 6 }} />}
          <div><b>Person {c.rank}</b> <span className="muted small">seen {c.count}× · {c.first_t}s–{c.last_t}s · face {c.face_px}px</span>
            {c.match ? <div><span className="bad-chip">matches enrolled: {c.match.name} ({c.match.category}, {c.match.score})</span></div> : <div className="muted small">not in the persons of interest</div>}
            {c.enrolled_person_id && <div><span className="ok-chip">enrolled from this video</span></div>}</div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>{(c.crop_urls || []).slice(1).map((u) => <img key={u} src={withTok(u)} alt="" style={{ height: 44, borderRadius: 4 }} />)}</div>
        {app.has("watchlist") && !c.enrolled_person_id && <form className="search-form" onSubmit={(ev) => enrol(ev, c)}>
          <label>Name <input name="name" required placeholder="name / alias" /></label>
          <label>Category <select name="category"><option value="suspect">suspect</option><option value="wanted">wanted</option><option value="missing">missing</option><option value="other">other</option></select></label>
          <button className="btn small primary">Enrol &amp; watch on cameras</button></form>}
      </div>))}</div>
      : <p className="muted small" style={{ marginTop: 10 }}>No faces large enough (≥ 32 px) were found.</p>}
    {a.plates.length > 0 && <>
      <div className="panel-head" style={{ marginTop: 8 }}><h3>Plates in the footage</h3></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{a.plates.map((p) => (
        <span className="tick" key={p.plate}>{p.crop_url && <img src={withTok(p.crop_url)} alt="" />}<Plate plate={p.plate} /> <span className="muted">{p.count}× · {p.best_conf}</span></span>))}</div>
    </>}
  </>;
}
