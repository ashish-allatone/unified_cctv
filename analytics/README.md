# analytics

Vehicle / people counting, crowd, intrusion, abandoned object, parking, red-light analytics; camera image-quality sampling

| | |
|---|---|
| Image | `<OCIR>/uvp-analytics:1.9.10` (built with `docker build -f analytics/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.analytics_worker"]` |
| Code | `platform/uvp/services/analytics_worker.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 1-2 (or GPU), memory 2 GiB |
| State | Stateless. |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
