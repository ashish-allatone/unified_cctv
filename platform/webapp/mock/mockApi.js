/* Demo mode for `npm run dev` when no backend is running: the Vite dev server answers /api itself with sample
   data so every console screen can be opened. Never part of the production build. Any username / password signs in. */

const now = () => new Date().toISOString();
const FEATURES = ["registry", "registry_edit", "search", "movement", "playback", "cases", "sources", "audit", "admin", "export", "watchlist", "plate_search", "alerts_ack", "live"];
const USERS = {
  admin: { password: "admin123", user: { username: "admin", role: "admin", is_super: true, provider: "db", features: FEATURES } },
  viewer: { password: "viewer123", user: { username: "viewer", role: "viewer", provider: "db", features: ["search"] } },
};
const cam = (id, name, department, status, lat, lon) => ({ id, name, department, status, anpr_enabled: id.startsWith("police"), lat, lon, registry_only: false });
const CAMS = [
  cam("police-cam1", "Ring Road Junction", "Police", "online", 23.0305, 72.5800),
  cam("police-cam2", "Paldi Circle", "Police", "online", 23.0117, 72.5606),
  cam("muni-cam1", "Municipal HQ Gate", "Municipal", "online", 23.0225, 72.5714),
  cam("muni-cam2", "Kankaria Lake", "Municipal", "offline", 23.0063, 72.6010),
];
const camName = (id) => CAMS.find((c) => c.id === id)?.name || id;
const PLATES = ["GJ01AB1234", "GJ05CD5678", "MH12EF9012", "GJ18GH3456", "RJ14JK7890"];
const events = Array.from({ length: 24 }, (_, i) => {
  const c = CAMS[i % 3];
  return { id: `e${i + 1}`, ts: new Date(Date.now() - i * 150000).toISOString(), plate: PLATES[i % PLATES.length], camera_id: c.id, department: c.department,
    confidence: 0.82 + (i % 5) * 0.03, reads: 2 + (i % 4), direction: i % 2 ? "in" : "out", vehicle_type: ["car", "two_wheeler", "truck"][i % 3],
    vehicle_colour: ["white", "black", "red", "silver"][i % 4], tags: i % 6 === 0 ? ["watchlist"] : [], frame_url: null, crop_url: null };
});
const perMinute = () => Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.now() - (29 - i) * 60000);
  return [d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }), 2 + Math.round(Math.abs(Math.sin(i / 3)) * 8)];
}));
const state = {
  watchlist: [{ plate: "GJ01AB1234", reason: "stolen vehicle FIR 123/2026", priority: "high", added_by: "admin", expires_at: null }],
  alerts: [{ id: "a1", ts: now(), plate: "GJ01AB1234", watchlist_plate: "GJ01AB1234", match: "exact", camera_id: "police-cam1", department: "Police", reason: "stolen vehicle FIR 123/2026" }],
  cases: [{ id: "c1", number: "CASE-2026-001", title: "Hit and run, Ring Road", reference: "FIR 88/2026", priority: "high", owner: "admin", status: "open", created_by: "admin", created_at: now(), updated_at: now(), department: "Police",
    items: [{ id: "i1", kind: "note", note: "Witness statement collected.", added_by: "admin", added_at: now() }] }],
  bookmarks: [], grants: [], holds: [], keys: [], hooks: [], persons: [],
};
let seq = 100;
const caseSummary = (c) => ({ ...c, items: c.items.length });
const caseDetail = (c) => ({ ...c, custody_chain: { ok: true }, custody: [{ ts: c.created_at, action: "case.open", user: c.created_by, detail: c.title }] });

function route(method, p, q, body) {
  const m = (re) => p.match(re);
  if (method === "GET") {
    switch (p) {
      case "/api/version": return { version: "demo" };
      case "/api/auth/providers": return { break_glass: true, yaml_users: true };
      case "/api/auth/setup": return { password_rules: "at least 10 characters, one uppercase letter, one digit" };
      case "/api/auth/mfa/status": return { state: "none", required: false };
      case "/api/config": return { search_backend: "demo", bus: "demo", relay: { host: "", webrtc_port: 8889, hls_port: 8888, base: "" } };
      case "/api/cameras": return CAMS;
      case "/api/license": return { mode: "licensed", status: "demo licence", over_limit: {}, usage: { cameras_total: CAMS.length, anpr_channels: 2, analytics_channels: 2 }, limits: {}, version: "demo", customer: "Demo", expires: null };
      case "/api/stats": return { cameras_online: CAMS.filter((c) => c.status === "online").length, cameras: CAMS.length, events: events.length, unique_plates: PLATES.length, alerts_open: state.alerts.filter((a) => !a.ack_by).length, watchlist: state.watchlist.length, anpr_cameras: 2, per_minute: perMinute() };
      case "/api/events": {
        let r = events;
        if (q.get("plate")) { const re = new RegExp("^" + q.get("plate").toUpperCase().replace(/\*/g, ".*") + "$"); r = r.filter((e) => re.test(e.plate)); }
        if (q.get("camera")) r = r.filter((e) => e.camera_id === q.get("camera"));
        r = r.slice(0, +(q.get("limit") || 300));
        return { count: r.length, events: r };
      }
      case "/api/alerts": return q.get("open_only") === "true" ? state.alerts.filter((a) => !a.ack_by) : state.alerts;
      case "/api/counts": return { cameras: CAMS.filter((c) => c.status === "online").map((c, i) => ({ camera_id: c.id, name: c.name, department: c.department, vehicles: 3 + i, persons: 5 + 2 * i, stale: false })), total: { vehicles: 12, persons: 21, cameras: 3 } };
      case "/api/counts/timeline": return { crowd_default: 25, cameras: CAMS.slice(0, 3).map((c, k) => ({ camera_id: c.id, name: c.name, department: c.department, points: Array.from({ length: 30 }, (_, i) => [i, 2 + ((i + k) % 7), 4 + ((i * 2 + k) % 9)]), avg_vehicles: 5, peak_vehicles: 8, avg_persons: 7, peak_persons: 12, flow: { a_to_b: 40 + k, b_to_a: 31 }, crowd_max: 25 })) };
      case "/api/counts/status": return { detecting_count: 3, cameras_last_5min: 3, expected_count: 3, last_row_age_s: 20 };
      case "/api/sources": return [{ id: "police-nvr", name: "Police ONVIF NVR", department: "Police", adapter: "onvif", cameras: 2, active_pulls: 1, max_concurrent_pulls: 8, viewers: 2, status: "ok", detail: "demo", checked_at: now() },
        { id: "muni-vms", name: "Municipal VMS", department: "Municipal", adapter: "rest", cameras: 2, active_pulls: 1, max_concurrent_pulls: 4, viewers: 1, status: "ok", detail: "demo", checked_at: now() }];
      case "/api/layouts": return {};
      case "/api/registry": return CAMS.map((c) => ({ ...c, health: c.status, camera_type: c.anpr_enabled ? "anpr" : "dome", connectivity: "fibre", storage_type: "nvr", storage_days: 30, install_date: "2021-04-01", age_years: 5, maintenance_status: "ok", tags: [] }));
      case "/api/registry/stats": return { total: CAMS.length, integrated: CAMS.length, registry_only: 0, health: { offline: 1 }, maintenance_due: 0, ageing: 0, warranty_expired: 0, geolocated: CAMS.length, missing_metadata: 0, by_department: { Police: 2, Municipal: 2 } };
      case "/api/map": return { cameras: CAMS.map((c) => ({ ...c, heading: 45, fov: 70, range_m: 120, coverage: [[c.lat, c.lon], [c.lat + 0.0009, c.lon + 0.0004], [c.lat + 0.0004, c.lon + 0.0009]] })) };
      case "/api/map/nearest": return { cameras: CAMS.map((c, i) => ({ id: c.id, name: c.name, distance_m: 150 + i * 400, covers_point: i === 0 })) };
      case "/api/registry/gaps": return { cell_m: 100, bbox: [23], blind_spots: [], gaps: [], near_coverage_pct: 64, near_uncovered: 0, uncovered: 0 };
      case "/api/bookmarks": return state.bookmarks;
      case "/api/cases": return state.cases.filter((c) => !q.get("status") || c.status === q.get("status")).map(caseSummary);
      case "/api/incidents/stats": return { incidents: { crowd: 1, wrong_way: 2 }, challans: { draft: 1 } };
      case "/api/offences": return { no_helmet: { label: "Riding without helmet", fine_inr: 1000, repeat_inr: 1000 }, wrong_way: { label: "Wrong-way driving", fine_inr: 5000, repeat_inr: 10000 } };
      case "/api/challans": return [{ id: "ch1", number: "CH-2026-0001", ts: now(), plate: "GJ05CD5678", label: "Wrong-way driving", section: "MV Act 184", fine_inr: 5000, camera_id: "police-cam2", status: "draft" }];
      case "/api/reports/anpr/review-queue": return events.slice(0, 5);
      case "/api/reports/anpr": return { week_start: "this week", week_end: "today", reads: events.length, reviewed: 3, accuracy_pct: 96, note: "Demo data.", cameras: CAMS.slice(0, 2).map((c) => ({ camera_name: c.name, reads: 12, reviewed: 2, accuracy_pct: 95, mean_confidence: 0.9, low_confidence_pct: 4, invalid_format_pct: 1, night_pct: 20, top_reasons: [["night", 1]] })) };
      case "/api/traffic": return { rows: Array(60), summary: CAMS.slice(0, 3).map((c) => ({ camera_name: c.name, windows: 60, avg_vehicles: 5, peak_vehicles: 9, avg_persons: 7, by_class: { car: 3, motorcycle: 2 }, flow: { a_to_b: 40, b_to_a: 31 }, last: now() })) };
      case "/api/incidents": return [{ id: "in1", ts: now(), label: "Crowd", kind: "crowd", priority: "high", zone: "Main gate", camera_id: "muni-cam1", detail: { persons: 31 } }];
      case "/api/watchlist": return state.watchlist;
      case "/api/hotlists": return { sources: [] };
      case "/api/persons": return state.persons;
      case "/api/analyses": return [];
      case "/api/devices": return [];
      case "/api/devices/types": return { types: { nvr: { label: "NVR / DVR", help: "Demo mode: nothing is saved." }, camera: { label: "Single IP camera", help: "Demo mode." } }, vendors: { hikvision: { adapter: "template" }, generic_onvif: { adapter: "onvif" } } };
      case "/api/capacity": return { relays: { relay: { healthy: true } }, record_mode: "anpr", departments: ["Police", "Municipal"].map((d) => ({ department: d, online: 2, cameras: 2, anpr_channels: d === "Police" ? 2 : 0, recorded: 1, pulls: 1, pull_cap: 8, viewers: 2, events_24h: 12, archive_gb: 3.2, archive_gb_per_day: 0.4, storage_estimate_gb_per_day: 0.5, relays: { relay: 2 } })) };
      case "/api/archive/stats": return { storage: "demo", record_mode: "anpr", departments: [] };
      case "/api/health/sla": return { fleet_uptime_pct: 99.2, days: +(q.get("days") || 7), cameras: CAMS.map((c) => ({ camera_id: c.id, name: c.name, department: c.department, status: c.status, uptime_pct: c.status === "online" ? 99.8 : 91.5, outages: c.status === "online" ? 1 : 6, downtime_min: 12, longest_outage_min: 8, quality: { verdict: "ok", sharpness: 120, brightness: 110 }, sla_met: c.status === "online" })) };
      case "/api/audit": return [{ id: 1, ts: now(), user: "admin", action: "login", target: "", detail: "demo mode", ip: "127.0.0.1", hash: "demo" }];
      case "/api/audit/verify": return { ok: true, rows: 1 };
      case "/api/compliance/status": return { identity: { local: true, ldap: false, oidc: false, mfa_required_roles: [], lockout: { failures: 5, seconds: 300 } }, audit: { hash_chain: { ok: true, rows: 1 }, certin_180_days: true, retention_days: 180 },
        retention: { default: { events_days: 90, clips_days: 30, crops_days: 30, recordings_days: 30 } }, legal_holds_active: state.holds.length, pii: { mask_plates: false, blur_faces: false }, encryption: { object_storage_sse: "none", tls_proxy: false, secrets: "env" } };
      case "/api/admin/users": return Object.values(USERS).map(({ user }) => ({ ...user, departments: ["*"], active_grants: 0 }));
      case "/api/admin/grants": return state.grants;
      case "/api/admin/holds": return state.holds;
      case "/api/admin/api-keys": return state.keys;
      case "/api/admin/webhooks": return { webhooks: state.hooks };
      case "/api/admin/notifications": return { channels: [], routes: [], log: [] };
      case "/api/tenants": return { tenants: [{ id: "default", name: "Default" }] };
      case "/api/admin/vendors": return { hikvision: { adapter: "template" }, generic_onvif: { adapter: "onvif" } };
    }
    let r;
    if ((r = m(/^\/api\/cases\/([^/]+)$/))) { const c = state.cases.find((x) => x.id === r[1]); return c ? caseDetail(c) : null; }
    if ((r = m(/^\/api\/vehicles\/([^/]+)\/movements$/))) {
      const plate = decodeURIComponent(r[1]).toUpperCase();
      const s = events.filter((e) => e.plate === plate).reverse().map((e) => ({ ...e, camera_name: camName(e.camera_id), lat: CAMS.find((c) => c.id === e.camera_id).lat, lon: CAMS.find((c) => c.id === e.camera_id).lon }));
      return { plate, sightings: s, cameras: [...new Set(s.map((x) => x.camera_id))], departments: [...new Set(s.map((x) => x.department))] };
    }
    if ((r = m(/^\/api\/registry\/([^/]+)\/history$/))) return { camera: { name: camName(r[1]), created_by: "adapter" }, changes: [], status: [] };
    if ((r = m(/^\/api\/registry\/([^/]+)$/))) return CAMS.find((c) => c.id === r[1]);
    if ((r = m(/^\/api\/cameras\/([^/]+)\/recordings$/))) return { camera_id: r[1], day: q.get("day"), count: 0, segments: [] };
    if ((r = m(/^\/api\/events\/([^/]+)\/clip$/))) return { status: "none" };
    if (m(/^\/api\/persons\/[^/]+\/sightings$/)) return [];
    return undefined;
  }

  // writes: keep a little state so forms visibly work
  if (p === "/api/auth/login") {
    // demo: any username / password signs in ("viewer…" names get the viewer role, everyone else is admin)
    const name = String(body.username || "").trim();
    if (!name || !body.password) throw Object.assign(new Error("enter a username and password (demo mode accepts any)"), { status: 401 });
    const base = name.toLowerCase().startsWith("viewer") ? USERS.viewer.user : USERS.admin.user;
    return { token: `demo-${name}`, user: { ...base, username: name } };
  }
  if (p === "/api/auth/logout") return {};
  if (p === "/api/watchlist") { const w = { plate: String(body.plate).toUpperCase(), reason: body.reason, priority: body.priority, added_by: "admin", expires_at: null }; state.watchlist.push(w); return w; }
  if (p === "/api/cases") { const c = { id: `c${++seq}`, number: `CASE-2026-${String(seq).padStart(3, "0")}`, title: body.title, reference: body.reference, priority: body.priority, owner: body.owner || "admin", status: "open", created_by: "admin", created_at: now(), updated_at: now(), items: [] }; state.cases.unshift(c); return caseSummary(c); }
  let r;
  if ((r = m(/^\/api\/cases\/([^/]+)\/items$/))) { const c = state.cases.find((x) => x.id === r[1]); const e = events.find((x) => x.id === body.ref_id);
    c.items.push({ id: `i${++seq}`, kind: body.kind, note: body.note, added_by: "admin", added_at: now(), meta: e ? { plate: e.plate, camera_name: camName(e.camera_id), ts: e.ts } : {} }); c.updated_at = now(); return {}; }
  if ((r = m(/^\/api\/cases\/([^/]+)\/items\/([^/]+)$/)) && method === "DELETE") { const c = state.cases.find((x) => x.id === r[1]); c.items = c.items.filter((i) => i.id !== r[2]); return {}; }
  if ((r = m(/^\/api\/cases\/([^/]+)$/)) && method === "PATCH") { Object.assign(state.cases.find((x) => x.id === r[1]), body, { updated_at: now() }); return {}; }
  if ((r = m(/^\/api\/alerts\/([^/]+)\/ack$/))) { state.alerts.find((a) => a.id === r[1]).ack_by = "admin"; return {}; }
  if ((r = m(/^\/api\/watchlist\/([^/]+)$/)) && method === "DELETE") { state.watchlist = state.watchlist.filter((w) => w.plate !== decodeURIComponent(r[1])); return {}; }
  if (p === "/api/bookmarks") { const b = { id: `b${++seq}`, ts: now(), camera_name: camName(body.camera_id), label: body.label, before_s: body.before_s, after_s: body.after_s, created_by: "admin", clip: "none" }; state.bookmarks.unshift(b); return b; }
  if (p === "/api/admin/grants") { state.grants.push({ id: `g${++seq}`, ...body, granted_by: "admin", value: body.value, expires_at: null }); return {}; }
  if (p === "/api/admin/holds") { state.holds.push({ id: `h${++seq}`, ...body, created_by: "admin", created_at: now() }); return {}; }
  if (p === "/api/admin/api-keys") { const k = { id: `k${++seq}`, name: body.name, prefix: "demo", features: body.features, departments: body.departments }; state.keys.push(k); return { ...k, key: "demo-key-not-real" }; }
  if (p === "/api/admin/webhooks") { const w = { id: `w${++seq}`, ...body, active: true, failures: 0 }; state.hooks.push(w); return { ...w, secret: "demo-secret" }; }
  if (m(/\/review$/)) return { verdict: body.verdict, plate: body.true_plate, number: "CH-2026-0001", status: body.action === "approve" ? "approved" : "rejected" };
  return { ok: true, demo: true };
}

/** Connect middleware for the Vite dev server. */
export function mockApi() {
  return async (req, res, next) => {
    if (!req.url.startsWith("/api/")) return next();
    const u = new URL(req.url, "http://demo");
    let body = {};
    if (req.method !== "GET" && (req.headers["content-type"] || "").includes("json")) {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
    }
    const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    try {
      const out = route(req.method, u.pathname, u.searchParams, body);
      if (out === undefined || out === null) return send(req.method === "GET" && out === undefined ? 200 : 404, out === undefined ? [] : { detail: "not found (demo mode)" });
      send(200, out);
    } catch (e) { send(e.status || 500, { detail: e.message }); }
  };
}
