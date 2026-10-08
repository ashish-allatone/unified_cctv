# Console operations (v1.6): audit log, notifications, daily reports, roles, archival

## Audit log — paging, filters, sorting, export

The Audit tab now works on any size of log:

- **Filters**: free-text search (user, action, target, detail, IP), user and action drop-downs (with counts),
  from / to time, 25–200 rows per page. Filters apply as you type.
- **Sorting**: click Time, User, Action, Target or IP; click again to flip the order.
- **Paging**: first / previous / numbered / next / last.
- **Export CSV**: the rows matching the current filters (up to 50,000) with full row and previous-row hashes,
  so an auditor can re-verify the chain offline. The export itself is an audit row (`audit_export`).
- **Verify chain** is unchanged.

API: `GET /api/audit?page=1&page_size=50&q=&user=&action=login,login_failed&target=&ip=&from=&to=&sort=ts|user|action|target|ip&order=asc|desc`
→ `{items, total, page, pages, page_size}`. `GET /api/audit?limit=N` still returns the plain list the
older tooling expects. `GET /api/audit/facets` gives the distinct users / actions; `GET /api/audit/export.csv`
takes the same filters.

## Notifications — bell, menu badge, dashboard

Every signed-in user has an in-console inbox (table `inbox`, per-user read state in `inbox_reads`). The count
of unread notifications shows on the **bell** in the top bar and as a **badge on the Notifications menu item**;
it updates live over the WebSocket and is re-read every 30 s. The bell opens the latest eight; the
**Notifications** page is the dashboard: unread / today / 7-day counts, a per-day chart by severity,
by kind and by severity, then the filterable, pageable list (kind, severity, unread only, search).
Clicking a notification marks it read and opens the related tab (Alerts, Sources, Admin, …).

| kind | what | who sees it |
|---|---|---|
| alert | watchlist hit / challan suggestion (critical when priority high) | users of the camera's department |
| incident | analytics incident with priority high / critical | department |
| camera | camera offline / back online | department, users with `sources` |
| device | device connected / changed / disconnected from the console | department, `sources` |
| detection | AI detection switched on / off (global or per camera) | everyone |
| security | break-glass, account lockouts, accounts created / changed / removed, role changes | `admin` |
| archival | archival run finished (with what it removed / held / errors) | `admin` |
| report | scheduled report ready (weekly ANPR accuracy) | `reports` |

API: `GET /api/notifications`, `/unread`, `/summary`, `POST /api/notifications/read {ids}|{all:true}`,
`POST /api/notifications/unread {ids}`. Workers in other processes write rows directly (`uvp.inbox.push`);
the API's `broadcast()` turns bus events into notifications.

Notifications are kept for the `notifications` archival class (default 90 days).

## Daily reports

Reports tab (feature `reports`; analysts, supervisors and admins by default). One row per IST calendar day
for the last 7–90 days, optionally for one department or one camera:

plate reads · unique plates · busiest camera · peak hour · alerts (by priority, acknowledged, watchlist vs
challan) · incidents (by kind, high priority, acknowledged) · challans (drafted, approved, fines) · traffic
(average vehicles, peak vehicles, peak traffic hour, peak people) · camera availability (uptime %, offline
minutes, drops, cameras mostly offline, from the status log) · uploads analysed · exports · sign-ins /
failed sign-ins · audit actions · notifications (critical).

KPI cards compare the second half of the period with the first (▲ / ▼). Charts: reads per day, alerts and
incidents per day, uptime per day, peak vehicles / people per day. **Export CSV** downloads the table
(audited as `report_export`); **Print** gives a clean printable page.

API: `GET /api/reports/daily?days=14&end=YYYY-MM-DD&department=&camera_id=` and `/api/reports/daily.csv`.
Figures are computed from the retained rows, so the report window is bounded by the archival policy of each
data class.

## Roles & permissions (dynamic)

Admin → **Roles & permissions** shows a matrix of permissions × roles. The four built-in roles (viewer,
analyst, supervisor, admin) are rows in the `roles` table and can be adjusted; **custom roles** are created
with a name and description, then ticked into shape and saved. Rules:

- creating / changing / removing roles needs a **super admin** once database accounts exist (any admin while
  the console still runs on `config/users.yaml` demo accounts);
- the admin role always keeps the `admin` permission; built-in roles cannot be removed;
- a custom role cannot be removed while an account still has it;
- `registry_edit` implies `registry`;
- every change is audited (`role_create` / `role_update` / `role_delete`) and raises a security notification.

**Live permissions**: tokens carry a roles version; when a role changes, every session with that role gets
the role's new permissions on its next request — no sign-out. The console re-reads `/api/auth/me` every
minute (and right after an admin saves a role) and re-applies the menu, with a toast. Time-bound grants and
break-glass still add to the role as before. The new-user form and `PATCH /api/users/{name}` accept any
defined role.

API: `GET /api/roles`, `POST /api/roles {name, description, features[]}`, `PATCH /api/roles/{name}`,
`DELETE /api/roles/{name}`. Permission ids and labels come with the `GET`.

## Archival policy system

Admin → **Archival policy** replaces the fixed hourly purge with policies per data class, optionally per
department, stored in `archival_policies`. Defaults still come from `config/rules.yaml → retention` (and the
built-in table), so an unchanged installation behaves as before.

| data class | default keep | archive possible |
|---|---|---|
| recordings (recorded segments) | 30 d | yes — copied to `cold/recordings/...` first |
| clips (10 s event clips) | 90 d | yes |
| crops (plate crops, evidence frames) | 90 d | yes |
| events (plate-read rows + search index) | 365 d | yes — rows exported as gzip JSON-lines |
| alerts | 365 d | yes |
| incidents | 180 d | yes |
| counts (traffic / crowd) | 365 d | yes |
| camera_logs (status transitions, quality samples) | 90 d | delete only |
| uploads (Upload & recognise jobs) | 30 d | delete only |
| notifications (in-console + delivery log) | 90 d | delete only |
| audit | 365 d, **never below 180** (CERT-In) | yes — exported before the trim; the trim is audited |

- **Then**: `delete`, or `archive to cold, then delete` — objects are server-side copied to
  `ARCHIVAL_COLD_PREFIX/` (default `cold/`, with `S3_COLD_CLASS` as storage class, e.g. an infrequent-access
  tier) and removed rows are written as `cold/<class>/<date>/<run>.jsonl.gz` before deletion.
- **Legal holds always win**: held plates / events / camera windows are skipped and counted in `held`.
- **Due now** shows what a run would act on; **Run now** executes immediately (audited `archival_run`);
  the archiver runs once a day at **ARCHIVAL_HOUR_IST** (default 02:00, changeable on the page, can be paused).
- **Run history** (`archival_runs`, kept one year): trigger, who, status, removed / archived counts per
  department and class, held, errors. Each run also posts an `archival` notification to admins.
- `+ Dept` adds a department-specific rule for a class (e.g. Police keeps recordings 60 days); `Reset`
  returns a console override to the default.

API: `GET /api/archival`, `GET /api/archival/preview`, `PUT /api/archival/policies/{class}`,
`DELETE /api/archival/policies/{class}?department=`, `PUT /api/archival/schedule`, `POST /api/archival/run`,
`GET /api/archival/runs`. `python -c "from uvp.services.archiver import apply_retention; print(apply_retention())"`
still runs the policies once from the command line.

## Database changes (automatic on start)

New tables: `roles` (seeded with the built-ins), `inbox`, `inbox_reads`, `archival_policies`,
`archival_runs`. No columns of existing tables changed. Nothing is lost on redeploy.


## VIP routes & corridors (v1.7)

Map → **VIP routes & corridors**. A route is either a journey between places (e.g. *Amroha → Delhi*), a road
inside an area (e.g. *NH24 in Delhi*), or both. **New route** asks for:

- *Places along the route* — one per line; names are located with the geocoder (Nominatim), or give `lat, lon`.
  With **follow roads** on, the path follows the actual road through an OSRM-compatible router
  (`ROUTING_URL`, default the public OSRM demo server; set your own or leave empty for straight lines).
- *Match cameras within (m)* — every camera within that distance of the path is on the route (default 500 m;
  use 2–5 km with straight lines).
- *Road keyword(s)* — e.g. `NH24, NH-24`: matched against the camera's address, name, pole id, tags, notes.
- *Area keyword(s)* — e.g. `Delhi`: matched against zone, ward, address, department, name.
- *Priority* VIP marks the route red and lists it first.

The route's cameras are listed **in order of distance from the start** (km marks), drawn on the map, and
**Open on wall** puts them on the video wall in that order (the wall toolbar also has a *VIP routes…* picker).
Cameras can be force-included or excluded when editing (API `camera_ids` / `exclude_ids`). Everything is
scoped to the cameras the user may see. API: `GET/POST /api/routes`, `GET/PATCH/DELETE /api/routes/{id}`,
`POST /api/routes/preview`, `GET /api/routes/geocode?q=`.

## External APIs from the console — Vahan, Sarathi (v1.7)

Admin → **External APIs**: three cards (Vahan vehicle registration, Sarathi driving licence, Custom). Fill in
the URL with the placeholder (`{plate}` / `{dl}` / `{value}`), method, auth (header / bearer / basic / query /
none), the key (stored encrypted with Fernet under TOKEN_SECRET; never shown again), extra headers, timeout and
cache; **Test** calls the API with a sample value and shows the fields it returns. Nothing in `.env` or yaml is
needed (the old `VAHAN_URL` / `VAHAN_HEADERS` still work as a fallback).

Investigators use them from **Search → Vahan / Sarathi** boxes (needs `plate_search`); results are cached for
`cache_s` and every lookup is audited (`vahan_lookup`, `sarathi_lookup`). `GET /api/lookup/{vahan|sarathi|custom}/{value}`.


## Pagination on every table (v1.7.1)

Every table in the console (search results, alerts, incidents, challans, watchlist, persons, cases, registry,
sources, devices, playback, bookmarks, users, grants, holds, API keys, webhooks, notification log, uploads …)
pages automatically once it holds more than 25 rows: a pager under the table with 10 / 25 / 50 / 100 / all rows
per page (remembered per table in the browser). Server-side paging stays where the data set is large (Audit,
Notifications); the search dashboard now fetches up to 1,000 reads per query.


## v1.8 — console layout, per-camera access, notification preferences, geofences

- **Menu toggle** (☰) in the top bar collapses / expands the sidebar (same as *Collapse* at the bottom).
- **Admin sub-menu**: Administration now has its own left menu — Compliance · Users · Roles & permissions ·
  Access grants · Legal holds · Archival policy · DPDP requests · External APIs · Notifications · API keys ·
  Webhooks · Tenants & presets. One section shows at a time; the last one is remembered.
- **Per-camera access**: Admin → Users → **Access** opens the account's role, departments and an explicit
  camera list. *No department + ticked cameras* gives a guard exactly those cameras on the wall, map,
  registry, search and alerts — and only notifications about them (the inbox also matches the camera id).
  The create-user form has the same camera picker. Changes apply at the account's next sign-in.
- **Notification preferences** (bell → ⚙, or Notifications → Preferences): which kinds reach you, minimum
  severity, pop-ups, speak aloud (and from which severity), badge on/off. Stored per user; applied to the
  list, the badge and the live WebSocket fan-out, always within the user's permissions.
- **VIP route form**: explicit *Source*, *Destination* and optional *Via* places, plus **Allocate cameras** —
  a multi-select of all registered cameras that are always part of the route (even off the path).
- **Geofences** (Map → Geofences → New geofence → *Pick on map*): click once for a circle centre (radius in m)
  or click the corners of a polygon and press Done. The cameras inside are listed and can be opened on the
  wall; alerts / incidents / camera events from those cameras raise a `geofence` notification with the
  chosen severity. API: `GET/POST /api/geofences`, `/preview`, `GET/PATCH/DELETE /api/geofences/{id}`.
- **Break-glass** button is hidden (code kept behind a flag). **AI detection is locked ON**
  (`DETECTION_LOCKED=1`, the default): the Detection switch, tile *Detect* buttons and *AI on/off* badges are
  gone and `POST /api/detection` answers 423; set `DETECTION_LOCKED=0` to bring the switch back.


## v1.8.1 — location drop-downs in the route editor, "nearest camera" hint, voice clip upload hardening

- **Source / Destination / Via are drop-downs.** Click the field and choose from *Areas with cameras* (the zones,
  wards and localities taken from the cameras' registry entries, with the number of cameras there), *Saved places*
  (places used by other routes), *Geofences* (their centres) and *Camera sites* (every camera with coordinates).
  Typing filters the list; three or more letters also searches the map (geocoder). Everything in the list already
  has coordinates, so nothing is geocoded when the route is saved — a locality cannot end up in the wrong city.
  `lat, lon` and free text (located automatically) still work. Via places are chips, in order, with × to remove.
- **Geocoder biased to the deployment**: free-text names are searched around the centre of the registered cameras
  first (*Janpath* in an Ahmedabad installation is Janpath, Ahmedabad; not the one in New Delhi). Hovering a route's
  places on the Map shows where each was located.
- **Nothing matched?** The route panel and the editor preview now say which camera is nearest to the route and
  how far (e.g. *Nearest is Janpath Hotel Ashram Rd, 6.5 km away*) with a one-click **widen to N m** button, instead
  of the bare "No cameras match this route yet". API: `nearest` on `GET /api/routes`, `/api/routes/{id}` and
  `/api/routes/preview`; drop-down data from `GET /api/routes/places?q=&geocode=true`.
- **Voice calls — clip upload.** When the dialer's `/uploadSound` fails (its Tomcat answers a bare HTTP 500), the
  log now shows the server's actual message instead of HTML, the clip is retried in the other format (WAV 8 kHz →
  MP3) and under a plain alphanumeric name, and the call still goes out with the dialer's own text-to-speech.
  Clips are uploaded **once per sentence**: the sound id is remembered (setting `voice_sounds`) and reused, so test
  calls and repeated alerts do not depend on the upload service at all after the first success. `clip_format: mp3`
  on the channel makes MP3 the first choice.


## v1.9 — Permission settings (camera permission table)

Admin → **Permissions** (first entry of the Admin menu) is a bucket-style permission table: *who* may do *what* on
*which cameras*.

- **+ Grant permission**: tick the **cameras** — several at once: all cameras, departments, **VIP routes** (the row
  follows the route's cameras as the route changes) and single cameras (grouped by department; type to search) — then
  **grant to** a *Role* or a *User*, tick the **permissions** — **Live** (watch the stream), **Playback**
  (recordings, clips, bookmarks), **Export** (evidence bundles / downloads), **Search** (plate reads and movement
  from the camera), **Alerts** (see and acknowledge its alerts), **Edit** (its registry entry) — and optionally an
  **expiry** and a reason.
- The table shows scope · granted to · type (role, or the user's role) · the six permission chips (grey = not
  granted) · expires · who granted it, with ✎ change and 🗑 revoke; filters by scope, type and text. **History**
  lists revoked and expired rows.
- **Applies at once**: sessions carry a permissions version, so a grant or revoke reaches signed-in users on their
  next request — no sign-out, no waiting for a new login (unlike the departments / cameras set on the account).
- Rows are **additive**: they never take away what the role already allows on the cameras the account sees through
  its departments or explicit camera list. For cameras an account sees *only* through a permission row, exactly the
  row's permissions apply: the wall shows the stream only with Live, Bookmark / Playback only with Playback, the
  Evidence button only with Export, and the API answers 403 / 404 for anything else. `GET /api/cameras` carries
  each camera's `perms`; `GET /api/permissions/mine` lists them for the signed-in account.
- A permission also brings the console feature it needs (Playback → playback, Export → export, Search → search +
  plate numbers + movement, Alerts → acknowledge alerts, Edit → registry edit), so a viewer given Playback on one
  camera gets the Playback tab for that camera.
- Every change is audited (`perm_grant` / `perm_update` / `perm_revoke`) and raises a *security* notification.

API: `GET /api/permissions?status=active|history&scope=&grantee_kind=&q=`, `GET /api/permissions/options`,
`POST /api/permissions {scope_kind: camera|department|route|all, scope_value, grantee_kind: user|role, grantee, perms[], expires_at?, reason?}`
(or `scopes: [{scope_kind, scope_value}, …]` for several at once → one row each, returned as `{items, count}`),
`PATCH /api/permissions/{id}`, `DELETE /api/permissions/{id}` (revoke). New table `camera_permissions` (automatic).
*Access grants* (time-bound feature / camera / department grants with a reason) and the per-user *Access* dialog
remain for the cases they cover.

### v1.9.1

- Grant dialog picks **several cameras / departments / VIP routes at once** (one row each); a **VIP route** is a
  scope of its own and follows the route's camera list.
- The Permissions table refreshes itself: after a grant it returns to the *Permissions* tab, it re-reads every 30 s
  while open and immediately when a permission notification arrives; ⟳ / + Grant work even if the first load failed.
- Faster recovery when the API restarts: a failed read is retried once before "Cannot reach the server" is shown, the
  watcher probes every 1.5 s (was 3 s), and sessions whose permissions changed re-read their access once per change
  instead of on every request.

### v1.9.2 — vehicles seen on several cameras

Sidebar → **Multi-camera** (Investigate; v1.9.3 — its own page, was a panel under Vehicle movement): which number plates were read on more than one camera in a
time window (default: last 24 h). *At least N cameras* (2–5), or tick **Must include these cameras** to get only the
plates read on *every* ticked camera (entered at A and left at B); optional vehicle type. Each row: plate, number of
cameras, the cameras in the order the vehicle passed them, first / last seen, span, sightings, **Trace** (opens the
full route above) and **CSV**. Plates are masked for users without `plate_search`; every query is audited
(`multi_camera_query`). API: `GET /api/vehicles/multi-camera?since=&until=&min_cameras=2&cameras=a,b&vehicle_type=&limit=`
→ `{items, total, truncated}`.

**Any period (v1.9.4)**: the 31-day cap is gone — the grouping runs in the database, so a whole year is one query.
**Period** presets: last 24 h / 7 / 30 / 90 days, this year, last year, *pick a year* (last six), or custom From / To.
The page shows the first 500 vehicles (most cameras first) and says how many more there are. Note that plate
reads are kept for the `events` archival class (365 days by default, Admin → Archival policy); older reads have
been archived to cold storage and are not searched here.

### v1.9.5 — search several cameras at once

- **Search → Cameras** is a multi-select: Ctrl / Cmd-click two or more cameras to search their reads together
  (nothing selected = all). The result title says "… on N cameras"; **Export signed CSV** follows the same selection.
  API: `GET /api/events?camera=cam-a,cam-b` (and `/api/events/export.csv`) — the SQL and Elasticsearch backends both
  accept the comma-separated list.
- **Multi-camera → Plate (optional)**: narrow the multi-camera list to a plate or pattern (`GJ01*`, `*1234`);
  needs `plate_search`.


## v2.0 — React console (phase 1)

The console now has a **React + TypeScript shell** (`platform/web-react`, Vite): login (password, 2FA, first-run
sign-up, SSO return), sidebar / topbar / bell / live WebSocket / Hindi-Gujarati / theme, and these pages rebuilt in
React — **Notifications** (dashboard, list, preferences) and **Admin → Permissions, Users, Roles & permissions**.
Every other page opens the existing console inside the shell (`/legacy/`, same session) until it is rebuilt, so
nothing is lost: the sidebar, URL (`/map`, `/admin/holds`, …) and permissions behave the same everywhere.
Look and feel are unchanged (the same `styles.css`). Build happens inside the Docker image (Node stage), so
`docker compose build api && docker compose up -d api` deploys it; the API serves React at `/` and the legacy console
at `/legacy/`. Details and how to migrate the next page: `platform/web-react/README.md`.
