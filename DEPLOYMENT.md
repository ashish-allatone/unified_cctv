# Deployment guide — Unified CCTV by Allatone (v2.0.0)

For the DevOps flow **Git → Jenkins → Docker build → OCIR push → OKE deployment → Pod**. Everything a
deployment engineer needs is in this file; the application behaviour is in `README.md` and `docs/`.

## Console (React)

`platform/web-react` is built by a Node stage inside the `api`/platform Dockerfiles (`npm ci && npm run build` → `dist/`), copied
into the image and served by the API at `/`; the legacy console is served at `/legacy/`. No separate frontend container, port or
nginx. Local build: `cd platform/web-react && npm install && npm run build`.

## 1. Repository layout

```
unified-cctv/
├── api/        archiver/   anpr/   faces/   analytics/   adapters/   hotlist/   indexer/
│   ├── Dockerfile            one image per service (same base layers, different CMD)
│   ├── requirements.txt      pinned python dependencies (identical for every service; master copy platform/requirements.txt)
│   ├── README.md             ports, command, probes, resources, state of that service
│   └── src/main.py           entrypoint shim -> platform/uvp (shared package)
├── mediamtx/                 relay: mediamtx.yml + Dockerfile (upstream image + config)
├── platform/
│   ├── uvp/                  the application code shared by all services (uvp/services/<service>.py = each service's main)
│   ├── web/                  operator console (static files, served by api)
│   ├── models/               ONNX models (fetched by scripts/fetch_models.sh or at image build)
│   ├── requirements.txt
│   ├── Dockerfile            single "all services" image used by docker-compose (CMD selects the service)
│   └── Dockerfile.gpu        CUDA image for anpr / analytics
├── config/                   runtime configuration (mounted as ConfigMap uvp-config)
├── deploy/k8s/               values.yaml + render.py -> manifests.yaml (Deployments, StatefulSets, Services, Ingress, HPA, PDB, KEDA)
├── deploy/postgres-ha/       3-node PostgreSQL (Patroni) for VM deployments; on OKE use a managed/HA PostgreSQL instead
├── deploy/monitoring/        Prometheus rules + Grafana dashboard
├── deploy/tls/               Caddy TLS front door for the VM deployment (OKE uses the Ingress)
├── docker-compose.yml        current single-VM deployment (service dependencies, ports, volumes, env)
├── Jenkinsfile               build all images -> push to OCIR -> render manifests -> kubectl apply
├── scripts/, tests/, docs/, simulators/
└── VERSION                   image tag (2.0.0)
```

**Build context is always the repository root**: `docker build -f api/Dockerfile .` — the service
Dockerfiles copy `platform/` (shared code) plus their own `src/`. Code is deliberately *not* duplicated
per service: all eight services import the same `uvp` package, so one bug-fix is one commit.

## 2. Services, images and commands

| Service | Image (OCIR) | Dockerfile | Command | Ports | Replicas | Health |
|---|---|---|---|---|---|---|
| api | `uvp-api:2.0.0` | `api/Dockerfile` | `python -m uvicorn uvp.services.api:app --host 0.0.0.0 --port 8000 --workers 2` | **8000/tcp** HTTP (console, `/api/*`, `/ws/alerts`, `/internal/relay-auth`, `/metrics`) | 2 (HPA to 6) | `GET /healthz` live · `GET /readyz` ready (503 when the DB is down) |
| indexer | `uvp-indexer:2.0.0` | `indexer/Dockerfile` | `python -m uvp.services.indexer` | 9100/tcp `/metrics` | 2 (KEDA on Kafka lag) | `GET :9100/metrics` |
| adapters | `uvp-adapters:2.0.0` | `adapters/Dockerfile` | `python -m uvp.services.adapter_service` | 9100/tcp | **1** | `GET :9100/metrics` |
| anpr | `uvp-anpr:2.0.0` (or `uvp-anpr-gpu`) | `anpr/Dockerfile` / `platform/Dockerfile.gpu` | `python -m uvp.services.anpr_worker` (`ANPR_SHARD=<ordinal>/<replicas>`) | 9100/tcp | 2+ (StatefulSet, one shard per pod) | `GET :9100/metrics` |
| analytics | `uvp-analytics:2.0.0` | `analytics/Dockerfile` | `python -m uvp.services.analytics_worker` | 9100/tcp | 1 | `GET :9100/metrics` |
| faces | `uvp-faces:2.0.0` | `faces/Dockerfile` | `python -m uvp.services.face_worker` | 9100/tcp | 1 | `GET :9100/metrics` |
| archiver | `uvp-archiver:2.0.0` | `archiver/Dockerfile` | `python -m uvp.services.archiver` | 9100/tcp | **1** | `GET :9100/metrics` |
| hotlist | `uvp-hotlist:2.0.0` | `hotlist/Dockerfile` | `python -m uvp.services.hotlist_sync` | 9100/tcp | **1** | `GET :9100/metrics` |
| relay (mediamtx) | `uvp-relay:2.0.0` = `bluenviron/mediamtx:1.15.1-ffmpeg` + config | `mediamtx/Dockerfile` | image default | 8554 RTSP · 8889 WHEP · 8189 udp+tcp WebRTC media · 8888 HLS · 9997 API · 9996 playback · 9998 metrics | 2 (StatefulSet) | `GET :9997/v3/paths/list` |

Infrastructure (not built by us — use OCI managed services or your own charts):

| Component | Image / service | Version | Port | Notes |
|---|---|---|---|---|
| PostgreSQL | `postgres:16-alpine` (compose) / OCI Database with PostgreSQL / Patroni (deploy/postgres-ha) | 16 | 5432 | **stateful**, PVC or managed |
| Kafka | `apache/kafka:3.8.0` (KRaft) / OCI Streaming with Kafka API | 3.8 | 9092 | **stateful**; topics `anpr.events`, `anpr.alerts`, `anpr.dets`, `anpr.incidents` auto-created |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:8.15.3` / OCI OpenSearch | 8.15 | 9200 | **stateful**; optional (the API falls back to SQL search when `ES_URL` is empty) |
| Object storage | OCI Object Storage, S3-compatible endpoint | — | 443 | bucket for clips, crops, recordings, archive exports |
| Prometheus / Grafana | `prom/prometheus:v2.54.1`, `grafana/grafana:11.2.0` | | 9090 / 3000 | optional; rules in `deploy/monitoring` |

Docker-compose `--profile sim` services (simulated departments) and `--profile tls` (Caddy) are for the
single-VM pilot only and are not deployed on OKE.

## 3. Environment variables

All services read the same variables (`platform/uvp/config.py` is the single source of truth; `.env.example`
documents each). Values marked **secret** go in the Kubernetes Secret `uvp-secrets`; the rest are plain env.

| Variable | Used by | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | all | `postgresql+psycopg://uvp:***@pg:5432/uvp` | **secret** (contains the password). `PG_HOST`/`PG_PORT` are compose-only helpers |
| `BUS` / `KAFKA_BOOTSTRAP` | all | `kafka` / `kafka-0.kafka.svc:9092,...` | `BUS=http` runs without Kafka (single node only) |
| `ES_URL` | api, indexer, archiver | `http://elasticsearch.search.svc:9200` | empty = SQL search |
| `API_URL` | workers | `http://api:8000` | internal |
| `INTERNAL_SECRET` | all | random 32+ chars | **secret**; worker→api calls |
| `TOKEN_SECRET` | api | random 32+ chars | **secret**; JWT signing |
| `RELAY_APIS` / `RELAY_RTSPS` / `RELAY_PLAYBACKS` / `RELAY_PUBLIC_HOSTS` | api, adapters, archiver, workers | `relay-0=http://relay-0.relay.ns.svc:9997,relay-1=...` | one entry per relay pod (rendered by `deploy/k8s/render.py`) |
| `RELAY_PUBLIC_BASE` | api | `https://cctv.example.gov.in/relay` | browsers reach WebRTC/HLS through the Ingress |
| `RELAY_INTERNAL_USER` / `RELAY_INTERNAL_PASS` | api, adapters, workers, relay | `uvp-internal` / **secret** | relay auth for internal pulls |
| `OBJECT_STORAGE`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_PATH_STYLE`, `S3_SSE`, `S3_COLD_CLASS` | api, archiver | `s3`, `https://<ns>.compat.objectstorage.ap-mumbai-1.oraclecloud.com`, `ap-mumbai-1`, `uvp-video`, `1`, `AES256`, `InfrequentAccess` | |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | api, archiver | OCI customer secret keys | **secret** |
| `DATA_DIR` / `RECORDINGS_DIR` | all | `/data` / `/recordings` | PVC mounts (see §5) |
| `METRICS_PORT` | workers | `9100` | `0` disables; api serves `/metrics` on 8000 |
| `ANPR_FPS`, `ANPR_THREADS`, `ANPR_WORKERS`, `ANPR_SHARD`, `ANPR_GPU` | anpr | `5`, `2`, `0`, `0/2`, `0` | shard = pod ordinal / replicas |
| `ANALYTICS_FPS`, `ANALYTICS_THREADS`, `ANALYTICS_WORKERS`, `ANALYTICS_COUNT_ALL`, `CROWD_MAX_PERSONS` | analytics | `2`, `2`, `0`, `1`, `25` | |
| `FACE_FPS`, `FACE_THREADS`, `FACE_WORKERS`, `FACE_MATCH_THRESHOLD`, `FACE_CAMERAS` | faces | `2`, `2`, `0`, `0.40`, `` | |
| `ANALYSIS_WORKERS`, `ANALYSIS_MAX_FRAMES` | api | `4`, `900` | Upload & recognise |
| `DETECTION_DEFAULT` | api, workers | `on` | AI detection switch default |
| `ARCHIVAL_HOUR_IST`, `ARCHIVAL_COLD_PREFIX` | archiver, api | `2`, `cold` | nightly archival run |
| `RELAY_ADD_STAGGER_S`, `AUTH_BACKOFF_S`, `STEADY_GRACE_S` | adapters | `0.5`, `600`, `90` | gateway session handling |
| `CORP8_USER` / `CORP8_PASS`, `POLICE_ONVIF_PASS`, `MUNI_API_PASS`, `HOTLIST_API_KEY` | adapters, hotlist | | **secret**; referenced from `config/sources.yaml` / `hotlists.yaml` via `${VAR}` |
| `SMTP_*`, `SMS_API_KEY`, `WA_PHONE_ID`, `WA_TOKEN`, `CAD_WEBHOOK_SECRET`, `VOICE_OBD_URL/USER/PASS/DNID`, `VOICE_CALLBACK_KEY` | api, archiver | | **secret**; notification channels (`config/notify.yaml`) |
| `PII_BLUR_FACES`, `PII_MASK_PLATES`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCKOUT_S` | api, workers | `1`, `1`, `5`, `900` | |
| `LICENSE_FILE` | api, workers | `/app/config/license.json` | mount the issued licence (Secret or ConfigMap) |

Runtime config files (ConfigMap `uvp-config`, mounted at `/app/config`): `sources.yaml` (departmental
systems), `analytics.yaml`, `rules.yaml`, `auth.yaml`, `users.yaml` (first-run demo accounts only),
`hotlists.yaml`, `notify.yaml`, `tenants.yaml`, `vendors.yaml`, `mediamtx.yml`. Passwords in these files
are always `${ENV}` references, never literals.

## 4. Startup / entrypoints

Every service: `CMD` in its Dockerfile (table in §2); equivalently `python <service>/src/main.py`.
Startup order does not matter — each service retries its dependencies — but the api should be ready before
the adapters configure the relays. All services run `init_db()` on start (creates / migrates tables
automatically; no manual migration step). The api also seeds the built-in roles and serves the console.

## 5. Persistent volumes

| Claim | Mounted by | Mode | Size | Content |
|---|---|---|---|---|
| `uvp-data` (`/data`) | api, archiver, workers | RWX (OCI File Storage) | 50 GiB | uploaded media & analyses (Upload & recognise), plate crops before archival, SQLite only when no PostgreSQL |
| `uvp-recordings` (`/recordings`) | relay (RW), archiver (RO) | RWX or one RWO per relay pod | ~200 GiB per relay | short recording buffer (`RECORD_LOCAL_KEEP`, 6 h); archiver moves segments to object storage |
| PostgreSQL / Kafka / Elasticsearch data | those components | RWO (block) | per sizing (docs/ha.md) | **all platform state of record lives in PostgreSQL + object storage** |

Nothing else needs to persist: a pod of any platform service can be deleted and recreated at any time.

## 6. Resources (requests → limits; from deploy/k8s/values.yaml, sized for ~30–100 cameras)

| Service | CPU | Memory | Notes |
|---|---|---|---|
| api | 500m → 2 | 1 GiB → 2 GiB | HPA 70 % CPU, 2–6 replicas |
| indexer | 500m → 1 | 1 GiB | KEDA on Kafka lag, 2–8 replicas |
| adapters | 500m | 512 MiB | single replica |
| anpr | 2 → 4 (or 1 GPU) | 3–4 GiB | ~8 cameras at 5 fps per 2 vCPU; ~40 per T4 GPU |
| analytics | 1 → 2 (or GPU) | 2 GiB | ~10 cameras per 2 vCPU |
| faces | 1 → 2 | 2 GiB | |
| archiver | 500m → 1 | 1 GiB | |
| hotlist | 250m | 256 MiB | |
| relay | 1 → 4 | 1 → 4 GiB | per relay pod; 500–800 pulls per node |

Scaling guidance for a State-wide estate is in `docs/scale.md`.

## 7. Stateless vs. stateful

Stateless (any replica count, rolling updates, no PVC needed for correctness): **api, indexer, anpr, analytics, faces, archiver, hotlist, adapters**
— restriction: *adapters*, *archiver* and *hotlist* run **one replica** (they coordinate external systems; a second copy would double-poll).
`uvp-data` is a convenience cache for uploads/crops, not state of record.

Stateful: **relay** (recording buffer PVC per pod, stable network identity), **PostgreSQL, Kafka, Elasticsearch, object storage**.

## 8. Build, push, deploy (what the Jenkinsfile does)

```bash
TAG=$(cat VERSION); REG=ap-mumbai-1.ocir.io/<tenancy-namespace>
for s in api indexer adapters anpr analytics faces archiver hotlist; do
  docker build -f $s/Dockerfile -t $REG/uvp-$s:$TAG . && docker push $REG/uvp-$s:$TAG
done
docker build -f mediamtx/Dockerfile -t $REG/uvp-relay:$TAG . && docker push $REG/uvp-relay:$TAG
# one-time cluster setup
kubectl create ns unified-cctv
kubectl -n unified-cctv create secret docker-registry ocir-pull --docker-server=ap-mumbai-1.ocir.io --docker-username='<ns>/<user>' --docker-password='<auth token>'
kubectl -n unified-cctv create secret generic uvp-secrets --from-literal=token-secret=... --from-literal=internal-secret=... \
  --from-literal=relay-internal-pass=... --from-literal=s3-access-key=... --from-literal=s3-secret-key=... --from-literal=police-onvif-pass=... --from-literal=muni-api-pass=...
# every release
sed -i "s|^registry: .*|registry: $REG|; s|^tag: .*|tag: $TAG|" deploy/k8s/values.yaml
python deploy/k8s/render.py --no-secrets > deploy/k8s/manifests.yaml && kubectl apply -f deploy/k8s/manifests.yaml
```

The first image build takes ~10 minutes (pip + model download); the other seven services reuse every
layer and take ~1 minute each. Images are ~2.5 GB (OpenCV, ONNX runtime, models); the GPU image ~6 GB.

Network: the Ingress exposes **443 → api:8000** (`/`) and the relay's WebRTC/HLS (`/relay/webrtc`,
`/relay/hls`); WebRTC media needs **UDP 8189** reachable on the relay nodes (NodePort/LoadBalancer) or
falls back to TCP 8189; RTSP **8554** on the relay is exposed only if remote site connectors push streams in.
Outbound from the cluster: departmental VMS/NVR/gateways (RTSP 554/8554, ONVIF 80/8080, vendor REST),
object storage (443), the notification gateways (SMTP 587, HTTPS, the OBD dialer on 8096).

## 9. Health & readiness summary

- api: `/healthz` (liveness, no dependencies) · `/readyz` (readiness: PostgreSQL required; Elasticsearch and relay reported) · `/metrics` (Prometheus)
- every worker: `/metrics` on `METRICS_PORT` (9100) — used as liveness/startup probe; Prometheus scrapes it (annotations already in the manifests)
- relay: `:9997/v3/paths/list`
- Docker `HEALTHCHECK` is set in every Dockerfile with the same endpoints.

## 10. Tests

`pytest -q tests` (97 tests, SQLite + local object store, no external services) — run in the Jenkins
*Test* stage before building images.
