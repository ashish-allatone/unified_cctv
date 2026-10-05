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
