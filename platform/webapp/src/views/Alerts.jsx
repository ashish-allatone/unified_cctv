import { useState } from "react";
import { api, fmtTime } from "../lib/api.js";
import { useApp } from "../context/AppContext.jsx";
import { Crop, EmptyRow, Plate, useLoad } from "../components/common.jsx";

export default function Alerts() {
  const app = useApp();
  const [openOnly, setOpenOnly] = useState(false);
  const [rows, reload] = useLoad(() => api(`/api/alerts?open_only=${openOnly}`), [openOnly]);
  const ack = async (id) => { await api(`/api/alerts/${id}/ack`, { method: "POST" }); app.refreshAlertBadge(); reload(); };

  return (
    <main id="view-alerts" className="view">
      <div className="view-head"><div><h2>Alerts</h2><p>Watchlist hits as they happen; acknowledge and hand off.</p></div></div>
      <div className="panel">
        <div className="panel-head"><h3>Watchlist alerts</h3><label className="check small"><input type="checkbox" id="alerts-open" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open only</label></div>
        <table className="table" id="alerts-table"><thead><tr><th>Time (IST)</th><th>Plate read</th><th>Crop</th><th>Watchlist entry</th><th>Match</th><th>Camera</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>{rows && (rows.length ? rows.map((a) => (
            <tr key={a.id}><td>{fmtTime(a.ts)}</td><td><Plate plate={a.plate} /></td><td><Crop src={a.crop_url} /></td><td className="plate">{a.watchlist_plate}</td>
              <td>{a.match}</td><td>{app.camName(a.camera_id)}</td><td>{a.reason}</td>
              <td>{a.ack_by ? `acknowledged by ${a.ack_by}` : app.can("supervisor") ? <button className="btn small" onClick={() => ack(a.id)}>Acknowledge</button> : "open"}</td></tr>))
            : <EmptyRow cols={8}>No alerts.</EmptyRow>)}</tbody></table>
      </div>
    </main>
  );
}
