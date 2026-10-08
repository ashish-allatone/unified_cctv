# indexer

Consumes plate events from Kafka, writes PostgreSQL rows, Elasticsearch documents, watchlist matching and alerts

| | |
|---|---|
| Image | `<OCIR>/uvp-indexer:1.9.10` (built with `docker build -f indexer/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.indexer"]` |
| Code | `platform/uvp/services/indexer.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 250m-1, memory 512 MiB-1 GiB |
| State | Stateless; scale on Kafka lag (KEDA ScaledObject in deploy/k8s). |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
