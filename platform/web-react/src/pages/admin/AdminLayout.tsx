import { NavLink, Outlet } from "react-router-dom";

/** Administration shell: the sub-menu on the left, one section at a time on the right.
 * Sections marked `legacy` still render the old console inside an iframe until they are rebuilt. */
export const ADMIN_SECTIONS: { group: string; items: { id: string; label: string; legacy?: boolean }[] }[] = [
  { group: "Overview", items: [{ id: "overview", label: "Compliance", legacy: true }] },
  { group: "Access", items: [
    { id: "permissions", label: "Permissions" }, { id: "users", label: "Users" }, { id: "roles", label: "Roles & permissions" },
    { id: "grants", label: "Access grants", legacy: true }, { id: "holds", label: "Legal holds", legacy: true } ] },
  { group: "Data", items: [{ id: "archival", label: "Archival policy", legacy: true }, { id: "dpdp", label: "DPDP requests", legacy: true }] },
  { group: "Integrations", items: [
    { id: "external", label: "External APIs", legacy: true }, { id: "notify", label: "Notifications", legacy: true },
    { id: "keys", label: "API keys", legacy: true }, { id: "hooks", label: "Webhooks", legacy: true }, { id: "tenants", label: "Tenants & presets", legacy: true } ] },
];

export default function AdminLayout() {
  return (
    <main className="view">
      <div className="view-head"><div><h2>Administration</h2><p className="muted">Users, roles, permissions, access grants, legal holds, external APIs, archival, integrations, compliance.</p></div></div>
      <div className="admin-layout">
        <nav className="subnav" id="admin-nav" aria-label="Administration sections">
          {ADMIN_SECTIONS.map((g) => (
            <div key={g.group} style={{ display: "contents" }}>
              <div className="grp">{g.group}</div>
              {g.items.map((i) => <NavLink key={i.id} to={`/admin/${i.id}`} className={({ isActive }) => `subnav-link${isActive ? " active" : ""}`}>{i.label}</NavLink>)}
            </div>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}><Outlet /></div>
      </div>
    </main>
  );
}
