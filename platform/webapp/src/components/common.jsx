import { useCallback, useEffect, useRef, useState } from "react";
import { withTok } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";

export const Kpi = ({ l, v, cls = "" }) => <div className={`kpi ${cls}`}><div className="v">{v}</div><div className="l">{l}</div></div>;
export const Chip = ({ ok, children, className = "" }) => <span className={`${ok ? "ok-chip" : "bad-chip"} ${className}`}>{children}</span>;
export const CheckChip = ({ ok, children }) => <Chip ok={ok}>{ok ? "✓" : "✗"} {children}</Chip>;
export const EmptyRow = ({ cols, children }) => <tr><td colSpan={cols} className="muted">{children}</td></tr>;
export const Dept = ({ d, className = "" }) => <span className={`dept-${d} ${className}`}>{d}</span>;

/** Number plate chip; click traces the vehicle unless masked or trace=false. */
export function Plate({ plate, masked, trace = true }) {
  const { traceVehicle } = useApp();
  const click = trace && !masked;
  return <span className={`platebox plate${masked ? " masked" : ""}`} title={masked ? "Plate masked: your role has no plate_search" : undefined}
    onClick={click ? () => traceVehicle(plate) : undefined} style={click ? { cursor: "pointer" } : undefined}>{plate}</span>;
}

/** Evidence crop; click opens the full frame. */
export function Crop({ src, frame, className = "crop", style }) {
  const { modal } = useUI();
  if (!src) return null;
  return <img className={className} style={{ ...style, ...(frame ? { cursor: "zoom-in" } : {}) }} src={withTok(src)} alt=""
    onClick={frame ? () => modal(<img src={withTok(frame)} alt="Evidence frame" />) : undefined} />;
}

export function AlertToast({ a, camName }) {
  return <>
    {a.crop_url ? <img src={withTok(a.crop_url)} alt="" /> : <span />}
    <div><b>{a.match === "rule" ? "Challan suggested" : "Watchlist hit"}: <span className="plate">{a.plate}</span></b>
      <div className="small muted">{camName} · {a.department}{a.match === "fuzzy" ? ` · fuzzy match of ${a.watchlist_plate}` : ""}</div>
      <div className="small">{a.reason || ""}</div></div>
  </>;
}

/** Bar chart of reads per minute. */
export function RateChart({ pm }) {
  const keys = Object.keys(pm || {});
  if (!keys.length) return <p className="muted">No reads in the last hour.</p>;
  const W = 900, H = 150, P = 24, max = Math.max(...Object.values(pm), 1), bw = (W - P) / keys.length;
  return <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
    {keys.map((k, i) => { const h = (pm[k] / max) * (H - P - 6); return <rect key={k} x={P + i * bw + 1} y={H - P - h} width={Math.max(bw - 2, 1)} height={h} fill="#3b82f6" rx="2"><title>{`${k} IST: ${pm[k]} reads`}</title></rect>; })}
    <text x={P} y={H - 6} fill="#8b98a8" fontSize="11">{keys[0]}</text>
    <text x={W - 4} y={H - 6} fill="#8b98a8" fontSize="11" textAnchor="end">{keys[keys.length - 1]}</text>
    <text x="2" y="12" fill="#8b98a8" fontSize="11">{max}</text>
  </svg>;
}

export function Spark({ points, idx, colour, max }) {
  if (!points.length) return null;
  const w = 120, h = 26, n = points.length, m = Math.max(1, max);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, n - 1)) * w},${h - (Math.min(p[idx], m) / m) * (h - 2) - 1}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ verticalAlign: "middle" }}><path d={d} fill="none" stroke={colour} strokeWidth="1.6" /></svg>;
}

export function ViewHead({ title, children, quick }) {
  return <div className="view-head"><div><h2>{title}</h2><p>{children}</p></div>{quick && <div className="quick">{quick}</div>}</div>;
}

/**
 * Load data for a view: returns [data, reload, setData]. Errors are toasted. Re-runs when deps change
 * and after the server comes back from an outage.
 */
export function useLoad(fn, deps = [], initial = null) {
  const { toast } = useUI();
  const { reconnect } = useApp();
  const [data, setData] = useState(initial);
  const fnRef = useRef(fn); fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    try { const d = await fnRef.current(); if (alive.current) setData(d); return d; }
    catch (e) { if (alive.current) toast(e.message, "err"); }
  }, [toast]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [...deps, reconnect]);
  return [data, reload, setData];
}

/** Read a <form> into a plain object (checkboxes -> boolean). */
export function formData(form) {
  const o = {};
  [...form.elements].forEach((el) => { if (!el.name) return; o[el.name] = el.type === "checkbox" ? el.checked : el.value; });
  return o;
}

/** Wrap an async handler: prevents default, toasts errors. */
export function useAction() {
  const { toast } = useUI();
  return useCallback((fn) => async (ev) => {
    ev?.preventDefault?.();
    try { await fn(ev); } catch (e) { toast(e.message, "err"); }
  }, [toast]);
}
