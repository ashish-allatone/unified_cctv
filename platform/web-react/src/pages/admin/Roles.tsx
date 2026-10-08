import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { toast } from "../../lib/toast";

type Role = { name: string; description: string; features: string[]; builtin: boolean; users: number; rank: number };
type Feat = { id: string; label: string };

/** Permission matrix: features × roles with tick boxes; Save per role, create / remove custom roles. */
export default function Roles() {
  const { refresh } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]); const [feats, setFeats] = useState<Feat[]>([]);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [name, setName] = useState(""); const [desc, setDesc] = useState(""); const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try { const r = await api("/api/roles"); setRoles(r.roles); setFeats(r.features); setDraft(Object.fromEntries(r.roles.map((x: Role) => [x.name, new Set(x.features)]))); setErr(""); }
    catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = (r: Role) => { const d = draft[r.name]; if (!d) return false; const a = [...d].sort().join(","), b = [...r.features].sort().join(","); return a !== b; };
  const tick = (role: string, f: string, on: boolean) => setDraft((d) => { const n = new Set(d[role]); on ? n.add(f) : n.delete(f); if (f === "registry_edit" && on) n.add("registry"); return { ...d, [role]: n }; });
  const save = async (r: Role) => {
    const features = [...draft[r.name]];
    try { await api(`/api/roles/${encodeURIComponent(r.name)}`, { method: "PATCH", body: JSON.stringify({ features }) }); toast(`Role ${r.name} saved · ${features.length} permission${features.length === 1 ? "" : "s"}; signed-in users follow at once`, "ok"); load(); refresh(); }
    catch (e: any) { toast(e.message, "err"); }
  };
  const remove = async (r: Role) => { if (!confirm(`Remove role ${r.name}?`)) return; try { await api(`/api/roles/${encodeURIComponent(r.name)}`, { method: "DELETE" }); toast("Role removed", "ok"); load(); } catch (e: any) { toast(e.message, "err"); } };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) return toast("Role name: lowercase letters, digits, _ or -, 2–32 characters", "warn");
    try { await api("/api/roles", { method: "POST", body: JSON.stringify({ name, description: desc, features: ["live"] }) }); toast(`Role ${name} created with "Live video wall" only — tick its permissions and press Save`, "ok"); setName(""); setDesc(""); load(); }
    catch (err: any) { toast(err.message, "err"); }
  };

  return (
    <div className="panel" id="roles-panel">
      <div className="panel-head"><h3>Roles &amp; permissions</h3><span className="muted small">Tick what each role may do. Changes apply to signed-in users at once.</span></div>
      <form className="search-form" onSubmit={create}>
        <label>New role <input value={name} onChange={(e) => setName(e.target.value)} placeholder="traffic_analyst" /></label>
        <label style={{ flex: 1 }}>Description <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="what this role is for" /></label>
        <button className="btn primary small">Create role</button>
      </form>
      {err && <div className="inline-err">{err}</div>}
      <div className="scroll-x">
        <table className="table roles-matrix" id="roles-table">
          <thead><tr><th>Permission</th>{roles.map((r) => <th key={r.name} className={dirty(r) ? "dirty" : ""}><b>{r.name}</b>{!r.builtin && <> <span className="tagchip">custom</span></>}<span className="rdesc">{r.description}</span><span className="muted small"> · {r.users} user{r.users === 1 ? "" : "s"}</span></th>)}</tr></thead>
          <tbody>
            {feats.map((f) => (
              <tr key={f.id}><td><b>{f.label}</b><div className="muted small">{f.id}</div></td>
                {roles.map((r) => <td key={r.name}><input type="checkbox" checked={draft[r.name]?.has(f.id) || false} disabled={r.name === "admin" && f.id === "admin"} onChange={(e) => tick(r.name, f.id, e.target.checked)} /></td>)}</tr>
            ))}
            <tr><td className="muted small">Save / remove</td>{roles.map((r) => <td key={r.name}><button className="btn primary small" disabled={!dirty(r)} onClick={() => save(r)}>Save</button>{!r.builtin && <> <button className="btn ghost small" disabled={r.users > 0} title={r.users ? "accounts still use this role" : ""} onClick={() => remove(r)}>Remove</button></>}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
