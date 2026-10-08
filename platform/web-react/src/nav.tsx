import type { ReactNode } from "react";

export type NavItem = { view: string; label: string; i18n: string; feature?: string; icon: ReactNode; react?: boolean };
export type NavGroup = { label: string; i18n: string; items: NavItem[] };

const I = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" dangerouslySetInnerHTML={{ __html: d }} />;

/** Same menu as the legacy console. `react: true` = already rebuilt in React; the rest open the legacy page inside the shell. */
export const NAV: NavGroup[] = [
  { label: "Operations", i18n: "grp.operations", items: [
    { view: "overview", label: "Overview", i18n: "nav.overview", icon: I('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="11" width="8" height="10" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/>') },
    { view: "wall", label: "Video wall", i18n: "nav.wall", icon: I('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 4v13M3 10.5h18M8 21h8"/>') },
    { view: "map", label: "Map", i18n: "nav.map", icon: I('<path d="M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11z"/><circle cx="12" cy="10" r="2.2"/>') },
    { view: "registry", label: "Registry", i18n: "nav.registry", feature: "registry", icon: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16"/>') },
    { view: "alerts", label: "Alerts", i18n: "nav.alerts", icon: I('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>') },
    { view: "notifications", label: "Notifications", i18n: "nav.notifications", react: true, icon: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>') },
    { view: "counts", label: "Counts", i18n: "nav.counts", icon: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>') },
    { view: "reports", label: "Reports", i18n: "nav.reports", feature: "reports", icon: I('<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 17v-3M12 17v-6M15 17v-4"/>') },
  ] },
  { label: "Investigate", i18n: "grp.investigate", items: [
    { view: "search", label: "Search", i18n: "nav.search", feature: "search", icon: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>') },
    { view: "movement", label: "Vehicle movement", i18n: "nav.movement", feature: "movement", icon: I('<path d="M4 18c4-1 5-6 9-7s5 4 7 3"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="14" r="1.6"/>') },
    { view: "multicam", label: "Multi-camera", i18n: "nav.multicam", feature: "movement", icon: I('<rect x="3" y="5" width="8" height="6" rx="1.5"/><rect x="13" y="5" width="8" height="6" rx="1.5"/><rect x="3" y="14" width="8" height="6" rx="1.5"/><path d="M17 14v6M14 17h6"/>') },
    { view: "playback", label: "Playback", i18n: "nav.playback", feature: "playback", icon: I('<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>') },
    { view: "cases", label: "Cases", i18n: "nav.cases", feature: "cases", icon: I('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5h8v2M3 12h18"/>') },
    { view: "violations", label: "Violations", i18n: "nav.violations", feature: "search", icon: I('<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>') },
    { view: "watchlist", label: "Watchlist", i18n: "nav.watchlist", feature: "search", icon: I('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>') },
    { view: "upload", label: "Upload & recognise", i18n: "nav.upload", feature: "search", icon: I('<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>') },
  ] },
  { label: "System", i18n: "grp.system", items: [
    { view: "sources", label: "Sources", i18n: "nav.sources", feature: "sources", icon: I('<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>') },
    { view: "audit", label: "Audit", i18n: "nav.audit", feature: "audit", icon: I('<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>') },
    { view: "admin", label: "Admin", i18n: "nav.admin", feature: "admin", react: true, icon: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>') },
  ] },
];
export const ALL_ITEMS = NAV.flatMap((g) => g.items);
