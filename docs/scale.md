# Scaling to a State: ~80,000 cameras

The pilot runs 30 cameras on one VM. The same code scales to a State-wide estate because of three design
decisions that were made for the pilot already; this page puts numbers on them.

## 1. Never pull what nobody is using

80,000 cameras × ~2 Mbit/s = **160 Gbit/s** if every stream were pulled to the centre. Nobody can (or should)
do that, and no departmental gateway would allow it — the Corp8 session cap we hit at 30 cameras is the small
version of the same limit. The platform therefore pulls a stream only for a **reason**:

| reason | how many streams at once | who decides |
|---|---|---|
| an operator is watching a tile | operators × tiles (200 operators × 16 tiles = **3,200**) | on-demand pull, 10 s hang-up after the last viewer |
| ANPR / counting / faces run on the camera continuously | the analytics estate you fund (**2,000–10,000**), by priority | `anpr:`, `count:`, `face:` per camera, `max_concurrent_pulls` per source |
| an investigation asks for playback | the clip only, from the department's VMS, on request | Playback / Vehicle-movement tabs |
| recording | stays in each department's VMS; the centre archives only the analysed cameras and event clips | `record: anpr` |

So 80,000 registered cameras become **~5,000–13,000 concurrent pulls** — a size that is engineered, not
heroic. The registry (inventory, GIS, gap analysis) is the one thing that really is 80,000: rows in
PostgreSQL, which is nothing.

## 2. Everything per source is bounded; everything central is horizontal

```
 80,000 cameras   ≈ 400 sources (city VMS, NVR clusters, gateways such as Corp8)
        │
        ▼  one read-only account and one session cap per source (max_concurrent_pulls, persistent_pull)
 ┌─────────────────────── district / city edge (Kubernetes node pool or a 2-node rack) ───────────────────────┐
 │  relay pool: N × MediaMTX      each node ≈ 500–800 pulls / 1–2 Gbit/s; cameras placed by rendezvous hash  │
 │  adapters (one per ~50 sources), ANPR + analytics + face workers (GPU), edge outbox for WAN outages          │
 └──────────────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                                │ events + crops + per-minute counts (KB, not video)
                                                ▼
 ┌─────────────────────────── State command centre (3 zones) ──────────────────────────────────────────────┐
 │  Kafka (3+ brokers, topics partitioned by camera) · PostgreSQL (partitioned by month, read replicas)       │
 │  Elasticsearch / OpenSearch (events, plates) · object storage (clips, crops; lifecycle rules)              │
 │  API replicas behind a load balancer (stateless; alert fan-out through Kafka) · registry · GIS · reports   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Each layer scales by adding nodes, never by making one bigger:

- **Relays**: `RELAY_APIS="a=…,b=…,c=…"` — cameras are assigned by rendezvous hashing over the healthy relays,
  so a dead relay's cameras move within one sync (already in the pilot code). 13,000 pulls ≈ **20–25 relay
  nodes** of 8 vCPU; place them in the district that owns the cameras so raw video never crosses the State
  backbone. Viewers connect to the relay that holds the camera (`/api/cameras` carries `relay_host`).
- **Adapters**: one adapter service per ~50 sources (the sync is per source; a slow VMS API only delays its own
  cameras). Console-connected devices and `sources.yaml` are both supported.
- **ANPR**: `ANPR_SHARD=i/n` splits the ANPR cameras deterministically across n workers. GPU sizing: a T4/L4
  handles ~40 ANPR channels at 5 fps per worker (plate detector + OCR); **5,000 ANPR cameras ≈ 125 GPUs**, or
  half that at 2–3 fps on junction cameras where vehicles are slow.
- **Counting / crowd / zone analytics**: YOLOX-nano at 2 fps ≈ 150–200 cameras per T4/L4 (batched); **10,000
  counted cameras ≈ 50–70 GPUs**. CPU-only: ~10 cameras per 2 vCPU.
- **Faces**: only gate / entrance cameras (`face: true`), ~60 cameras per GPU at 2 fps; the persons-of-interest
  gallery (thousands of embeddings) is matched in memory.
- **Events**: 5,000 ANPR cameras produce ~2,000–5,000 plate reads/s at peak. Kafka carries that on 3 brokers;
  PostgreSQL takes it partitioned by month with the plate index in Elasticsearch; 90-day retention of plate reads
  ≈ 20–40 billion rows/year → keep 90 days hot in PostgreSQL, the rest in object storage as Parquet for
  subject-access and audit queries.
- **API / console**: stateless replicas; 500 concurrent operators ≈ 6–8 replicas of 2 vCPU. WebSocket
  fan-out goes through Kafka so every replica sees every alert.
- **Storage**: event clips (10 s, ~3 MB) + crops for 5,000 ANPR cameras ≈ **8–12 TB/month**; continuous
  archive of the analysed cameras at 2 Mbit/s ≈ 650 GB/camera/month — hence `record: anpr`, 30 days, lifecycle
  rules to cold storage, and departmental VMS remain the system of record for everything else.

## 3. Departments are never harmed by the centre

The same guarantees at 30 or 80,000: one read-only account per source, a hard cap on concurrent pulls per source
(the relay pulls each stream once for any number of viewers), 401 back-off so a mis-configured password never
locks a department out of its own system, edge outboxes so WAN outages lose no events, and recordings that stay
in the department's VMS. `tests/test_non_interference.py` is the evidence; the per-source `max_concurrent_pulls`
and the session-cap probe (`scripts/probe_cap.py`) are how each source's limit is agreed and enforced.

## Rollout shape

| phase | cameras | what changes |
|---|---|---|
| pilot (now) | 30 | one VM, docker compose |
| city | 2,000–5,000 | Kubernetes (`deploy/k8s`), 3–5 relays, GPU node pool for ANPR/analytics, managed PostgreSQL/Kafka |
| region | 20,000 | one edge pool per city, central Kafka/PG/ES, registry-driven onboarding (CSV/API), read replicas |
| State | 80,000 | ~400 sources, 20–25 relays, 150–200 GPUs for the funded analytics estate, 3-zone command centre, DR site |

What the code does **not** need for this: a rewrite. It needs configuration (relay lists, shards, per-source caps),
the Kubernetes manifests that already exist (`deploy/k8s/render.py`, `values.yaml`), and GPUs.
