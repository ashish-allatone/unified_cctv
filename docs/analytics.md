# Analytics beyond ANPR

What runs where, how to configure it, and the contracts for the pieces that need something from
outside the platform (customer models, government feeds, the e-challan system).

## Vehicle attributes (on every plate read)

Computed by the ANPR worker at event time (`platform/uvp/analytics/attributes.py`) and stored on the
event (`vehicle_type`, `vehicle_colour`, `plate_colour`, `make_model`, `attrs`), searchable in the Search
tab (Vehicle / Colour filters) and via `/api/events?vehicle_type=two_wheeler&colour=white`.

| Attribute | Method | Notes |
| --- | --- | --- |
| Type | COCO detector (bundled YOLOX-nano, Apache-2.0) box containing the plate → car / two_wheeler / bus / truck / bicycle | falls back to plate geometry (two-row, near-square plate → two_wheeler; else light_vehicle) |
| Colour | dominant HSV colour of the body region above the plate | white, silver, grey, black, red, blue, yellow, green, orange, brown; night/IR frames give grey/black |
| Plate colour | HSV of the plate crop | white private, yellow commercial, green EV, black rental |
| Riders | persons overlapping a motorcycle box | 3+ → `triple_riding` |
| Make/model | **customer-supplied** ONNX classifier | see contract below |
| Helmet | **customer-supplied** ONNX classifier on rider head crops | see contract below |

### Classifier contract (make/model, helmet)

`ANALYTICS_MAKE_MODEL_MODEL=platform/models/make_model.onnx`, `ANALYTICS_HELMET_MODEL=platform/models/helmet.onnx`

- ONNX, one input `NCHW float32` (N=1, RGB, 0–1 scaled, ImageNet mean/std normalised), square (size read from the model).
- One output: logits or probabilities, one column per label.
- Labels: a `.txt` next to the model, one label per line, same order as the output columns.
  Helmet labels must include `helmet` and `no_helmet`.
- Input crops: make/model gets the vehicle detection box; helmet gets the top third of each rider's person box.
- A model that fails to load is logged and skipped; the rest of the attributes still run.

A model trained on Indian two-wheelers (helmet) and Indian vehicle catalogues (make/model) is required for
useful accuracy; no such model is bundled and none is claimed.

## Traffic rules on plate reads (indexer)

`config/analytics.yaml → cameras`, evaluated by `platform/uvp/analytics/rules.py` on every event:

| Rule | Configuration | Detail recorded |
| --- | --- | --- |
| `wrong_way` | `allowed_direction: towards|away` per camera | observed vs allowed |
| `over_speed` | `pairs: [{from, to, distance_m, limit_kmh, max_minutes}]` | average km/h between the two reads, previous event id |
| `triple_riding` | automatic (detector) | rider count |
| `no_helmet` | needs `ANALYTICS_HELMET_MODEL` | per-rider verdicts |
| `non_standard_plate` | automatic (series unreadable → `????`) | – |

Each violation tags the event, raises a rule alert and drafts a challan (below).

## Zone analytics (analytics worker)

`python -m uvp.services.analytics_worker` reads the relay's **sub** stream of each camera listed under
`cameras:` with zone rules, at `ANALYTICS_FPS` (default 2), runs the detector, and evaluates
`platform/uvp/analytics/zones.py`:

| Kind | Configuration | Trigger |
| --- | --- | --- |
| `intrusion` | `intrusion.zones: [{name, polygon, hours, classes}]` | a tracked object of a listed class inside the polygon during the hours |
| `abandoned_object` | `abandoned_object: {polygon, min_seconds, min_area}` | a static foreground blob (MOG2) not explained by any person/vehicle for `min_seconds` |
| `crowd` | `crowd: {polygon, max_persons}` | more persons than `max_persons` in the polygon |
| `illegal_parking` | `no_parking: {polygon, min_seconds}` | a vehicle stationary in the polygon for `min_seconds` |
| `red_light` | `red_light: {stop_line_y, signal: {mode: roi|schedule|http, ...}}` | a vehicle crosses the stop line while the signal is red |

Signal state: `roi` reads the lamp colour from a rectangle of the picture (works with any junction, no
integration); `schedule` uses a fixed cycle; `http` polls an ITMS endpoint (`url`, `json_path`, `red_values`).

Polygons are normalised (0–1) so a change of stream resolution needs no re-drawing. Each incident carries a
snapshot with the box drawn, becomes an alert, and, for `red_light` / `illegal_parking`, is associated with a
plate read on the same camera within ±20 s whose vehicle box overlaps, in which case a challan is drafted.
Every kind has a 5-minute cooldown per zone/track to avoid floods.

Test a configuration on a file: `python -m uvp.services.analytics_worker --file clip.mp4 --camera police-cam2 --department Police`.

## Challans

Drafts appear in **Violations**. A supervisor (feature `alerts_ack`) approves or rejects with remarks; approval
POSTs the challan to `ECHALLAN_WEBHOOK_URL`:

```json
{
  "challan_number": "CH-2026-000123", "plate": "MP04ZR7493", "offence": "over_speed", "label": "Over-speeding",
  "section": "s.183(1)", "fine_inr": 1000, "repeat_offence": false, "occurred_at": "2026-09-22T07:41:02+00:00",
  "camera_id": "police-cam2", "department": "Police", "detail": "…", "evidence": {"crop_path": "…", "frame_path": "…", "event_id": "…"},
  "approved_by": "supervisor", "approved_at": "…", "platform_signature": "<Ed25519 over challan/plate/offence/fine/occurred_at>"
}
```

Header `X-UVP-Signature` is an HMAC-SHA256 of the body with `ECHALLAN_WEBHOOK_SECRET`. The receiver answers
`{"reference": "<its id>"}`; the reference is stored and shown. `Pack` downloads a signed evidence zip
(challan.pdf, watermarked frame/snapshot/clip, manifest + signature). Fine amounts come from
`config/rules.yaml → offences`; repeat offences use `repeat_inr`. **Confirm amounts with the traffic
department; the state notification governs.**

`simulators/sim_hotlist.py` implements the receiver for the pilot (`POST /echallan`, `GET /echallan/received`).

## Hotlists (Vahan / NCRB / state feeds)

`python -m uvp.services.hotlist_sync` pulls each source in `config/hotlists.yaml` on its interval and mirrors it
into the watchlist (entries carry `[source:<name>]`; manual entries are never touched; entries removed upstream
are removed here). Supported: CSV file/URL (`plate, reason, priority, expires`), JSON endpoints with configurable
`json_path` and field names, header-based auth from an environment variable.

Feed contract used by the simulator (`GET /hotlist/stolen`, header `X-API-Key`):

```json
{"vehicles": [{"plate": "MH12AB1234", "reason": "Stolen vehicle FIR 220/2026", "priority": "high", "expires": "2026-12-31"}]}
```

Live NCRB / Vahan access needs credentials from those authorities; point the source `url` at the endpoint they
give you and map the field names.

## Face search

Not built. `/api/face/*` returns HTTP 451 until `config/analytics.yaml → face_search.enabled` is true **and** a
`legal_clearance_ref` (state order + DPIA reference) is recorded, and even then a separately licensed module
would be required. No face data is processed anywhere in this platform.

## Swapping the object detector (YOLO26 and others)

The analytics detector loads any ONNX file named by `ANALYTICS_MODEL` and recognises three families from the
output shape: the bundled **YOLOX-nano** (Apache-2.0, ~26 mAP), **Ultralytics raw** exports (`[1, 84, 8400]`,
YOLOv8/11/26 with `nms=False`) and **Ultralytics end-to-end** exports (`[1, 300, 6]`, YOLO26/YOLOv10). Wide
overview cameras benefit most from a stronger small-object model.

```bash
pip install ultralytics
yolo export model=yolo26n.pt format=onnx imgsz=640        # writes yolo26n.onnx (end-to-end head)
cp yolo26n.onnx platform/models/
# .env
ANALYTICS_MODEL=platform/models/yolo26n.onnx
ANALYTICS_CONF=0.3
docker compose build analytics anpr && docker compose up -d analytics anpr
```

YOLO26n: 40.9 COCO mAP, 2.4 M parameters, trained with small-target-aware label assignment; expect several
times more small vehicles found on a 1080p junction view than the bundled model, often without `tiles: 2`.

**Licence.** Ultralytics YOLO models are **AGPL-3.0** (or a paid Enterprise licence). Deploying an AGPL model in
a service offered to others obliges you to publish the service's source under AGPL unless you hold the Enterprise
licence. Fine for an evaluation or a challenge submission that ships source; for the commercial product use an
Apache-2.0 detector of similar accuracy (RT-DETR, D-FINE, RF-DETR: export to ONNX and add a decoder in
`analytics/detector.py` if the output layout differs) or buy the Enterprise licence.

## Overlay latency (detections lagging the video wall)

The wall shows video over WebRTC (~0.3–0.5 s behind live). Detections travel capture → inference → bus → console,
so they are always a little later than the picture; the badge on a tile says `overlay 2.1s behind` when the gap
exceeds 1.5 s. What sets the gap:

* **Cameras are processed in parallel** (`ANPR_WORKERS` / `ANALYTICS_WORKERS`, default = cores ÷ ONNX threads,
  one frame in flight per camera). Before this, the workers walked the cameras one after another, so the lag was
  *cameras × inference time* — 30 ANPR cameras × 0.2 s = 6 s. Now it is roughly one inference time.
* **ONNX threads per inference**: `ANPR_THREADS` / `ANALYTICS_THREADS` (2). workers × threads should not exceed
  the cores available to the container.
* **Capture buffer**: the workers open the relay with `fflags nobuffer, flags low_delay, max_delay 0.5 s`
  (override with `OPENCV_FFMPEG_CAPTURE_OPTIONS`), which removes the 1–2 s FFmpeg jitter buffer.
* **GPU**: `docker-compose.gpu.yml` moves both workers to `Dockerfile.gpu` (CUDA 12 + onnxruntime-gpu); inference
  drops from ~150 ms to ~10 ms per frame and `ANALYTICS_FPS` / `ANPR_FPS` can go up (4 / 8).
* Expected on a 30-core CPU host: ANPR 30 cameras at 5 fps, analytics 8 cameras with 2×2 tiles at 2 fps, overlay
  ≈ 0.5–1 s behind the video.

## Persons of interest — face recognition

**Models** (bundled, Apache-2.0, OpenCV Zoo): YuNet face detector (`face_detection_yunet_2023mar.onnx`, 5
landmarks, ~80 ms per 720p frame on one core) and SFace embeddings (`face_recognition_sface_2021dec.onnx`, 128-d,
~70 ms per face). Cosine similarity; `FACE_MATCH_THRESHOLD` default 0.40 (OpenCV's published SFace threshold
is 0.363; raise to 0.45 for fewer false alarms with single-photo enrolments).

**Enrol** — Watchlist → *Persons of interest*: name, category (wanted / missing / suspect / other), priority,
reference, expiry, and **one or more photos**. Each photo must contain a clear face; the largest face is used
and a tight crop is stored as the thumbnail; the embedding (one per photo) is kept in `persons.embeddings`.
Several photos (different angles / lighting) raise recall; one photo works with a somewhat higher miss rate.
API: `POST /api/persons` (multipart), `POST /api/persons/{id}/photos`, `PATCH`, `DELETE`, `GET /api/persons/{id}/sightings`.

**Match** — the `faces` service (`uvp.services.face_worker`) samples `FACE_FPS` (2) frames/s from cameras with
`face: true` in `config/analytics.yaml` (or `FACE_CAMERAS=all` / a comma list), detects faces ≥ `FACE_MIN_PX`
(32) wide, embeds them and matches against the gallery (re-read every 30 s). A match publishes a
`person_match` incident with the annotated frame → alert (priority from the person), wall flash, ticker,
notifications and webhooks like any other alert; one alert per person per camera per `FACE_DEDUPE_S` (30 s).
The live overlay draws known faces in magenta with the name and similarity; unknown faces are outlined only.

**Where it works**: entrance / gate / corridor cameras where faces are ≥ 32 px and roughly frontal. Wide
junction overviews will show face boxes only occasionally. Use the codec/plate survey habit: pick cameras by
what they actually see. Privacy: enrolment, changes and every match are in the audit log; the feature is
gated by the `watchlist` feature (supervisor / admin) for enrolment and `search` for viewing; `FACE_ENABLED=0`
switches it off entirely.

## Live vehicle and person counts

`GET /api/counts` returns, per camera, the vehicle / person / face counts from the **last detection message**
(≤ 10 s old) — the same boxes drawn on the wall. The Overview shows them under *Live counts* (refreshed every
5 s while open). Longer-term counts stay in `/api/traffic` (per-minute windows: `avg_vehicles`,
`peak_vehicles`, now also `avg_persons` / `peak_persons`, flow across a line) for cameras with `traffic:`.

## Analysing an uploaded video or photos (no recording on the platform)

When the footage is not on any camera the platform records — a complainant's phone clip, a WhatsApp forward, a
DVR export from a shop — upload it and the platform does the identification work:

*Console → Upload & recognise* (sidebar, under Investigate; previous uploads are listed there and can be reopened) (or `POST /api/analyses`, multipart `files[]`, up to
300 MB, mp4/mov/mkv/avi/webm or jpg/png, several files at once).

What happens (background job, `GET /api/analyses/{id}` polls it):

1. Frames are sampled at 2 fps (`fps` form field, `ANALYSIS_MAX_FRAMES=900` cap — 7.5 min of video).
2. Every face ≥ `FACE_MIN_PX` is detected (YuNet) and embedded (SFace).
3. Faces are grouped into **distinct persons** by cosine similarity (0.45, running centroid), so one person seen
   for 40 seconds becomes one card, not 80 detections. Each card carries how often and when the person appears,
   the largest face size, and the best 3 face crops.
4. Every group is matched against the enrolled persons of interest (`FACE_MATCH_THRESHOLD`) — a hit shows
   *matches enrolled: <name> (<category>, <score>)*.
5. Number plates are read from the same frames (`plates=0` to skip) with the best crop per plate.
6. Any unknown person can be **enrolled straight from the footage** (`POST /api/analyses/{id}/enrol`,
   `{cluster, name, category, priority, reason, reference, days}`): the group's embeddings and crops become a
   `Person`, and every camera with `face: true` starts alerting on them immediately.

Results and crops live under `data/analyses/<id>/` (`GET /media/analyses/{id}/{file}`); `DELETE
/api/analyses/{id}` removes them. Uploads, enrolments and deletions are audited (`analysis_upload`,
`person_enrol` with the analysis id, `analysis_delete`).

Practical limits: faces need to be roughly 40 px wide or more in the clip (a phone at 5–8 m gives that at
1080p); heavy motion blur or masks lower the embedding quality, so prefer the crop the platform picked as
"best" and, when you have them, add one or two clear photos to the enrolled person afterwards
(`POST /api/persons/{id}/photos`). The job runs on the API container's CPU — a 3-minute 1080p clip takes about
a minute with `FACE_THREADS=2`.

**Why an upload "takes time", and what is shown.** Two phases: (1) the transfer — a 5-minute phone video is
150–400 MB and travels over the uploader's *upstream* link (typically 5–20 Mbit/s on Indian mobile / broadband), so
1–5 minutes; the console shows a progress bar with MB/s and time left. (2) the analysis — about 100 ms per sampled
frame on one CPU core (face detect + embed + plate read on a 1080p frame), run `ANALYSIS_WORKERS` frames in
parallel (default 4 in `docker-compose.yml`); a 3-minute clip (360 frames at 2 fps) takes ~10–20 s on the VM.
The result line reports the split (`analysed in 14.2s (faces 6.1s, plates 9.8s, decode 1.0s)`). To speed up:
untick *Read number plates too* when you only need faces (plates are the costlier half), trim the clip to the
relevant minute on the phone before uploading, or raise `ANALYSIS_WORKERS`.

## Counts tab — vehicles and people on every camera

Counting is on for **every camera the platform pulls** (`ANALYTICS_COUNT_ALL=1`, the default): the analytics
worker samples each stream at `ANALYTICS_FPS`, detects vehicles and people, and writes one row per camera per
minute (average and peak vehicles by class, average and peak persons, line-crossing flow where a `line` is
configured). A **crowd alert** fires when persons in view exceed the threshold — `CROWD_MAX_PERSONS` (25) by
default, or `crowd: {max_persons: N, polygon: [...]}` per camera in `config/analytics.yaml`; `count: false` on
a camera switches counting off. The licence's analytics-channel limit caps how many cameras count (explicitly
configured cameras first).

*Console → Counts*: live vehicles / people per camera (from the last detection, ≤ 10 s old), crowd status
(normal / busy > 70 % / crowded), averages and peaks for the chosen period, flow, and a one-hour trend per
camera. The video-wall tiles show the same live numbers in their corner badge. API: `GET /api/counts` (live),
`GET /api/counts/timeline?hours=1&camera_id=` (per minute), `GET /api/traffic` (by class + flow).

**Which cameras count.** With `ANALYTICS_COUNT_ALL=1` the worker counts every camera the relay keeps on a
**steady session** (the first `max_concurrent_pulls` cameras of each source — recorded, ANPR and
analytics-configured cameras first) plus every camera with its own entry in `config/analytics.yaml`. It never
opens a capture on any other camera: that would start a new session on the departmental gateway and break the
source's cap. The image-quality sampler uses the frames the worker already has (it used to open every camera's
stream in turn every 5 minutes, which stalled counting for minutes and logged in to the gateway once per camera
per round — the cause of "counts for a while, then stops"). *Counts → status line* shows the selected set.

## The detection switch (run AI only when you want it)

The header button **Detection: ON / OFF** (supervisor and admin) starts and stops all AI detection — ANPR,
vehicle / people counting, crowd alerts and face matching — on every camera. Per camera: hover a tile →
**Detect** → *Detect on this camera* / *Stop on this camera* / *Follow global switch*, so a few cameras can run
while the rest are idle (or the other way round). Workers pick the change up within 5 seconds, drop frames
while OFF (no inference, no CPU), and the tiles show *AI on / AI off*. The state is stored in the database, so
it survives restarts; `DETECTION_DEFAULT=off` in `.env` makes a fresh install start with detection off until
the button is pressed. Every press is audited (`detection_switch`). API: `GET/POST /api/detection`
(`{enabled}` or `{camera_id, on}`; `on: null` returns a camera to the global switch). The wall's *Show boxes*
checkbox only hides the overlay drawing — it does not stop detection.
