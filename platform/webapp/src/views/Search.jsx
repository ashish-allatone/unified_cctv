import { useEffect, useRef, useState } from "react";
import { api, apiJson, fmtTime, toIso, withTok } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { Crop, Dept, EmptyRow, Kpi, Plate, RateChart, useLoad } from "../components/common.jsx";
import { addToCase } from "./Cases.jsx";
import { openClip } from "./Playback.jsx";

const TAGS = ["watchlist", "low_confidence", "invalid_format", "night_movement", "after_hours_depot", "night", "non_standard_plate", "challan_suggested", "wrong_way", "over_speed", "triple_riding", "no_helmet"];
const HOT = ["watchlist", "challan_suggested", "over_speed", "wrong_way", "red_light", "triple_riding", "no_helmet"];
const COLOURS = ["white", "silver", "grey", "black", "red", "blue", "yellow", "green", "orange", "brown"];
export const visibleTags = (tags) => (tags || []).filter((x) => !/^(type|colour|plate):/.test(x));

export default function Search({ intent }) {
  const app = useApp();
  const { t } = useI18n();
  const ui = useUI();
  const form = useRef(null);
  const [res, setRes] = useState(null);
  const [st] = useLoad(() => api("/api/stats?hours=24"));

  const run = async (ev) => {
    ev?.preventDefault();
    const f = form.current;
    const p = new URLSearchParams({ plate: f.plate.value.trim(), fuzzy: f.fuzzy.checked, camera: f.camera.value, tag: f.tag.value, vehicle_type: f.vehicle_type.value, colour: f.colour.value, limit: 300 });
    if (f.since.value) p.set("since", toIso(f.since.value));
    if (f.until.value) p.set("until", toIso(f.until.value));
    try {
      const r = await api(`/api/events?${p}`);
      setRes({ ...r, filtered: !!(f.plate.value || f.camera.value || f.tag.value) });
    } catch (e) { ui.toast(e.message, "err"); }
  };
  // "ANPR history" from a wall tile arrives as an intent with the camera preselected
  useEffect(() => {
    if (intent?.camera) { form.current.camera.value = intent.camera; form.current.plate.value = ""; }
    run();
  }, [intent?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = () => {
    // server-side export: signed manifest + Ed25519 signature travel with the CSV, and the export is audited
    const f = form.current;
    const p = new URLSearchParams({ plate: f.plate.value.trim(), camera: f.camera.value, tag: f.tag.value });
    if (f.since.value) p.set("since", toIso(f.since.value));
    if (f.until.value) p.set("until", toIso(f.until.value));
    location.href = withTok(`/api/events/export.csv?${p}`);
  };

  return (
    <main id="view-search" className="view">
      <div className="view-head"><div><h2>ANPR search</h2><p>Every plate read across all departments: search, filter, export a signed CSV.</p></div></div>
      {st && <div className="kpis" id="kpis">{[["ANPR reads (24 h)", st.events], ["Unique plates", st.unique_plates], ["Open alerts", st.alerts_open], ["Watchlist", st.watchlist], ["Cameras online", `${st.cameras_online}/${st.cameras}`], ["ANPR cameras", st.anpr_cameras]].map(([l, v]) => <Kpi key={l} l={l} v={v} />)}</div>}
      <div className="panel">
        <div className="panel-head"><h3>ANPR reads per minute (last hour, IST)</h3><span className="muted small" id="backend-note">{app.cfg ? `search backend: ${app.cfg.search_backend} · bus: ${app.cfg.bus}` : ""}</span></div>
        <div className="chart" id="rate-chart">{st && <RateChart pm={st.per_minute} />}</div>
      </div>
      <form ref={form} id="search-form" className="panel search-form" onSubmit={run}>
        <label><span>{t("search.plate", "Plate")}</span> <input name="plate" placeholder="MH12AB1234, MH12*, *1234" aria-label="Plate" /></label>
        <label className="check"><input type="checkbox" name="fuzzy" /> Fuzzy (1 character off)</label>
        <label>Camera <select name="camera" defaultValue={intent?.camera || ""}><option value="">All cameras</option>{app.cameras.map((c) => <option key={c.id} value={c.id}>{`${c.name} (${c.department})`}</option>)}</select></label>
        <label>Tag <select name="tag"><option value="">Any tag</option>{TAGS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>Vehicle <select name="vehicle_type"><option value="">Any type</option><option value="car">car</option><option value="two_wheeler">two-wheeler</option><option value="bus">bus</option><option value="truck">truck</option><option value="light_vehicle">light vehicle</option></select></label>
        <label>Colour <select name="colour"><option value="">Any colour</option>{COLOURS.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label>From <input type="datetime-local" name="since" /></label>
        <label>To <input type="datetime-local" name="until" /></label>
        <button className="btn primary">{t("btn.search", "Search")}</button>
        {app.has("export") && <button type="button" id="export-csv" className="btn ghost" title="Signed CSV (zip with manifest + signature)" onClick={exportCsv}>{t("btn.export", "Export signed CSV")}</button>}
      </form>
      <div className="panel">
        <div className="panel-head"><h3 id="result-title">{res?.filtered ? `${res.count} matching vehicle records` : t("result.latest", "Latest vehicle records")}</h3></div>
        <table className="table" id="results"><thead><tr>
          <th>{t("th.time", "Time (IST)")}</th><th>{t("th.plate", "Plate")}</th><th>{t("th.crop", "Crop")}</th><th>{t("th.camera", "Camera")}</th><th>{t("th.department", "Department")}</th>
          <th>{t("th.confidence", "Confidence")}</th><th>{t("th.reads", "Reads")}</th><th>{t("th.direction", "Direction")}</th><th>{t("th.vehicle", "Vehicle")}</th><th>{t("th.tags", "Tags")}</th><th /></tr></thead>
          <tbody>{res && (res.events.length ? res.events.map((e) => (
            <tr key={e.id}>
              <td>{fmtTime(e.ts)}</td><td><Plate plate={e.plate} masked={e.plate_masked} /></td>
              <td><Crop src={e.crop_url} frame={e.frame_url} /></td>
              <td>{app.camName(e.camera_id)}</td><td><Dept d={e.department} /></td>
              <td>{Math.round(e.confidence * 100)}%</td><td>{e.reads}</td><td>{e.direction}</td>
              <td className="small">{[e.vehicle_colour, (e.vehicle_type || "").replace("_", " "), e.plate_colour && e.plate_colour !== "white" ? `${e.plate_colour} plate` : "", e.make_model].filter(Boolean).join(" · ")}</td>
              <td>{visibleTags(e.tags).map((x) => <span key={x} className={`tagchip ${HOT.includes(x) ? "watchlist" : ""}`}>{x}</span>)}</td>
              <td>
                <button type="button" className="btn ghost small" data-clip={e.id} onClick={() => openClip(ui, app, e.id)}>{t("btn.clip", "Clip")}</button>
                {app.has("export") && <> <a className="btn ghost small" href={withTok(`/api/events/${e.id}/export`)} title="Signed, watermarked evidence bundle (zip)">{t("btn.evidence", "Evidence")}</a></>}
                {app.has("cases") && <> <button type="button" className="btn ghost small" data-case-add={e.id} title="File this sighting into a case" onClick={() => addToCase(ui, "event", e.id)}>{t("btn.case", "+ Case")}</button></>}
                {app.has("plate_search") && !e.plate_masked && <> <button type="button" className="btn ghost small" data-fix={e.id} title="Confirm or correct this read" onClick={() => ui.modal(<ReviewDialog eid={e.id} plate={e.plate} after={run} />)}>{t("btn.fix", "Fix plate")}</button></>}
              </td>
            </tr>)) : <EmptyRow cols={11}>No records.</EmptyRow>)}</tbody>
        </table>
      </div>
    </main>
  );
}

export function ReviewDialog({ eid, plate, after }) {
  const { t } = useI18n();
  const { toast, closeModal } = useUI();
  const submit = async (ev) => {
    ev.preventDefault(); const f = ev.target;
    try {
      const r = await apiJson(`/api/events/${eid}/review`, "POST", { verdict: f.verdict.value, true_plate: f.true_plate.value, reason: f.reason.value });
      closeModal(); toast(`Saved: ${r.verdict}${r.verdict === "corrected" ? " → " + r.plate : ""}`, "ok"); after?.();
    } catch (e) { toast(e.message, "err"); }
  };
  return <><h3>Review read <span className="platebox plate">{plate}</span></h3>
    <form id="rv-form" className="search-form" onSubmit={submit}>
      <label>Verdict <select name="verdict"><option value="confirmed">{t("review.confirm", "Confirm")}: read correctly</option><option value="corrected">{t("review.correct", "Correct")} to…</option><option value="unreadable">{t("review.unreadable", "Unreadable")}</option></select></label>
      <label>Correct plate <input name="true_plate" placeholder="MP04ZR7493" autoCapitalize="characters" /></label>
      <label>Reason <select name="reason"><option value="">–</option>{["two_line", "night", "dirty", "decorative_font", "occluded", "angle", "motion_blur", "other"].map((x) => <option key={x}>{x}</option>)}</select></label>
      <button className="btn primary">Save</button>
    </form></>;
}
