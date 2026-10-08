# anpr

Licence-plate detection + OCR on ANPR cameras; publishes plate events to Kafka. Sharded by ANPR_SHARD=i/n (StatefulSet ordinal)

| | |
|---|---|
| Image | `<OCIR>/uvp-anpr:2.0.0` (built with `docker build -f anpr/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.anpr_worker"]` |
| Code | `platform/uvp/services/anpr_worker.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 2-4 (or 1 GPU), memory 3-4 GiB |
| State | Stateless. Optional GPU image (Dockerfile.gpu). |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
