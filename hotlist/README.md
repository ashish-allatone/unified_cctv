# hotlist

Pulls external stolen / wanted vehicle feeds (NCRB / Vahan style) into the watchlist

| | |
|---|---|
| Image | `<OCIR>/uvp-hotlist:1.9.10` (built with `docker build -f hotlist/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.hotlist_sync"]` |
| Code | `platform/uvp/services/hotlist_sync.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 100m-250m, memory 256 MiB |
| State | Stateless (one replica). |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
