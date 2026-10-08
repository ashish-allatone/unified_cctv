# Unified CCTV Viewing Platform (pilot)

**Unified CCTV by Allatone** — console branding in `platform/web/brand/` (logo, mark, favicon, PWA icons).

One web console for CCTV feeds from several departmental VMS, with ANPR and searchable
vehicle-movement records. Departmental systems are not changed: the platform reads from them
with one read-only account each, pulls each stream once, and stores only metadata.

```
Departmental systems (unchanged)          Unified viewing platform
 Police NVR  ──ONVIF + RTSP (read-only)──►  adapters ─► relay (MediaMTX) ─WebRTC/HLS─► web console
 Municipal VMS ─REST API + RTSP (read-only)─►     │            │ RTSP
                                                  │            ▼
                                             camera registry   ANPR workers ─► Kafka ─► indexer ─► PostgreSQL
                                                                                              └─► Elasticsearch
```

## Deploying (Jenkins → OCIR → OKE)

`DEPLOYMENT.md` is the hand-over for DevOps: one Dockerfile per service (`api/`, `archiver/`, `anpr/`,
`faces/`, `analytics/`, `adapters/`, `hotlist/`, `indexer/`, `mediamtx/`), ports, environment variables,
health endpoints, volumes, resources, stateless/stateful list, image tags, and the `Jenkinsfile` that builds,
pushes and applies `deploy/k8s/manifests.yaml`. The single-VM pilot keeps using `docker-compose.yml`.

## What is in the box

| Deliverable | Where |
| --- | --- |
| Unified viewer on two different systems (ONVIF NVR and vendor REST VMS) | `platform/web`, `platform/uvp/adapters`, `simulators/` |
| ANPR on live and recorded feeds | `platform/uvp/services/anpr_worker.py` (`--file` for recorded clips) |
| Searchable metadata dashboard | Search, Vehicle movement, Alerts, Watchlist tabs |
| Video archive in object storage (clips, crops, recordings, retention) | `platform/uvp/storage.py`, `platform/uvp/services/archiver.py`, Playback tab |
| Security & compliance (SSO/LDAP, MFA, RBAC grants, break-glass, signed exports, legal hold, DPDP) | `platform/uvp/auth.py`, `rbac.py`, `pii.py`, `signing.py`, Admin tab, `docs/compliance.md` |
| Investigation (cases, chain of custody, court bundle PDF, timeline stitching, bookmarks, GIS map) | `platform/uvp/investigation.py`, `services/routes_investigation.py`, Cases / Map tabs |
| Analytics (vehicle attributes, traffic rules, zone analytics, challans, hotlists) | `platform/uvp/analytics/`, `services/analytics_worker.py`, `routes_analytics.py`, `hotlist_sync.py`, Violations tab, `docs/analytics.md` |
| Operations (tenants, camera SLA + quality, notifications, API keys, webhooks, Vahan, PWA, vendor presets) | `platform/uvp/notify.py`, `tenancy.py`, `services/routes_ops.py`, `platform/web/m/`, `config/vendors.yaml`, `docs/operations.md` |
| HA & scale (relay cluster + failover, metrics/Grafana, capacity, sharding, GPU, edge outbox, Kubernetes; State-scale sizing in `docs/scale.md`) | `platform/uvp/relay.py`, `metrics.py`, `deploy/monitoring/`, `deploy/k8s/`, `platform/Dockerfile.gpu`, `docs/ha.md` |
| Product (installer/updater, licensing, Hindi UI, accessibility, ANPR accuracy programme) | `scripts/install.sh`, `platform/uvp/licensing.py`, `reports.py`, `platform/web/i18n/`, `docs/product.md` |
| Centralised CCTV registry & GIS (inventory of every camera incl. non-integrated ones, CSV/manual/API onboarding, map layers, gap analysis, export, audit) | `platform/uvp/services/routes_registry.py`, Registry + Map tabs, `data/samples/registry_sample.csv`, `docs/registry.md` |
| Evidence that departmental systems are unaffected | `tests/test_non_interference.py` → `docs/reports/non_interference.md` |
| ANPR accuracy measurement | `scripts/eval_anpr.py` → `docs/reports/anpr_accuracy.md` |

## Product: install, licence, languages, accuracy programme

See `docs/product.md`: `scripts/install.sh` / `install.ps1`, `scripts/update.sh`, `scripts/backup.sh`,
signed licence files with camera / ANPR / analytics channel limits (evaluation mode without one), English /
Hindi console and field app, accessibility (keyboard, ARIA, reduced motion), and the ANPR accuracy programme:
review queue, corrections, weekly per-camera accuracy report and OCR retraining-set export.

## Quick start A: Docker (full stack with Kafka and Elasticsearch)

```bash
cp .env.example .env          # change every secret
docker compose --profile sim up -d --build
python scripts/seed_demo.py   # adds 3 demo watchlist plates
# open http://localhost:8000   admin / admin123
```

The `sim` profile renders synthetic traffic footage (about 3 minutes, once) and starts two
simulated departments. Leave `--profile sim` off and edit `config/sources.yaml` to connect real
systems.

## Quick start B: one machine, no Docker ("lite")

Needs Python 3.11+, ffmpeg and the [MediaMTX](https://github.com/bluenviron/mediamtx/releases)
binary on `PATH`. Uses SQLite and direct HTTP instead of Kafka/Elasticsearch; the code paths are the same.

```bash
pip install -r platform/requirements.txt
python simulators/traffic_synth.py --out data/media      # synthetic footage, 8 cameras
cp .env.example .env
scripts/lite.sh start
python scripts/seed_demo.py
# open http://localhost:8000   admin / admin123
scripts/lite.sh status | stop | restart <service>
```

Demo users: `admin/admin123`, `supervisor/super123`, `police_op/police123` (Police cameras only),
`muni_op/muni123` (Municipal only), `viewer/viewer123` (live view only).

## Connecting a real departmental system

Add one entry to `config/sources.yaml`. Credentials come from environment variables.

| Adapter | Use for | Read-only calls it makes |
| --- | --- | --- |
| `onvif` | ONVIF Profile S/T NVRs and cameras | GetCapabilities, GetDeviceInformation, GetProfiles, GetStreamUri |
| `vendor_rest` | VMS with an HTTP API (endpoints and field names configurable per vendor) | login POST, then GET only |
| `rtsp` | Systems that publish fixed RTSP URLs | RTSP OPTIONS / DESCRIBE / PLAY |
| `sdk_bridge` | SDK-only VMS: a small bridge republishes live view to the relay | SDK login, channel list, live view |

Per source you also set `max_concurrent_pulls` (the agreed stream cap) and, per camera, a location
and whether ANPR is on. Enable ANPR only on cameras mounted for plate capture.

## How non-interference is enforced

1. **Read-only in code.** `ReadOnlyHTTP` rejects any non-GET request or non-allowlisted SOAP action.
2. **One pull per stream.** The relay fans one departmental stream out to any number of viewers and ANPR.
3. **On demand.** Pulls start when someone watches and close 10 s after the last viewer leaves.
4. **Stream cap.** `/internal/relay-auth` refuses a new stream once a source reaches its cap.
5. **Light health checks.** One request per source every 20 s; full camera discovery every 5 min.
6. **No re-reading for the archive.** The platform's own archive is written from the relay's copy of the
   stream (the one pull ANPR already needs). Recorded cameras are pulled continuously, count against the
   source's stream cap, and are chosen by `RECORD_MODE`. Departmental recordings stay in the department's VMS.

Run `python tests/test_non_interference.py` (lite stack running) to produce the evidence report.

## Security and compliance

See `docs/compliance.md` for the control-by-control list. In short: sign-in through local users, LDAP/Active
Directory or OpenID Connect SSO (`config/auth.yaml`), TOTP two-factor with backup codes, account lockout,
feature-level RBAC with time-bound grants and per-camera access, break-glass emergency access with
justification and live admin notification, hash-chained audit log (`Audit → Verify chain`), Ed25519-signed
and watermarked exports, per-department retention with legal holds, DPDP subject-access and erasure
endpoints, plate masking for roles without `plate_search`, face blurring in evidence frames, TLS front door
(`docker compose --profile tls`), secrets from files or Vault, and server-side encryption for the archive.

Admin → the compliance cards show which of these are switched on in the running deployment.

Console operations (`docs/console.md`): the Audit tab pages, filters, sorts and exports the hash-chained log;
an in-console **notification centre** (bell + menu badge + dashboard page) collects alerts, incidents, camera
health, device, detection, security and archival events; a **Reports** tab gives day-wise operations
figures with CSV export; **roles & permissions** are editable (custom roles, live permission changes); and an
**archival policy** page sets keep-days and delete / archive-to-cold per data class and department, with
preview, run-now, schedule and run history (legal holds always win; audit never below 180 days).

## Analytics beyond ANPR

See `docs/analytics.md`. Vehicle type, colour, plate colour and rider count on every plate read
(bundled Apache-licensed COCO detector), searchable in Search; traffic rules on plate reads
(wrong way, two-camera over-speed, triple riding, non-standard plate, helmet with a customer model);
zone analytics on any camera (perimeter intrusion, abandoned object, crowd density, illegal parking,
red light with in-picture / schedule / ITMS signal state) in `config/analytics.yaml`; every violation
becomes an alert and a **challan draft** reviewed in the Violations tab and handed to the e-challan
system with a signed payload; external stolen/wanted-vehicle **hotlists** synchronised into the watchlist.
Face search is a disabled, legally gated module.

## High availability and scale

See `docs/ha.md`: relay cluster with rendezvous-hashed camera assignment and automatic failover
(`RELAY_APIS`, `--profile ha`), Prometheus metrics on every service + Grafana dashboard + alert rules
(`--profile monitoring`), capacity per department, ANPR sharding (`ANPR_SHARD=i/n`) and a GPU image
(`platform/Dockerfile.gpu`), edge ANPR with a durable outbox (`EDGE=1`), validated Kubernetes manifests
(`deploy/k8s/render.py`) with HPA/KEDA, and guidance for HA PostgreSQL / Kafka / Elasticsearch.

## Operations and integration

See `docs/operations.md`: multi-tenancy (`config/tenants.yaml`), camera health SLA with image-quality
sampling and helpdesk tickets, email / SMS / WhatsApp / CAD notification routing (`config/notify.yaml`),
API keys and signed subscriber webhooks (Admin tab; OpenAPI at `/docs`), Vahan registration lookup connector,
field-officer PWA at `/m/`, and vendor presets (`vendor: hikvision|dahua|cpplus|uniview|axis|honeywell|bosch|milestone|genetec`).

## Investigation tooling

- **Cases** (`Cases` tab): open a case with FIR reference, priority and assigned officer; file sightings
  (`+ Case` on any search row), bookmarks, recordings, stitched timelines and notes; close/reopen. Every touch
  is written to a hash-chained **chain of custody**. **Export bundle** produces `report.pdf` (case summary,
  evidence table with thumbnails, file hashes, custody log, certificate block for s.63 BSA / s.65B), the
  watermarked media, `manifest.json` and an Ed25519 `manifest.sig`.
- **Timeline reconstruction**: Vehicle movement → `Stitch clips` joins every archived clip of a plate in the
  window into one captioned MP4 (camera + IST time), optionally filed straight into a case;
  `/api/vehicles/{plate}/timeline` also gives leg times, distances and implied speed between cameras.
- **Bookmarks**: `Bookmark` on a wall tile keeps ±10 s around "now"; Playback → Bookmarks for a past moment.
  Clips are cut from the relay buffer, or from archived segments if the buffer has moved on.
- **Map** (`Map` tab, Leaflet bundled offline): cameras with coverage cones from `heading` / `fov` /
  `range_m` in `sources.yaml`; click the map to rank the nearest cameras to an incident and see which ones
  actually cover the point. Street tiles come from OpenStreetMap when internet is available; set your own
  tile server in `app.js` (`tile.openstreetmap.org`) for air-gapped control rooms.

## Video archive in object storage

What is stored, and where in the bucket:

| Object | Key | When |
| --- | --- | --- |
| Event clip (`CLIP_BEFORE_S` + `CLIP_AFTER_S` around the plate read, MP4) | `clips/<dept>/<camera>/<day>/<event>.mp4` | every ANPR event on a recorded camera |
| Plate crop and annotated frame | `crops/<dept>/<camera>/<day>/<event>_plate.jpg`, `_frame.jpg` | every ANPR event |
| Recorded segment (main profile, fMP4, `RECORD_SEGMENT_S`) | `recordings/<dept>/<camera>/main/<day>/<HH-MM-SS>.mp4` | continuously for recorded cameras |

How it works: the relay (MediaMTX) writes segments for recorded cameras to a small local buffer
(`RECORD_LOCAL_KEEP`, default 6 h) and serves a playback API over them. The **archiver** service cuts each
event clip from that buffer, copies clips, crops and completed segments to object storage, registers them
in the `recordings` table / event rows, and applies the archival policies (Admin → Archival; defaults from
`config/rules.yaml` `retention:`) once a night. Playback links are presigned URLs (S3) valid for `S3_URL_TTL_S`, or served by
the API for the `local` backend; every clip or recording access is written to the audit log and scoped by
department like everything else.

Choosing what to record: `RECORD_MODE=none|anpr|all` (default `anpr`), overridable per source or camera in
`sources.yaml` with `record: true|false`.

Oracle Cloud Object Storage: create a bucket, then a *Customer Secret Key* for the platform's user
(Identity → Users → Customer Secret Keys). Set in `.env`:

```
OBJECT_STORAGE=s3
S3_ENDPOINT=https://<tenancy-namespace>.compat.objectstorage.<region>.oraclecloud.com
S3_REGION=<region>            # e.g. ap-mumbai-1 or ap-hyderabad-1
S3_BUCKET=<bucket name>
S3_ACCESS_KEY=<access key>
S3_SECRET_KEY=<secret>
S3_PATH_STYLE=1
```

The namespace is shown under Object Storage → Bucket details ("Namespace"). The same settings work for
AWS S3 (leave `S3_ENDPOINT` empty), MinIO and Ceph. UI: **Playback** tab lists a camera's archived segments
for a day; the **Clip** button in Search plays the event clip; **Sources** shows what the archive holds.

Storage estimate: a 1080p H.264 main stream is roughly 1–2 GB per camera per hour; clips are ~3 MB each.

## Tests

```bash
python -m pytest tests/test_plates.py          # Indian plate validator/corrector
python tests/e2e_ui.py                         # browser test: wall, search, movement, alerts, scoping
python tests/test_non_interference.py          # evidence report (about 3 min)
python scripts/eval_anpr.py                    # ANPR accuracy on recorded clips
```

## Measured on the build machine (2 vCPU, no GPU, synthetic footage)

- Video wall: 8 live tiles from 2 departments over WebRTC.
- ANPR: 98.1% exact-plate accuracy (152 of 155 vehicles, 4 cameras) with PaddleOCR (PP-OCRv4) and character-level voting; see `docs/reports/anpr_accuracy.md`.
- Non-interference: 7 of 7 checks passed (see `docs/reports/non_interference.md`).

## Known limits of this pilot build

- The Kafka and Elasticsearch code paths and `docker-compose.yml` were written to spec and
  validated with `docker compose config`, but only the lite stack (SQLite, HTTP bus, SQL search) was
  run end to end on the build machine.
- Browsers without H.264 (some Linux Chromium builds) get an on-demand VP8 transcode from the relay.
  Chrome, Edge and Safari play H.264 directly. H.265 sources need the same transcode path.
- Users are in `config/users.yaml`; connect LDAP/OIDC before production.
- Enable TLS on the web UI, relay and Elasticsearch outside an isolated pilot network.
