import { useState } from "react";
import { api, apiJson, fmtTime, withTok } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { useUI } from "../lib/ui.jsx";
import { useApp } from "../context/AppContext.jsx";
import { Crop, EmptyRow, Plate, useLoad } from "../components/common.jsx";
import { ReviewDialog, visibleTags } from "./Search.jsx";

export default function Violations() {
  const app = useApp();
  const [stats, reloadStats] = useLoad(async () => {
    const [st, offs] = await Promise.all([api("/api/incidents/stats?hours=24"), api("/api/offences")]);
    return { st, offs };
  });
  const [bump, setBump] = useState(0);   // refresh the report after a review
  const refreshReports = () => setBump((n) => n + 1);

  return (
    <main id="view-violations" className="view">
      <div className="view-head"><div><h2>Violations &amp; analytics</h2><p>Challans, plate review, ANPR accuracy, traffic counts and zone incidents.</p></div></div>
      {stats && <div className="cards" id="viol-cards">
        <div className="card"><b>Incidents, last 24 h</b><div className="kv">{Object.keys(stats.st.incidents).length ? Object.entries(stats.st.incidents).map(([k, n]) => <Kv key={k} k={k.replace(/_/g, " ")} v={<b>{n}</b>} />) : <><span className="muted">none in 24 h</span><span /></>}</div></div>
        <div className="card"><b>Challans</b><div className="kv">{Object.keys(stats.st.challans).length ? Object.entries(stats.st.challans).map(([k, n]) => <Kv key={k} k={k} v={<b>{n}</b>} />) : <><span className="muted">none</span><span /></>}</div></div>
        <div className="card"><b>Offence schedule</b><div className="kv">{Object.entries(stats.offs).map(([k, o]) => <Kv key={k} k={o.label} v={<b>Rs {o.fine_inr} / {o.repeat_inr}</b>} />)}</div></div>
      </div>}
      <Challans onChange={reloadStats} />
      {app.has("plate_search") && <ReviewQueue onReviewed={refreshReports} />}
      <Report bump={bump} />
      <Traffic />
      <Incidents />
    </main>
  );
}
const Kv = ({ k, v }) => <><span>{k}</span>{v}</>;

function Challans({ onChange }) {
  const app = useApp();
  const { toast } = useUI();
  const [status, setStatus] = useState("draft");
  const [rows, reload] = useLoad(() => api(`/api/challans?status=${status}`), [status]);
  const canReview = app.has("alerts_ack");
  const review = async (id, action) => {
    const remarks = prompt(action === "approve" ? "Approve and send to e-challan. Remarks (optional):" : "Reject. Reason:");
    if (remarks === null) return;
    try {
      const r = await apiJson(`/api/challans/${id}/review`, "POST", { action, remarks });
      toast(`${r.number}: ${r.status}${r.external_ref ? " · " + r.external_ref : ""}`, r.status === "failed" ? "err" : "ok");
      reload(); onChange();
    } catch (e) { toast(e.message, "err"); }
  };
  return (
    <div className="panel">
      <div className="panel-head"><h3>Challans</h3><span><select className="small" id="ch-status" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="draft">draft (to review)</option><option value="approved">approved</option><option value="sent">sent</option><option value="failed">failed</option><option value="rejected">rejected</option><option value="all">all</option></select></span></div>
      <table className="table" id="ch-table"><thead><tr><th>Number</th><th>When (IST)</th><th>Plate</th><th>Offence</th><th>Section</th><th>Fine</th><th>Camera</th><th>Evidence</th><th>Status</th><th /></tr></thead>
        <tbody>{rows && (rows.length ? rows.map((c) => (
          <tr key={c.id}><td><b>{c.number}</b>{c.repeat && <> <span className="tagchip watchlist">repeat</span></>}</td><td>{fmtTime(c.ts)}</td>
            <td><Plate plate={c.plate} masked={c.plate_masked} /></td><td>{c.label}</td><td className="small">{c.section}</td><td>Rs {c.fine_inr}</td>
            <td>{app.camName(c.camera_id)}</td><td><Crop src={c.crop_url || c.frame_url} frame={c.frame_url} /></td>
            <td>{c.status}{c.external_ref && <><br /><span className="small muted">{c.external_ref}</span></>}{c.remarks && <><br /><span className="small muted">{c.remarks}</span></>}</td>
            <td>{canReview && (c.status === "draft" || c.status === "failed") && <><button className="btn ghost small" onClick={() => review(c.id, "approve")}>Approve</button> <button className="btn ghost small" onClick={() => review(c.id, "reject")}>Reject</button> </>}
              {app.has("export") && <a className="btn ghost small" href={withTok(`/api/challans/${c.id}/export`)}>Pack</a>}</td></tr>))
          : <EmptyRow cols={10}>Nothing here.</EmptyRow>)}</tbody></table>
      <p className="small muted">Fine amounts are the central MV Act defaults from config/rules.yaml; confirm the state notification before approving. Approval hands the challan to the e-challan endpoint (ECHALLAN_WEBHOOK_URL) with a signed payload.</p>
    </div>
  );
}

function ReviewQueue({ onReviewed }) {
  const app = useApp();
  const ui = useUI();
  const { t } = useI18n();
  const [rows, reload] = useLoad(() => api("/api/reports/anpr/review-queue?limit=30"));
  const after = () => { reload(); onReviewed(); };
  const confirmRead = (id) => apiJson(`/api/events/${id}/review`, "POST", { verdict: "confirmed" }).then(after).catch((e) => ui.toast(e.message, "err"));
  return (
    <div className="panel">
      <div className="panel-head"><h3>{t("review.title", "Plate review queue")}</h3><span className="muted small">Confirm or correct a sample every week: corrections fix the record and feed the accuracy report and the OCR retraining set</span></div>
      <table className="table" id="review-table"><thead><tr><th>{t("th.time", "Time (IST)")}</th><th>Read as</th><th>{t("th.crop", "Crop")}</th><th>{t("th.camera", "Camera")}</th><th>{t("th.tags", "Tags")}</th><th>Verdict</th></tr></thead>
        <tbody>{rows && (rows.length ? rows.map((e) => (
          <tr key={e.id}><td>{fmtTime(e.ts)}</td><td><Plate plate={e.plate} trace={false} /> <span className="small muted">{Math.round(e.confidence * 100)}%</span></td>
            <td><Crop src={e.crop_url} frame={e.frame_url} /></td><td>{app.camName(e.camera_id)}</td>
            <td>{visibleTags(e.tags).map((x) => <span key={x} className="tagchip">{x}</span>)}</td>
            <td><button className="btn ghost small" onClick={() => confirmRead(e.id)}>{t("review.confirm", "Confirm")}</button>{" "}
              <button className="btn ghost small" data-rv-fix={e.id} data-plate={e.plate} onClick={() => ui.modal(<ReviewDialog eid={e.id} plate={e.plate} after={after} />)}>{t("review.correct", "Correct")}</button></td></tr>))
          : <EmptyRow cols={6}>Nothing waiting for review.</EmptyRow>)}</tbody></table>
    </div>
  );
}

function Report({ bump }) {
  const app = useApp();
  const { t } = useI18n();
  const [week, setWeek] = useState("0");
  const [r] = useLoad(() => api(`/api/reports/anpr?weeks_ago=${week}`), [week, bump]);
  return (
    <div className="panel">
      <div className="panel-head"><h3>{t("report.title", "ANPR accuracy (weekly)")}</h3><span>
        <select className="small" id="rep-week" value={week} onChange={(e) => setWeek(e.target.value)}><option value="0">this week</option><option value="1">last week</option><option value="2">2 weeks ago</option><option value="3">3 weeks ago</option></select>{" "}
        {app.has("export") && <a className="btn ghost small" id="rep-train" href={withTok("/api/reports/anpr/training-set.zip")}>Retraining set</a>}</span></div>
      <p className="small muted" id="rep-sub">{r && `${r.week_start} → ${r.week_end}: ${r.reads} reads, ${r.reviewed} reviewed, accuracy ${r.accuracy_pct ?? "–"}% on reviewed reads. ${r.note}`}</p>
      <table className="table" id="rep-table"><thead><tr><th>{t("th.camera", "Camera")}</th><th>Reads</th><th>Reviewed</th><th>Accuracy</th><th>Mean conf.</th><th>Low conf.</th><th>Invalid</th><th>Night</th><th>Top correction reasons</th></tr></thead>
        <tbody>{r && (r.cameras.length ? r.cameras.map((c) => (
          <tr key={c.camera_name}><td>{c.camera_name}</td><td>{c.reads}</td><td>{c.reviewed}</td><td><b>{c.accuracy_pct ?? "–"}{c.accuracy_pct != null ? "%" : ""}</b></td>
            <td>{c.mean_confidence}</td><td>{c.low_confidence_pct}%</td><td>{c.invalid_format_pct}%</td><td>{c.night_pct}%</td>
            <td className="small">{c.top_reasons.map(([k, n]) => `${k} ×${n}`).join(", ")}</td></tr>))
          : <EmptyRow cols={9}>No reads this week.</EmptyRow>)}</tbody></table>
    </div>
  );
}

function Traffic() {
  const [hours, setHours] = useState("24");
  const [r] = useLoad(() => api(`/api/traffic?hours=${hours}`).catch(() => null), [hours]);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Traffic (vehicles in view, per camera)</h3><span>
        <select className="small" id="tr-hours" value={hours} onChange={(e) => setHours(e.target.value)}><option value="1">last hour</option><option value="6">6 h</option><option value="24">24 h</option><option value="168">7 days</option></select>{" "}
        <span className="muted small" id="tr-sub">{r ? `${r.rows.length} one-minute windows` : ""}</span></span></div>
      <table className="table" id="tr-table"><thead><tr><th>Camera</th><th>Windows</th><th>Avg vehicles</th><th>Peak vehicles</th><th>Avg persons</th><th>By type (avg)</th><th>Crossed line →</th><th>Crossed line ←</th><th>Last</th></tr></thead>
        <tbody>{r && (r.summary.length ? r.summary.map((c) => (
          <tr key={c.camera_name}><td>{c.camera_name}</td><td>{c.windows}</td><td><b>{c.avg_vehicles}</b></td><td>{c.peak_vehicles}</td><td><b>{c.avg_persons ?? 0}</b></td>
            <td className="small">{Object.entries(c.by_class).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}</td>
            <td>{c.flow.a_to_b || "–"}</td><td>{c.flow.b_to_a || "–"}</td><td className="small">{fmtTime(c.last)}</td></tr>))
          : <EmptyRow cols={9}>No traffic counts yet: add <code>traffic:</code> to a camera in config/analytics.yaml.</EmptyRow>)}</tbody></table>
    </div>
  );
}

function Incidents() {
  const app = useApp();
  const [openOnly, setOpenOnly] = useState(false);
  const [rows, reload] = useLoad(() => api(`/api/incidents?open_only=${openOnly}&limit=200`), [openOnly]);
  return (
    <div className="panel">
      <div className="panel-head"><h3>Incidents (zone analytics)</h3><label className="check small"><input type="checkbox" id="inc-open" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only</label></div>
      <table className="table" id="inc-table"><thead><tr><th>When (IST)</th><th>Kind</th><th>Zone</th><th>Camera</th><th>Plate</th><th>Detail</th><th>Snapshot</th><th>Status</th></tr></thead>
        <tbody>{rows && (rows.length ? rows.map((i) => (
          <tr key={i.id}><td>{fmtTime(i.ts)}</td><td><span className={`tagchip ${i.priority === "high" ? "watchlist" : ""}`}>{i.label}</span></td><td>{i.zone}</td>
            <td>{app.camName(i.camera_id)}</td><td>{i.plate ? <Plate plate={i.plate} trace={false} /> : <span className="muted">–</span>}</td>
            <td className="small">{Object.entries(i.detail || {}).filter(([k]) => k !== "bbox").map(([k, v]) => `${k}: ${v}`).join(", ")}</td>
            <td><Crop src={i.snapshot_url} frame={i.snapshot_url} /></td>
            <td>{i.ack_by ? `seen by ${i.ack_by}` : app.has("alerts_ack") ? <button className="btn ghost small" onClick={() => api(`/api/incidents/${i.id}/ack`, { method: "POST" }).then(reload)}>Acknowledge</button> : "open"}</td></tr>))
          : <EmptyRow cols={8}>No incidents. Zone analytics run on cameras configured in config/analytics.yaml.</EmptyRow>)}</tbody></table>
    </div>
  );
}
