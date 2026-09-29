import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiJson, store, withTok } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { drawDets, Player } from "../lib/player.js";
import { useApp } from "../context/AppContext.jsx";

const GRID_N = { "1x1": 1, "2x2": 4, "3x3": 9, "4x4": 16, "1+5": 6 };
const GRIDS = [["1x1", "1"], ["2x2", "2×2"], ["3x3", "3×3"], ["4x4", "4×4"], ["1+5", "1+5"]];
const fit = (cams, grid) => Array.from({ length: GRID_N[grid] }, (_, i) => cams[i] || null);

function initialWall(cameras, camById) {
  let w = null; try { w = JSON.parse(store.get("uvp-wall")); } catch (_) {}
  if (w && w.cams?.some(Boolean)) {
    const grid = GRID_N[w.grid] ? w.grid : "2x2";
    return { grid, cams: fit(w.cams.map((id) => (id && camById[id] ? id : null)), grid) };
  }
  // first run: one or two cameras from each department side by side
  const pick = [...new Set(cameras.map((c) => c.department))].flatMap((d) => cameras.filter((c) => c.department === d).slice(0, 2));
  return { grid: "2x2", cams: fit(pick.slice(0, 4).map((c) => c.id), "2x2") };
}

export default function Wall({ hidden }) {
  const app = useApp();
  const { t } = useI18n();
  const { toast, modal } = useUI();
  const [wall, setWall] = useState(() => initialWall(app.cameras, app.camById));
  const [profiles, setProfiles] = useState({});        // tile index -> "main" when switched to Full HD
  const [filter, setFilter] = useState("");
  const [showDets, setShowDets] = useState(true);
  const [layouts, setLayouts] = useState({});
  const [ticks, setTicks] = useState([]);

  // persist + header count
  useEffect(() => {
    store.set("uvp-wall", JSON.stringify(wall));
    app.setWallCount(wall.cams.filter(Boolean).length);
  }, [wall]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLayouts = () => api("/api/layouts").then(setLayouts).catch(() => {});
  useEffect(() => { loadLayouts(); }, []);

  // live ANPR ticker
  useEffect(() => {
    const add = (hit) => (ev) => setTicks((l) => [{ ...ev, hit, key: `${Date.now()}-${Math.random()}` }, ...l].slice(0, 25));
    const a = app.subscribe("event", add(false)), b = app.subscribe("alert", add(true));
    return () => { a(); b(); };
  }, [app.subscribe]); // eslint-disable-line react-hooks/exhaustive-deps

  const setGrid = (grid) => { setWall((w) => ({ grid, cams: fit(w.cams, grid) })); setProfiles({}); };
  const setTile = (i, id) => { setWall((w) => { const cams = [...w.cams]; cams[i] = id; return { ...w, cams }; }); setProfiles((p) => ({ ...p, [i]: "sub" })); };
  const addToWall = (id) => {
    if (wall.cams.includes(id)) return toast(`${app.camName(id)} is already on the wall`);
    const free = wall.cams.indexOf(null);
    setTile(free >= 0 ? free : wall.cams.length - 1, id);
  };
  // "Add to wall" from a map popup
  const addRef = useRef(addToWall); addRef.current = addToWall;
  useEffect(() => {
    const h = (e) => addRef.current(e.detail);
    window.addEventListener("uvp-add-to-wall", h);
    return () => window.removeEventListener("uvp-add-to-wall", h);
  }, []);
  const applyLayout = (name) => {
    const l = layouts[name]; if (!l) return;
    setWall({ grid: l.grid, cams: fit((l.cameras || []).map((id) => (id && app.camById[id] ? id : null)), l.grid) }); setProfiles({});
  };
  const saveLayout = async () => {
    const name = prompt("Layout name (e.g. Ring Road)"); if (!name) return;
    await apiJson(`/api/layouts/${encodeURIComponent(name)}`, "PUT", { grid: wall.grid, cameras: wall.cams });
    toast(`Layout "${name}" saved`, "ok"); loadLayouts();
  };

  const tileAction = (i, a) => {
    const id = wall.cams[i], c = app.camById[id];
    if (a === "close") { setTile(i, null); return; }
    if (a === "max") { setProfiles((p) => ({ ...p, [i]: p[i] === "main" ? "sub" : "main" })); return; }
    if (a === "tag") return modal(<TagDialog c={c} />);
    if (a === "bookmark") return quickBookmark(c);
    if (a === "hist") return app.go("search", { camera: id });
  };
  const quickBookmark = async (c) => {
    try {
      const b = await apiJson("/api/bookmarks", "POST", { camera_id: c.id, label: "Marked from the wall", before_s: 10, after_s: 10 });
      toast(`Bookmarked ${c.name}; the clip is cut in ~20 s (Playback → Bookmarks)`, "ok");
      setTimeout(() => api(`/api/bookmarks/${b.id}/cut`, { method: "POST" }).catch(() => {}), 20000);
    } catch (e) { toast(e.message, "err"); }
  };

  const tree = useMemo(() => {
    const q = filter.toLowerCase(), byDept = {};
    app.cameras.filter((c) => !q || `${c.name} ${c.id} ${c.department}`.toLowerCase().includes(q)).forEach((c) => (byDept[c.department] ||= []).push(c));
    return Object.entries(byDept);
  }, [app.cameras, filter]);
  const onWall = wall.cams.filter(Boolean);
  const depts = new Set(onWall.map((id) => app.camById[id]?.department));

  return (
    <main id="view-wall" className={`view wall-view${hidden ? " hidden" : ""}`} aria-label="Video wall">
      <aside className="cam-list">
        <input id="cam-filter" placeholder={t("wall.filter", "Filter cameras…")} aria-label="Filter cameras" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div id="cam-tree">
          {tree.length ? tree.map(([d, cams]) => (
            <div className="dept" key={d}><h4><span className={`dept-${d}`}>{d}</span><span className="muted">{cams.length}</span></h4>
              {cams.map((c) => (
                <div key={c.id} className="cam" data-cam={c.id} draggable title={`${c.id} · ${c.status}`} onClick={() => addToWall(c.id)}
                  onDragStart={(e) => e.dataTransfer.setData("text/cam", c.id)}>
                  <span className={`dot ${c.status}`} /><span className="name">{c.name}</span>
                  {c.anpr_enabled && <span className="tagchip anpr">ANPR</span>}
                </div>))}
            </div>)) : <p className="muted">No cameras visible for your role yet.</p>}
        </div>
        <p className="muted small hint">{t("wall.hint", "Click a camera to add it to the wall, or drag it onto a tile.")}</p>
      </aside>
      <section className="wall-main">
        <div className="wall-toolbar">
          <div className="seg" id="grid-select">{GRIDS.map(([g, l]) => <button key={g} data-grid={g} className={wall.grid === g ? "active" : ""} onClick={() => setGrid(g)}>{l}</button>)}</div>
          <select id="layout-select" value="" onChange={(e) => applyLayout(e.target.value)}>
            <option value="">Saved layouts…</option>{Object.keys(layouts).map((k) => <option key={k}>{k}</option>)}
          </select>
          {app.has("live") && <button id="layout-save" className="btn ghost small" onClick={saveLayout}>Save layout</button>}
          <button id="wall-clear" className="btn ghost small" onClick={() => { setWall((w) => ({ ...w, cams: w.cams.map(() => null) })); setProfiles({}); }}>Clear</button>
          <label className="small muted" title="Draw the analytics / ANPR detections over the live tiles"><input type="checkbox" id="dets-toggle" checked={showDets} onChange={(e) => setShowDets(e.target.checked)} /> Detections</label>
          <span className="spacer" />
          <span className="muted small" id="wall-info">{onWall.length ? `${onWall.length} feeds from ${depts.size} department${depts.size > 1 ? "s" : ""}` : ""}</span>
        </div>
        <div id="wall" className={`wall g-${wall.grid.replace("+", "p")}`}>
          {wall.cams.map((id, i) => (
            <Tile key={i} cam={id ? app.camById[id] : null} profile={profiles[i] || "sub"} showDets={showDets}
              onDropCam={(cid) => setTile(i, cid)} onAction={(a) => tileAction(i, a)} />))}
        </div>
        <div className="ticker"><span className="ticker-label">Live ANPR</span>
          <div id="ticker-items">
            {ticks.map((ev) => (
              <div key={ev.key} className={`tick${ev.hit ? " hit" : ""}`} onClick={() => app.traceVehicle(ev.plate)}>
                {ev.crop_url && <img src={withTok(ev.crop_url)} alt="" />}
                <span><span className="plate">{ev.plate}</span><br /><span className="muted">{app.camName(ev.camera_id)}</span></span>
              </div>))}
          </div>
        </div>
      </section>
    </main>
  );
}

function Tile({ cam, profile, showDets, onDropCam, onAction }) {
  const app = useApp();
  const [drop, setDrop] = useState(false);
  const [state, setState] = useState("connecting…");
  const [flash, setFlash] = useState(0);
  const [badge, setBadge] = useState("");
  const el = useRef(null), video = useRef(null), canvas = useRef(null);
  const camId = cam?.id;

  // (re)start the player when the camera, profile or server connection changes
  useEffect(() => {
    if (!cam || !app.cfg) return;
    setState("connecting…");
    const p = new Player({ video: video.current, cam, profile, cfg: app.cfg, onState: setState });
    p.play();
    return () => p.stop();
  }, [camId, profile, app.cfg, app.reconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // detection overlay + alert flash
  useEffect(() => {
    if (!camId) return;
    let clear;
    const offD = app.subscribe("dets", (m) => {
      if (m.camera_id !== camId || !showDets || !canvas.current) return;
      setBadge(drawDets(el.current, canvas.current, video.current, m));
      clearTimeout(clear);
      clear = setTimeout(() => { const c = canvas.current; c?.getContext("2d").clearRect(0, 0, c.width, c.height); setBadge(""); }, 2500);
    });
    const offA = app.subscribe("alert", (a) => { if (a.camera_id === camId) setFlash(Date.now()); });
    return () => { offD(); offA(); clearTimeout(clear); };
  }, [camId, showDets, app.subscribe]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showDets && canvas.current) { canvas.current.getContext("2d").clearRect(0, 0, canvas.current.width, canvas.current.height); setBadge(""); }
  }, [showDets]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(0), 3200); return () => clearTimeout(t); }, [flash]);

  const snapshot = () => {
    const v = video.current, cv = document.createElement("canvas");
    cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext("2d").drawImage(v, 0, 0);
    const a = document.createElement("a"); a.download = `${camId}_${Date.now()}.jpg`; a.href = cv.toDataURL("image/jpeg", 0.9); a.click();
  };

  return (
    <div ref={el} className={`tile${drop ? " drop" : ""}${cam && profile === "main" ? " max" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }} onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); const id = e.dataTransfer.getData("text/cam"); if (id) onDropCam(id); }}>
      {cam ? <>
        <video ref={video} muted autoPlay playsInline />
        <canvas ref={canvas} className="dets" />
        <span className={`detcount${badge ? "" : " hidden"}`}>{badge}</span>
        <div className="ov"><span className="dot live" /><span className="t"><b>{cam.name}</b></span>
          <span className={`tagchip dept-${cam.department}`}>{cam.department}</span>{cam.anpr_enabled && <span className="tagchip anpr">ANPR</span>}</div>
        <div className="state">{state}</div>
        <div className="acts">
          <button data-a="max" onClick={() => onAction("max")}>{profile === "main" ? "Exit full" : "Full HD"}</button>
          <button data-a="snap" onClick={snapshot}>Snapshot</button>
          {app.has("playback") && <button data-a="bookmark" title="Keep the last 10 s and next 10 s as a clip" onClick={() => onAction("bookmark")}>Bookmark</button>}
          {app.can("analyst") && <><button data-a="tag" onClick={() => onAction("tag")}>Tag event</button><button data-a="hist" onClick={() => onAction("hist")}>ANPR history</button></>}
          <button data-a="close" onClick={() => onAction("close")}>✕</button>
        </div>
        {flash > 0 && <div className="flash" />}
      </> : <div className="empty">Drop a camera here</div>}
    </div>
  );
}

function TagDialog({ c }) {
  const { toast, closeModal } = useUI();
  const submit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await apiJson("/api/tags", "POST", { camera_id: c.id, tag: f.tag.value, note: f.note.value }); closeModal(); toast(`Tagged "${f.tag.value}" on ${c.name}`, "ok"); }
    catch (x) { toast(x.message, "err"); }
  };
  return <><h3>Tag event on {c.name}</h3>
    <form id="tag-form" className="search-form" onSubmit={submit}>
      <label>Tag <select name="tag">{["accident", "crowd", "traffic_jam", "suspicious_vehicle", "fire", "other"].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>Note <input name="note" size={40} /></label><button className="btn primary">Save tag</button>
    </form></>;
}
