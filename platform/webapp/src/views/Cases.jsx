import { useEffect, useState } from "react";
import { api, apiJson, fmtTime, withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { EmptyRow, useLoad } from "../components/common.jsx";
import { playArchive } from "./Playback.jsx";

/** "+ Case" on search results / bookmarks: pick an open case and file the item. */
export async function addToCase(ui, kind, refId) {
  const cases = await api("/api/cases?status=open").catch((e) => { ui.toast(e.message, "err"); return null; });
  if (!cases) return;
  if (!cases.length) return ui.toast("No open cases: open one in the Cases tab first", "warn");
  ui.modal(<AddToCaseDialog cases={cases} kind={kind} refId={refId} />);
}
function AddToCaseDialog({ cases, kind, refId }) {
  const { toast, closeModal } = useUI();
  const submit = async (ev) => {
    ev.preventDefault();
    try { await apiJson(`/api/cases/${ev.target.case_id.value}/items`, "POST", { kind, ref_id: refId, note: ev.target.note.value }); closeModal(); toast("Filed into case", "ok"); }
    catch (e) { toast(e.message, "err"); }
  };
  return <><h3>File into case</h3>
    <form id="atc-form" className="search-form" onSubmit={submit}>
      <label>Case <select name="case_id">{cases.map((c) => <option key={c.id} value={c.id}>{`${c.number} · ${c.title}`}</option>)}</select></label>
      <label>Note <input name="note" placeholder="why this matters" /></label><button className="btn primary">Add</button>
    </form></>;
}

export default function Cases() {
  const { toast } = useUI();
  const [mine, setMine] = useState(false);
  const [sel, setSel] = useState(null);
  const [rows, reload] = useLoad(() => api(`/api/cases?mine=${mine}`), [mine]);

  const create = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const c = await apiJson("/api/cases", "POST", { title: f.title.value, reference: f.reference.value, priority: f.priority.value, owner: f.owner.value.trim() });
      f.reset(); setSel(c.id); reload(); toast(`${c.number} opened`, "ok");
    } catch (e) { toast(e.message, "err"); }
  };

  return (
    <main id="view-cases" className="view">
      <div className="view-head"><div><h2>Cases</h2><p>Investigations: sightings, clips, bookmarks and notes with a chain of custody.</p></div></div>
      <form id="case-form" className="panel search-form" onSubmit={create}>
        <label>New case title <input name="title" required placeholder="Hit and run, Ring Road" /></label>
        <label>Reference <input name="reference" placeholder="FIR / complaint no." /></label>
        <label>Priority <select name="priority" defaultValue="medium"><option>high</option><option>medium</option><option>low</option></select></label>
        <label>Assign to <input name="owner" placeholder="username (default: you)" /></label>
        <button className="btn primary">Open case</button>
        <label className="check small"><input type="checkbox" id="cases-mine" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my cases</label>
      </form>
      <div className="case-grid">
        <div className="panel"><div className="panel-head"><h3>Cases</h3></div>
          <table className="table" id="cases-table"><thead><tr><th>Number</th><th>Title</th><th>Ref</th><th>Priority</th><th>Owner</th><th>Items</th><th>Status</th><th>Updated (IST)</th></tr></thead>
            <tbody>{rows && (rows.length ? rows.map((c) => (
              <tr key={c.id} data-case={c.id} className={sel === c.id ? "sel" : ""} onClick={() => setSel(c.id)} style={{ cursor: "pointer" }}>
                <td><b>{c.number}</b></td><td>{c.title}</td><td>{c.reference}</td><td>{c.priority}</td><td>{c.owner}</td><td>{c.items}</td><td>{c.status}</td><td>{fmtTime(c.updated_at)}</td></tr>))
              : <EmptyRow cols={8}>No cases yet.</EmptyRow>)}</tbody></table></div>
        <div className="panel" id="case-detail">{sel ? <CaseDetail key={sel} id={sel} onChanged={reload} /> : <p className="muted">Select a case.</p>}</div>
      </div>
    </main>
  );
}

function CaseDetail({ id, onChanged }) {
  const app = useApp();
  const ui = useUI();
  const [c, setC] = useState(null);
  const load = () => api(`/api/cases/${id}`).then(setC).catch((e) => ui.toast(e.message, "err"));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <p className="muted">Loading…</p>;

  const patch = async (body) => { await apiJson(`/api/cases/${c.id}`, "PATCH", body); onChanged(); load(); };
  const addNote = async (ev) => {
    ev.preventDefault();
    try { await apiJson(`/api/cases/${c.id}/items`, "POST", { kind: "note", note: ev.target.note.value }); ev.target.reset(); load(); onChanged(); }
    catch (e) { ui.toast(e.message, "err"); }
  };
  const rm = async (itemId) => { await api(`/api/cases/${c.id}/items/${itemId}`, { method: "DELETE" }); load(); onChanged(); };
  const del = (it) => <button className="btn ghost small" onClick={() => rm(it.id)}>✕</button>;

  const item = (it) => {
    const m = it.meta || {};
    if (it.kind === "event") return <li key={it.id}><img src={withTok(m.crop_url)} alt="" /><div><b>{m.plate}</b> · {m.camera_name} · {fmtTime(m.ts)}{it.note && <><br /><span className="small muted">{it.note}</span></>}</div>
      <span>{m.play_url && <><button className="btn ghost small" onClick={() => playArchive(ui, m.play_url, m.plate)}>Clip</button> </>}{del(it)}</span></li>;
    if (it.kind === "note") return <li key={it.id}><span className="tagchip">note</span><div>{it.note}<br /><span className="small muted">{it.added_by} · {fmtTime(it.added_at)}</span></div>{del(it)}</li>;
    const label = it.kind === "stitch" ? `Stitched timeline ${m.plate} (${m.segments} clips)` : it.kind === "bookmark" ? `Bookmark: ${m.label} · ${m.camera_id} · ${fmtTime(m.ts)}` : `Recording ${m.camera_id} · ${fmtTime(m.start)}`;
    return <li key={it.id}><span className="tagchip">{it.kind}</span><div>{label}{it.note && <><br /><span className="small muted">{it.note}</span></>}</div>
      <span>{m.play_url && <><button className="btn ghost small" onClick={() => playArchive(ui, m.play_url, label)}>Play</button> </>}{del(it)}</span></li>;
  };

  return <>
    <div className="panel-head"><h3>{c.number} · {c.title}</h3><span>
      {app.has("export") && <><a className="btn ghost small" href={withTok(`/api/cases/${c.id}/export`)} title="report.pdf + watermarked media + signed manifest">Export bundle</a> </>}
      <button className="btn ghost small" onClick={() => patch({ status: c.status === "open" ? "closed" : "open" })}>{c.status === "open" ? "Close case" : "Reopen"}</button></span></div>
    <p className="small muted">Ref {c.reference || "-"} · {c.priority} · {c.department || "-"} · owner <b>{c.owner}</b> · opened by {c.created_by} {fmtTime(c.created_at)} · {c.status}</p>
    <form id="case-assign" className="search-form" onSubmit={(ev) => { ev.preventDefault(); patch({ owner: ev.target.owner.value.trim(), priority: ev.target.priority.value }); }}>
      <label>Assign to <input name="owner" defaultValue={c.owner} /></label>
      <label>Priority <select name="priority" defaultValue={c.priority}>{["high", "medium", "low"].map((p) => <option key={p}>{p}</option>)}</select></label>
      <button className="btn ghost small">Save</button></form>
    <h4>Evidence ({c.items.length})</h4>
    <ul className="case-items">{c.items.length ? c.items.map(item) : <li className="muted">Nothing filed yet. Use "+ Case" on search results and bookmarks, or "Stitch clips" in Vehicle movement.</li>}</ul>
    <form id="case-note" className="search-form" onSubmit={addNote}><label style={{ flex: 1 }}>Note <input name="note" required placeholder="investigation note" /></label><button className="btn ghost small">Add note</button></form>
    <h4>Chain of custody <span className={`${c.custody_chain.ok ? "ok-chip" : "bad-chip"} small`}>{c.custody_chain.ok ? "✓ intact" : "✗ broken"}</span></h4>
    <div className="custody">{c.custody.map((x, i) => <div key={i}>{fmtTime(x.ts)} · <b>{x.action}</b> · {x.user} · {x.detail}{x.sha256 ? ` · sha256 ${x.sha256.slice(0, 12)}…` : ""}</div>)}</div>
  </>;
}
