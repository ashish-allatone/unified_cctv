import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import Modal from "../../components/Modal";

type U = { username: string; provider: string; role: string; departments: string[]; cameras?: string[]; is_super: boolean; is_active: boolean;
  mfa_enrolled: boolean; mfa_required: boolean; locked_until?: string | null; last_login?: string | null; active_grants: number };
type Cam = { id: string; name: string; department: string };

export default function Users() {
  const { user: me } = useAuth();
  const su = !!me?.is_super;
  const [users, setUsers] = useState<U[]>([]); const [cams, setCams] = useState<Cam[]>([]); const [roles, setRoles] = useState<string[]>(["viewer", "analyst", "supervisor", "admin"]);
  const [err, setErr] = useState(""); const [access, setAccess] = useState<U | null>(null); const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [us, reg, rl] = await Promise.all([api<U[]>("/api/admin/users"), api("/api/registry").catch(() => []), api("/api/roles").catch(() => null)]);
      setUsers(us); setCams((reg as any[]).map((c) => ({ id: c.id, name: c.name, department: c.department })).sort((a, b) => a.name.localeCompare(b.name)));
      if (rl?.roles) setRoles(rl.roles.map((r: any) => r.name)); setErr("");
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = (p: Promise<any>, ok?: string) => p.then(() => { if (ok) toast(ok, "ok"); load(); }).catch((e) => toast(e.message, "err"));
  const camName = (id: string) => cams.find((c) => c.id === id)?.name || id;

  return (
    <div className="panel">
      <div className="panel-head"><h3>Users</h3><span className="muted small">{su ? "You are a super admin: create users here; deactivate keeps the account for audit, remove deletes it with its 2FA state" : "Accounts are created by a super admin; directory (LDAP/SSO) users appear after first login"}</span>
        {su && <button className="btn small primary" onClick={() => setCreating(true)}>+ Create user</button>}</div>
      {err && <div className="inline-err">{err}</div>}
      <table className="table" id="users-table">
        <thead><tr><th>User</th><th>Provider</th><th>Role</th><th>Access (departments · cameras)</th><th>2FA</th><th>Last login</th><th>Grants</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.username} className={u.is_active === false ? "muted" : ""}>
              <td>{u.username}{u.is_super && <> <span className="ok-chip">super</span></>}{u.is_active === false && <> <span className="bad-chip">inactive</span></>}</td>
              <td>{u.provider}</td><td>{u.role}</td>
              <td>{u.departments?.length ? u.departments.join(", ") : <span className="muted">no department</span>}{!!u.cameras?.length && <div className="small muted">{u.cameras.length} camera{u.cameras.length === 1 ? "" : "s"}: {u.cameras.slice(0, 4).map(camName).join(", ")}{u.cameras.length > 4 ? "…" : ""}</div>}</td>
              <td>{u.mfa_enrolled ? <span className="ok-chip">enrolled</span> : u.mfa_required ? <span className="bad-chip">required</span> : "–"}</td>
              <td>{u.last_login ? fmtTime(u.last_login) : "–"}{u.locked_until && <> <span className="bad-chip">locked</span></>}</td>
              <td>{u.active_grants}</td>
              <td className="nowrap">
                {u.locked_until && <button className="btn ghost small" onClick={() => act(api(`/api/admin/users/${u.username}/unlock`, { method: "POST" }), "Unlocked")}>Unlock</button>}{" "}
                {u.mfa_enrolled && <button className="btn ghost small" onClick={() => act(api(`/api/auth/mfa/reset/${u.username}`, { method: "POST" }), "2FA reset")}>Reset 2FA</button>}{" "}
                {su && u.provider === "db" && <button className="btn ghost small" title="Departments, cameras and role this account may use" onClick={() => setAccess(u)}>Access</button>}{" "}
                {su && u.provider === "db" && u.username !== me?.username && <>
                  <button className="btn ghost small" onClick={() => act(api(`/api/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ is_active: u.is_active === false }) }))}>{u.is_active === false ? "Activate" : "Deactivate"}</button>{" "}
                  <button className="btn ghost small" onClick={() => { const pw = prompt(`New password for ${u.username} (min 10 chars, 1 uppercase, 1 digit):`); if (pw) act(api(`/api/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ password: pw }) }), "Password set"); }}>Set password</button>{" "}
                  <button className="btn ghost small danger" onClick={() => { if (confirm(`Remove account ${u.username}? This deletes it with its 2FA state.`)) act(api(`/api/users/${u.username}`, { method: "DELETE" }), "Account removed"); }}>Remove</button></>}
              </td>
            </tr>
          ))}
          {!users.length && !err && <tr><td colSpan={8} className="muted">No accounts.</td></tr>}
        </tbody>
      </table>
      {access && <AccessDialog u={access} cams={cams} roles={roles} onClose={() => setAccess(null)} onSaved={() => { setAccess(null); load(); }} />}
      {creating && <CreateDialog cams={cams} roles={roles} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function DeptCams({ depts, setDepts, mode, setMode, picked, setPicked, cams }: any) {
  const all = [...new Set(cams.map((c: Cam) => c.department))].sort() as string[];
  return (<>
    <div style={{ gridColumn: "1/3" }}><div className="muted small" style={{ marginBottom: 5 }}>Departments</div>
      <div className="seg"><button type="button" className={mode === "all" ? "active" : ""} onClick={() => setMode("all")}>All departments</button><button type="button" className={mode === "some" ? "active" : ""} onClick={() => setMode("some")}>Selected</button><button type="button" className={mode === "none" ? "active" : ""} onClick={() => setMode("none")}>None (cameras only)</button></div>
      {mode === "some" && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>{all.map((d) => <label key={d} className="check"><input type="checkbox" checked={depts.includes(d)} onChange={(e) => setDepts(e.target.checked ? [...depts, d] : depts.filter((x: string) => x !== d))} /> {d}</label>)}</div>}
    </div>
    <label style={{ gridColumn: "1/3" }}>Cameras (in addition to the departments){" "}
      <select multiple size={6} value={picked} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}>{cams.map((c: Cam) => <option key={c.id} value={c.id}>{c.name} ({c.department})</option>)}</select>
      <span className="muted small">Ctrl / Cmd-click to select several · {picked.length} selected</span></label>
  </>);
}

function AccessDialog({ u, cams, roles, onClose, onSaved }: { u: U; cams: Cam[]; roles: string[]; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState(u.role);
  const [mode, setMode] = useState<"all" | "some" | "none">(u.departments.includes("*") ? "all" : u.departments.length ? "some" : "none");
  const [depts, setDepts] = useState<string[]>(u.departments.filter((d) => d !== "*"));
  const [picked, setPicked] = useState<string[]>(u.cameras || []);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const departments = mode === "all" ? ["*"] : mode === "some" ? depts : [];
    try { await api(`/api/users/${u.username}`, { method: "PATCH", body: JSON.stringify({ role, departments, cameras: picked }) }); toast(`${u.username}: access saved — applies at the next sign-in`, "ok"); onSaved(); } catch (err: any) { toast(err.message, "err"); }
  };
  return (
    <Modal open onClose={onClose}>
      <h3>Access for {u.username}</h3>
      <p className="muted small">An account sees every camera of its departments plus the cameras ticked below. For a guard who may see only particular cameras: choose <b>None</b> and tick the cameras. (For time-bound or per-permission access use Admin → Permissions.)</p>
      <form className="search-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} onSubmit={save}>
        <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</select></label>
        <div />
        <DeptCams {...{ depts, setDepts, mode, setMode, picked, setPicked, cams }} />
        <div style={{ gridColumn: "1/3", display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn ghost" type="button" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function CreateDialog({ cams, roles, onClose, onSaved }: { cams: Cam[]; roles: string[]; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [role, setRole] = useState("viewer"); const [isSuper, setIsSuper] = useState(false);
  const [mode, setMode] = useState<"all" | "some" | "none">("all"); const [depts, setDepts] = useState<string[]>([]); const [picked, setPicked] = useState<string[]>([]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const departments = mode === "all" ? ["*"] : mode === "some" ? depts : [];
    try { await api("/api/users", { method: "POST", body: JSON.stringify({ username: username.trim(), password, role, departments, cameras: picked, is_super: isSuper }) }); toast(`User ${username} created`, "ok"); onSaved(); } catch (err: any) { toast(err.message, "err"); }
  };
  return (
    <Modal open onClose={onClose}>
      <h3>Create user</h3>
      <form className="search-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} onSubmit={save}>
        <label>Username <input value={username} onChange={(e) => setUsername(e.target.value)} required placeholder="firstname.lastname" autoComplete="off" /></label>
        <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" placeholder="min 10, 1 uppercase, 1 digit" /></label>
        <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" checked={isSuper} onChange={(e) => setIsSuper(e.target.checked)} /> super admin</label>
        <DeptCams {...{ depts, setDepts, mode, setMode, picked, setPicked, cams }} />
        <div style={{ gridColumn: "1/3", display: "flex", gap: 8, justifyContent: "flex-end" }}><button className="btn ghost" type="button" onClick={onClose}>Cancel</button><button className="btn primary">Create user</button></div>
      </form>
    </Modal>
  );
}
