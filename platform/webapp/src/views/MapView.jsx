import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { api } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { openRegEdit } from "./Registry.jsx";

const PALETTE = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#64748b", "#84cc16", "#06b6d4"];
const STATUS_COLOUR = { online: "#22c55e", live: "#22c55e", offline: "#ef4444", "not-integrated": "#64748b", registered: "#64748b", unknown: "#f59e0b", unlicensed: "#94a3b8" };
const FIXED = { Police: "#3b82f6", Municipal: "#22c55e", Transport: "#f59e0b", Corp8: "#a855f7" };

function colourer(key, cams) {
  if (key === "status") return { colour: (c) => STATUS_COLOUR[c.registry_only ? "not-integrated" : c.status] || "#f59e0b", legend: Object.entries(STATUS_COLOUR).filter(([k]) => k !== "live" && k !== "registered") };
  const vals = [...new Set(cams.map((c) => c[key] || "unspecified"))].sort();
  const m = Object.fromEntries(vals.map((v, i) => [v, FIXED[v] || PALETTE[i % PALETTE.length]]));
  return { colour: (c) => m[c[key] || "unspecified"], legend: Object.entries(m) };
}
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default function MapView({ intent }) {
  const app = useApp();
  const ui = useUI();
  const el = useRef(null);
  const M = useRef(null);            // { map, tiles, layer, gaps, marks }
  const [data, setData] = useState(null);
  const [opt, setOpt] = useState({ colour: "department", cones: true, registryOnly: true, gaps: !!intent?.gaps, tiles: true });
  const [legend, setLegend] = useState([]);
  const [nearest, setNearest] = useState(null);
  const fitted = useRef(false);
  const set = (k) => (e) => setOpt((o) => ({ ...o, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  // create the map once
  useEffect(() => {
    const map = L.map(el.current, { zoomControl: true });
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    M.current = { map, tiles, layer: L.layerGroup().addTo(map), gaps: L.layerGroup().addTo(map), marks: L.layerGroup().addTo(map) };
    const resize = () => setTimeout(() => map.invalidateSize(), 50);
    window.addEventListener("uvp-theme", resize);
    api("/api/map").then(setData).catch((e) => ui.toast(e.message, "err"));
    return () => { window.removeEventListener("uvp-theme", resize); map.remove(); M.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // click on the map -> nearest cameras to the incident
  useEffect(() => {
    const m = M.current; if (!m) return;
    const onClick = async (e) => {
      const { lat, lng: lon } = e.latlng;
      try {
        const r = await api(`/api/map/nearest?lat=${lat}&lon=${lon}&n=5`);
        m.marks.clearLayers();
        L.circleMarker([lat, lon], { radius: 7, color: "#ef4444", fillOpacity: 0.9 }).addTo(m.marks);
        setNearest({ lat, lon, cameras: r.cameras });
      } catch (x) { ui.toast(x.message, "err"); }
    };
    m.map.on("click", onClick);
    return () => m.map.off("click", onClick);
  }, [ui]);

  useEffect(() => { const m = M.current; if (!m) return; if (opt.tiles) m.tiles.addTo(m.map); else m.map.removeLayer(m.tiles); }, [opt.tiles]);

  // cameras + coverage cones
  useEffect(() => {
    const m = M.current; if (!m || !data) return;
    m.layer.clearLayers();
    const cams = data.cameras.filter((c) => opt.registryOnly || !c.registry_only);
    const { colour, legend: lg } = colourer(opt.colour, cams);
    setLegend(lg);
    const pts = [];
    cams.forEach((c) => {
      pts.push([c.lat, c.lon]);
      if (opt.cones) L.polygon(c.coverage, { color: colour(c), weight: 1, fillOpacity: c.registry_only ? 0.08 : 0.18, dashArray: c.registry_only ? "4 3" : null }).addTo(m.layer);
      const meta = [c.camera_type, c.ownership, c.connectivity].filter(Boolean).join(" · ");
      const popup = document.createElement("div");
      popup.innerHTML = `<b>${esc(c.name)}</b><br>${esc(c.department)} · ${c.registry_only ? "registry only (no feed)" : esc(c.status)}${c.anpr_enabled ? " · ANPR" : ""}${meta ? `<br>${esc(meta)}` : ""}${c.install_date ? `<br>installed ${esc(c.install_date)}` : ""}${c.maintenance_status && c.maintenance_status !== "ok" ? `<br>maintenance: <b>${esc(c.maintenance_status)}</b>` : ""}<br>heading ${c.heading ?? "–"}° · fov ${c.fov ?? "–"}° · ${c.range_m ?? "–"} m<br>`;
      const btn = (label, fn) => { const b = document.createElement("button"); b.className = "btn ghost small"; b.textContent = label; b.onclick = fn; popup.append(b, " "); };
      const reg = () => openRegEdit(ui, c.id, null, null, app.has("registry_edit"));
      if (c.registry_only) btn("Edit in registry", reg);
      else { btn("Add to wall", () => { app.go("wall"); window.dispatchEvent(new CustomEvent("uvp-add-to-wall", { detail: c.id })); }); btn("Registry", reg); }
      L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<div class="cam-pin" style="background:${colour(c)};${c.registry_only ? "border-style:dashed" : ""}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindPopup(popup).addTo(m.layer);
    });
    if (!fitted.current && pts.length) { m.map.fitBounds(pts, { padding: [40, 40] }); fitted.current = true; }
    else if (!fitted.current) m.map.setView([23.03, 72.58], 11);          // Ahmedabad until cameras have coordinates
    setTimeout(() => m.map.invalidateSize(), 50);
  }, [data, opt.colour, opt.cones, opt.registryOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // uncovered zones (gap analysis)
  useEffect(() => {
    const m = M.current; if (!m) return;
    m.gaps.clearLayers();
    if (!opt.gaps) return;
    let cancelled = false;
    api("/api/registry/gaps?cell_m=100").then((rep) => {
      if (cancelled || !M.current) return;
      const dlat = rep.cell_m / 111320, dlon = rep.cell_m / (111320 * Math.cos(((rep.bbox?.[0] ?? 23) * Math.PI) / 180));
      const cell = (g, colour, op, label) => L.rectangle([[g.lat - dlat / 2, g.lon - dlon / 2], [g.lat + dlat / 2, g.lon + dlon / 2]], { color: colour, weight: 0, fillOpacity: op })
        .bindTooltip(`${label} · nearest camera ${g.nearest_m ?? "?"} m (${esc(g.nearest_camera || "none")})`).addTo(m.gaps);
      (rep.blind_spots || []).forEach((g) => cell(g, "#ef4444", 0.45, "blind spot next to cameras"));
      rep.gaps.slice(0, 200).forEach((g) => cell(g, "#f59e0b", 0.25, "large uncovered zone"));
      ui.toast(`${rep.near_coverage_pct}% covered within 300 m of cameras · ${rep.near_uncovered} blind spots (red) · ${rep.uncovered} uncovered ${rep.cell_m} m cells in all (largest 200 in amber)`, "ok");
    }).catch((e) => ui.toast(e.message, "err"));
    return () => { cancelled = true; };
  }, [opt.gaps]); // eslint-disable-line react-hooks/exhaustive-deps

  const noCoords = data && !data.cameras.some((c) => opt.registryOnly || !c.registry_only);
  return (
    <main id="view-map" className="view">
      <div className="view-head"><div><h2>Map</h2><p>Camera positions and coverage cones; click the map to find the nearest cameras.</p></div></div>
      <div className="panel search-form" style={{ marginBottom: 12 }}>
        <span className="muted small">Every registered camera. Click anywhere on the map to find the nearest cameras to an incident.</span>
        <label className="small">Colour by <select id="map-colour" value={opt.colour} onChange={set("colour")}><option value="department">department</option><option value="camera_type">camera type</option><option value="status">health / status</option><option value="ownership">ownership</option><option value="connectivity">connectivity</option></select></label>
        <label className="check small"><input type="checkbox" id="map-cones" checked={opt.cones} onChange={set("cones")} /> Coverage cones</label>
        <label className="check small"><input type="checkbox" id="map-registry-only" checked={opt.registryOnly} onChange={set("registryOnly")} /> Registry-only cameras (no feed)</label>
        <label className="check small"><input type="checkbox" id="map-gaps" checked={opt.gaps} onChange={set("gaps")} /> Uncovered zones (gap analysis)</label>
        <label className="check small"><input type="checkbox" id="map-tiles" checked={opt.tiles} onChange={set("tiles")} /> Street map tiles (needs internet)</label>
        <span className="small" id="map-legend">{legend.map(([k, v]) => <span key={k} className="tagchip"><span className="cam-pin" style={{ background: v, display: "inline-block", width: 10, height: 10, marginRight: 4 }} />{k}</span>)}</span>
        <span className="small" id="map-nearest">
          {nearest ? <>Incident at {nearest.lat.toFixed(5)}, {nearest.lon.toFixed(5)}: {nearest.cameras.map((c) => (
            <span key={c.id || c.name} className={`tagchip ${c.covers_point ? "watchlist" : ""}`} title={c.covers_point ? "point is inside this camera's coverage" : "nearby but not covering the point"}>{c.name} {c.distance_m} m{c.covers_point ? " ✓" : ""}</span>))}</>
            : noCoords && <span className="bad-chip">No camera has coordinates yet — open <a href="#" onClick={(e) => { e.preventDefault(); app.go("registry"); }}>Registry</a>, Edit a camera and set latitude / longitude (or import a CSV with lat, lon).</span>}
        </span>
      </div>
      <div ref={el} id="gis-map" style={{ height: "calc(100vh - 170px)", borderRadius: 12, border: "1px solid var(--line)" }} />
    </main>
  );
}
