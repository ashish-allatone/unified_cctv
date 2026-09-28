# Centralised CCTV registry & GIS mapping

The registry is the inventory layer under the viewing platform: **every camera in the State, integrated or not**,
with the metadata a planner needs (location, department, type, ownership, connectivity, storage, installation,
warranty, maintenance) and the reports that come from it (coverage gaps, ageing infrastructure, health). It is
the hackathon's foundational model; the viewing, analytics and recording models sit on top of the same rows.

Two kinds of rows live in the one `cameras` table:

| | integrated camera | registry-only camera |
|---|---|---|
| where it comes from | `config/sources.yaml` (adapters discover it, relay pulls it) | manual entry, CSV import or the API |
| `source_id` | the departmental source | `registry` (pseudo-source) |
| stream / recording / analytics | yes | no — inventory only |
| licence seat | yes | **no** (inventory entries never count) |
| editable in the registry | metadata only (stream stays with sources.yaml) | everything, incl. delete |
| health | live (`online` / `offline`, from the relay) | `not-integrated` |

Departments see their own rows (role departments + camera grants); `registry` (read) is on every role,
`registry_edit` (write) on supervisor / admin and on API keys that are granted it.

## Console → Registry

- **KPIs**: registered, integrated, registry-only, offline now, maintenance due / faulty, ageing / warranty
  expired, geolocated, metadata incomplete.
- **Filters**: free text (name, id, address, pole, make, tags), department, type, health, connectivity,
  ownership, maintenance, feed (integrated / registry only). Export CSV honours the filters.
- **Add camera** (manual entry), **Edit** (any metadata), **History** (audit trail of every change + health
  transitions), **Delete** (registry-only rows).
- **Import CSV**: the file is checked first (row-by-row errors, preview), then imported; existing ids are
  updated, new ones created; nothing is written while any row has an error.
- **Gap-analysis report**: grid cell, ageing threshold, retention policy, department → printable HTML, CSV of
  uncovered cells, or straight onto the map.
- **Locate by name**: cameras without coordinates are looked up on OpenStreetMap (Nominatim) from their names
  ("Paldi Circle", "Timbavadi gate, Junagadh"); review the proposals, apply the right ones, fine-tune with Edit.
  Also *Find on map by name* inside the Edit form. `GEOCODE_URL` points it at your own Nominatim when the VM has
  no internet; `GEOCODE_CONTACT` is the e-mail Nominatim's usage policy asks for.
- **Map**: colour by department / type / health / ownership / connectivity, coverage cones, registry-only
  cameras (dashed pins), and the *uncovered zones* overlay (red = blind spots next to existing cameras,
  amber = the largest holes).

## CSV schema (`GET /api/registry/template.csv`)

| column | type | values |
|---|---|---|
| `id` | text, optional | unique id; generated as `reg-<department>-<name>` when blank |
| `name` | text, **required** | |
| `department` | text, **required** | must be one the importing user can see |
| `lat`, `lon` | decimal degrees | both or neither |
| `heading` | degrees clockwise from north | blank = omnidirectional / PTZ |
| `fov` | degrees | default 70 |
| `range_m` | metres | default 80 |
| `camera_type` | enum | `fixed dome bullet ptz anpr thermal other` |
| `make_model`, `resolution` | text | |
| `ownership` | enum | `department vendor-managed leased private-shared other` |
| `owner_contact` | text | |
| `connectivity` | enum | `fibre lan 4g wifi offline-dvr none` |
| `storage_type` | enum | `nvr dvr cloud edge none` |
| `storage_days` | integer | retention |
| `install_date`, `warranty_until`, `last_maintenance` | `YYYY-MM-DD` | real dates |
| `maintenance_status` | enum | `ok due under_repair faulty decommissioned planned` |
| `address`, `zone`, `ward`, `pole_id` | text | |
| `tags` | `;`-separated | |
| `notes` | text | |
| *any other column* | text | kept under `meta` (e.g. `pole_no`, `circuit_id`) |

A sample of 120 cameras across four departments (Ahmedabad Municipal, Police, Transport, Gandhinagar
Municipal) is in `data/samples/registry_sample.csv`; the export / gap-analysis outputs produced from it are
beside it (`registry_export_sample.csv`, `gap_analysis_sample.html|pdf|json`, `coverage_gaps_sample.csv`).

## Registry API

Authentication: session JWT (`Authorization: Bearer …`) or a machine key (`X-API-Key`, Admin → API keys; grant
`registry` / `registry_edit`). Interactive OpenAPI at `/docs`.

| method & path | needs | what |
|---|---|---|
| `GET /api/registry?department=&camera_type=&status=&connectivity=&ownership=&maintenance=&zone=&integrated=yes\|no&q=&limit=` | registry | rows the caller may see, every field + `health`, `registry_only`, `age_years`, `warranty_expired` |
| `GET /api/registry/{id}` | registry | one row |
| `POST /api/registry` | registry_edit | onboard one camera (JSON, fields as the CSV columns; `id` optional) → 201 row; 409 if the id exists |
| `PATCH /api/registry/{id}` | registry_edit | change the fields sent; audited with the field names |
| `DELETE /api/registry/{id}` | registry_edit | registry-only rows (409 for feed-managed cameras) |
| `GET /api/registry/{id}/history` | registry | audit trail (`registry_*` actions) + health transitions |
| `GET /api/registry/template.csv` | registry | import template with one example row |
| `POST /api/registry/import?apply=0\|1` | registry_edit | multipart `file`; `apply=0` validates and previews, `apply=1` upserts (all-or-nothing) |
| `GET /api/registry/export.csv?…filters` | registry | filtered export, audited |
| `GET /api/registry/stats?age_years=5&min_storage_days=30` | registry | counts by department / type / health / connectivity / ownership / storage / maintenance; ageing, warranty, storage-below-policy, metadata-incomplete |
| `GET /api/registry/gaps?format=json\|csv\|html&cell_m=100&age_years=5&min_storage_days=30&department=` | registry | gap analysis (below) |
| `POST /api/registry/geocode` `{ids?, query?, apply?, limit?}` | registry_edit | coordinates from camera names (review, then `apply: true`); audited as `registry_geocode` |

Onboard from a script:

```bash
curl -s -X POST http://HOST:8000/api/registry -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{
  "name": "Paldi cross roads", "department": "Municipal", "lat": 23.0117, "lon": 72.5606, "heading": 0, "fov": 90, "range_m": 100,
  "camera_type": "bullet", "make_model": "Hikvision DS-2CD2T47", "ownership": "department", "connectivity": "fibre",
  "storage_type": "nvr", "storage_days": 30, "install_date": "2019-06-01", "maintenance_status": "ok", "zone": "West", "tags": ["junction"]}'

curl -s -X POST "http://HOST:8000/api/registry/import?apply=1" -H "X-API-Key: $KEY" -F file=@cameras.csv
```

Audit actions: `registry_create`, `registry_update` (with the changed field names), `registry_delete`,
`registry_import` (counts), `registry_export` (row count + filters), `registry_report`.

## Gap analysis — method

1. The area spanned by all geolocated cameras (plus one cell of padding) is divided into `cell_m` cells
   (default 100 m; the grid is capped at 40 000 cells, so a state-wide inventory is analysed at a coarser cell —
   the report states the cell size used).
2. A cell is **covered** when its centre or one of its quarter points lies inside the coverage cone of a
   *working* camera: heading ± fov/2 out to `range_m` (a circle for cameras without a heading); cameras that are
   offline, faulty, under repair or decommissioned do not count.
3. Uncovered cells are ranked by distance to the nearest camera. Two lists come out of it:
   **blind spots** (nearest camera ≤ 300 m — the cheap fixes: re-aim or add one on the same pole) and the
   **largest holes** (candidate sites for new installations). `near_coverage_pct` is the coverage within the
   footprint of the existing infrastructure, the honest number for a city; `coverage_pct` is over the whole
   bounding box.
4. Ageing = installed ≥ `age_years` ago or warranty expired; retention below `min_storage_days`; maintenance
   due / under repair / faulty; offline now; not geolocated (cannot be assessed).

The HTML report is self-contained and printable (Ctrl+P → PDF); the CSV lists every uncovered cell for GIS
tools (QGIS / ArcGIS load it as points).

## Gujarat hackathon deliverables → where they are

| deliverable | in this build |
|---|---|
| working registry portal with GIS map view | Console → Registry, Map (layers, legend, gap overlay) |
| bulk and manual onboarding demonstration | Import CSV (`data/samples/registry_sample.csv`) · Add camera · `POST /api/registry` |
| sample onboarded camera-metadata dataset | `data/samples/registry_sample.csv` (120 cameras, 4 departments), export in `registry_export_sample.csv` |
| registry API documentation | this page · `/docs` (OpenAPI) · Console → Registry → API |
| sample gap-analysis report | `data/samples/gap_analysis_sample.pdf` / `.html` / `.json`, `coverage_gaps_sample.csv` |
| health & maintenance-status monitoring | live health from the relay for integrated cameras, `maintenance_status` + last/next dates for all, history per camera |
| role-based search, filtering, export, audit trail | department scoping on every call, `registry` / `registry_edit` features, filtered CSV export, hash-chained audit log |
