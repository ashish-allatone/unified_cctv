# High availability and scale

## Relay cluster

Run N relays (`docker compose --profile ha` adds a second one; Kubernetes runs a StatefulSet). Configure them
in `RELAY_APIS` / `RELAY_RTSPS` / `RELAY_PLAYBACKS` / `RELAY_PUBLIC_HOSTS` (name=endpoint lists). The adapter
service assigns every camera to a relay by **rendezvous hashing** over the healthy relays, writes the
assignment to `cameras.relay`, and registers the paths only there. Every 20 s it pings all relays:

- a relay goes down → its cameras are re-registered on the surviving relays within one health interval
  (measured 20 s in the lite test); ANPR / analytics / archiver workers re-resolve the camera's relay when they
  reconnect; browsers get the relay's public host from `/api/cameras`;
- a relay comes back (or restarts empty) → its cameras move back, so load stays spread;
- other cameras never move (rendezvous property), so a failure only disturbs the failed relay's cameras.

The departmental stream is still pulled once per camera; the pull just moves with the camera. Recording
segments land under `/recordings/<relay>/<camera>/<profile>/` on a shared volume; the archiver handles both
layouts. Behind the TLS front door (`RELAY_PUBLIC_BASE`) route `/relay/webrtc` and `/relay/hls` to the relay
Service; the ingress in `deploy/k8s` does this.

## Metrics and dashboards

`docker compose --profile monitoring up -d` → Prometheus (:9090) scrapes the API (`/metrics`), every worker
(`METRICS_PORT`), and MediaMTX; Grafana (:3000, admin/admin) is provisioned with the *Unified CCTV – platform*
dashboard: cameras by status, viewers, events/min, alerts/h, ANPR throughput and p50/p90 frame time, pulls vs
cap per source, relay and source health, API p95 latency, incidents, archive throughput and backlog,
notification failures, image quality. Alert rules in `deploy/monitoring/alerts.yml`: camera offline, source
unreachable, relay down, ANPR stalled or slow, pull cap at 90 %, archive backlog, notification failures, API
latency. **Capacity per department** (Sources tab, `/api/capacity`): cameras, ANPR channels, recorded
channels, pulls vs cap, viewers, events/24 h, archive size and growth, estimated storage per day, relay spread.

## Scaling the workers

- **ANPR**: `ANPR_SHARD=i/n` splits the ANPR cameras deterministically across n workers (compose: run
  several `anpr` services; Kubernetes: StatefulSet ordinal = shard). CPU: ~3–4 channels at 5 fps per worker with
  2 threads. **GPU**: `platform/Dockerfile.gpu` (CUDA 12 + onnxruntime-gpu, `ANPR_GPU=1`); a T4 handles ~40
  channels per worker. HPA on CPU for api/anpr; KEDA ScaledObject on Kafka lag for the indexer.
- **Analytics**: one worker per ~10 zone cameras at 2 fps on CPU; the same GPU image applies.
- **API**: stateless; scale replicas behind the Service; the WebSocket alert hub is per replica, so use sticky
  sessions or run the alert fan-out through Kafka (`BUS=kafka`, already supported).
- **Edge ANPR**: `EDGE=1 EDGE_CAMERAS="junction-7=rtsp://user:pass@10.5.0.7/stream" EDGE_DEPARTMENT=Police
  API_URL=https://centre/` runs the worker at the junction reading the camera directly; events (with the crop and
  frame inline) go into a SQLite **outbox** and are replayed in order when the link to the centre returns, so
  a WAN outage loses nothing and only metadata crosses the link.

## Data services (managed / HA)

Self-hosted alternative: `deploy/postgres-ha/` — a 3-node Patroni + etcd + HAProxy PostgreSQL cluster with a
migration script and a failover demo (README there).

The platform runs against external, replicated services in production; `docker-compose.yml` bundles
single-node versions for the pilot only.

| Service | Recommended | Notes |
| --- | --- | --- |
| PostgreSQL | Patroni + HAProxy, or a managed HA instance (Oracle Base DB / RDS Multi-AZ) | `DATABASE_URL` to the primary endpoint; daily base backup + WAL archiving to object storage; `pool_pre_ping` is on |
| Kafka | 3 brokers, `replication.factor=3`, `min.insync.replicas=2` (or a managed service) | topics `anpr.events`, `analytics.incidents`, `alerts`; consumers are idempotent (events keyed by id) |
| Elasticsearch | 3 nodes, 1 replica per index | optional; SQL search is the fallback |
| Object storage | Oracle Object Storage / S3 with versioning + SSE | archive, clips, exports; cross-region replication for DR |
| Relay buffer volume | ReadWriteMany (NFS / OCI File Storage) sized `RECORD_LOCAL_KEEP` × recorded channels × ~1 GB/h | only a buffer; the archive is in object storage |

Backups: database (base + WAL), the signing key (`SIGNING_KEY_FILE`), configuration (`config/`), and the
bucket's own versioning. Restore drill: restore DB + config on a fresh cluster, point at the same bucket; clips
and recordings resolve by key.

## Kubernetes

`python deploy/k8s/render.py > manifests.yaml && kubectl apply -f manifests.yaml` (values in
`deploy/k8s/values.yaml`). The generator is validated by the test-suite; it renders Namespace, ConfigMap (all
config files), Secret (placeholders), PVCs, Deployments (api, adapters, indexer, archiver, analytics, hotlist),
StatefulSets (relay ×N with per-relay recording paths, anpr ×N shards), Services, HPA, PDB, Ingress with
cert-manager TLS, and a KEDA ScaledObject. Wrap the same values in a Helm chart if the platform team prefers.
