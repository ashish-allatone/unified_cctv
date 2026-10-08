import { useState, useMemo } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

export interface AdminItem {
  id: string;
  label: string;
  desc: string;
  legacy?: boolean;
}

export interface AdminGroup {
  id: string;
  group: string;
  desc: string;
  iconName: "access" | "data" | "integrations" | "overview";
  items: AdminItem[];
}

export const ADMIN_SECTIONS: AdminGroup[] = [
  {
    id: "access",
    group: "Access Control",
    desc: "Manage users, role capabilities, permission scopes, temporary grants and legal holds",
    iconName: "access",
    items: [
      { id: "permissions", label: "Permissions", desc: "Camera & department permission scopes" },
      { id: "users", label: "Users", desc: "User accounts, roles & directory sync" },
      { id: "roles", label: "Role Matrix", desc: "Role capability and feature permission matrix" },
      { id: "grants", label: "Access grants", desc: "Temporary emergency cross-department access", legacy: true },
      { id: "holds", label: "Legal holds", desc: "Preserve video footage against deletion", legacy: true },
    ],
  },
  {
    id: "data",
    group: "Data Governance",
    desc: "Configure data retention schedules, storage quotas and DPDP privacy requests",
    iconName: "data",
    items: [
      { id: "archival", label: "Archival policy", desc: "Storage tiers, cold storage & retention limits" },
      { id: "dpdp", label: "DPDP requests", desc: "Data Protection & Privacy subject access & erasure" },
    ],
  },
  {
    id: "integrations",
    group: "Integrations & APIs",
    desc: "Connect third-party endpoints, alert dispatch channels, webhooks & API keys",
    iconName: "integrations",
    items: [
      { id: "external", label: "External APIs", desc: "Third-party platform endpoints & credentials", legacy: true },
      { id: "notify", label: "Notifications", desc: "Alert routes via SMS, email, WhatsApp & webhooks" },
      { id: "keys", label: "API keys", desc: "Ingest & query tokens with rate limits" },
      { id: "hooks", label: "Webhooks", desc: "Real-time webhook subscriptions", legacy: true },
      { id: "tenants", label: "Tenants & presets", desc: "Tenant isolation and camera vendor presets", legacy: true },
    ],
  },
  {
    id: "overview",
    group: "Compliance & Overview",
    desc: "System compliance status, audit tamper verification and security posture",
    iconName: "overview",
    items: [
      { id: "overview", label: "Compliance", desc: "Audit chain-of-custody and system compliance", legacy: true },
    ],
  },
];

function GroupIcon({ name }: { name: string }) {
  switch (name) {
    case "access":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="admin-ico">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      );
    case "data":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="admin-ico">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case "integrations":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="admin-ico">
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" strokeWidth="3" />
          <line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3" />
        </svg>
      );
    case "overview":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="admin-ico">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="admin-ico">
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function ItemIcon({ id }: { id: string }) {
  switch (id) {
    case "permissions":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <path d="M21 2l-2 2m-1.5 1.5L10 13l-4 4-2-2 4-4 7.5-7.5z" />
          <circle cx="16.5" cy="7.5" r="3.5" />
        </svg>
      );
    case "users":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "roles":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case "grants":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "holds":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case "archival":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case "dpdp":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "external":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "notify":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "keys":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <path d="M21 2l-2 2m-1.5 1.5L10 13l-4 4-2-2 4-4 7.5-7.5z" />
          <circle cx="16.5" cy="7.5" r="3.5" />
        </svg>
      );
    case "hooks":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <circle cx="18" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" />
          <line x1="6" y1="9" x2="6" y2="21" />
        </svg>
      );
    case "tenants":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <line x1="9" y1="22" x2="9" y2="2" />
          <line x1="15" y1="22" x2="15" y2="2" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="tab-ico">
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

export default function AdminLayout() {
  const loc = useLocation();

  // Extract current section ID from pathname: /admin/users -> "users"
  const currentSectionId = useMemo(() => {
    const p = loc.pathname.replace(/^\/admin\/?/, "").split("/")[0];
    return p || "permissions";
  }, [loc.pathname]);

  // Find active group based on current section
  const activeGroup = useMemo(() => {
    return (
      ADMIN_SECTIONS.find((g) => g.items.some((i) => i.id === currentSectionId)) ||
      ADMIN_SECTIONS[0]
    );
  }, [currentSectionId]);

  const activeItem = useMemo(() => {
    return activeGroup.items.find((i) => i.id === currentSectionId) || activeGroup.items[0];
  }, [activeGroup, currentSectionId]);

  return (
    <main className="view admin-view-root">
      <section className="admin-workspace full-width">
        {/* Header with Breadcrumb & Context */}
        <div className="admin-workspace-header">
          <div className="admin-workspace-meta">
            <div className="admin-breadcrumbs">
              <span className="crumb">Administration</span>
              <span className="crumb-sep">/</span>
              <span className="crumb group-crumb">{activeGroup.group}</span>
              <span className="crumb-sep">/</span>
              <span className="crumb active-crumb">{activeItem?.label}</span>
            </div>
            <div className="admin-title-row">
              <div className="title-ico-box">
                <GroupIcon name={activeGroup.iconName} />
              </div>
              <div>
                <h2 className="admin-category-title">{activeGroup.group}</h2>
                <p className="admin-category-desc">{activeGroup.desc}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Tab-wise Option Strip */}
        <div className="admin-tabs-bar" role="tablist" aria-label="Section tabs">
          {activeGroup.items.map((item) => {
            const isTabActive = item.id === currentSectionId;
            return (
              <NavLink
                key={item.id}
                to={`/admin/${item.id}`}
                className={({ isActive }) => `admin-tab-item ${isActive ? "active" : ""}`}
                role="tab"
                aria-selected={isTabActive}
                title={item.desc}
              >
                <ItemIcon id={item.id} />
                <span className="tab-label">{item.label}</span>
                {item.legacy && <span className="tab-tag" title="Legacy embedded module">legacy</span>}
                {isTabActive && <div className="tab-active-indicator" />}
              </NavLink>
            );
          })}
        </div>

        {/* Related Page Content Area */}
        <div className="admin-content-pane">
          <Outlet />
        </div>
      </section>
    </main>
  );
}
