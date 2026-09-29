import { useState } from "react";
import { api, fmtTime } from "../lib/api.js";
import { useUI } from "../lib/ui.jsx";
import { useLoad } from "../components/common.jsx";

export default function Audit() {
  const { toast } = useUI();
  const [rows] = useLoad(() => api("/api/audit?limit=300"));
  const [chain, setChain] = useState(null);
  const verify = async () => {
    try {
      const v = await api("/api/audit/verify");
      setChain(v);
      toast(v.ok ? "Audit chain verified" : "Audit chain broken: possible tampering", v.ok ? "ok" : "err");
    } catch (e) { toast(e.message, "err"); }
  };
  return (
    <main id="view-audit" className="view">
      <div className="view-head"><div><h2>Audit log</h2><p>Hash-chained record of every sensitive action.</p></div></div>
      <div className="panel"><div className="panel-head"><h3>Audit log (hash-chained)</h3>
        <span><span className="muted small" id="audit-chain">{chain && (chain.ok ? <span className="ok-chip">✓ chain intact ({chain.rows} rows)</span> : <span className="bad-chip">✗ chain broken at row {chain.first_bad_id}</span>)}</span>{" "}
          <button className="btn ghost small" id="audit-verify" onClick={verify}>Verify chain</button></span></div>
        <table className="table" id="audit-table"><thead><tr><th>Time (IST)</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
          <tbody>{(rows || []).map((r, i) => (
            <tr key={r.id ?? i} className={r.action.startsWith("break_glass") ? "row-bg" : ""}><td>{fmtTime(r.ts)}</td><td>{r.user}</td><td>{r.action}</td><td>{r.target}</td><td>{r.detail}</td>
              <td>{r.ip} <span className="muted small" title="row hash">{r.hash}</span></td></tr>))}</tbody></table></div>
    </main>
  );
}
