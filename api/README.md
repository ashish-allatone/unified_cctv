# api

REST API + WebSocket + operator console (static web UI) + relay auth hook

| | |
|---|---|
| Image | `<OCIR>/uvp-api:2.0.0` (built with `docker build -f api/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvicorn", "uvp.services.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]` |
| Code | `platform/uvp/services/api.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 8000/tcp (HTTP: console, /api/*, /ws/alerts, /metrics, /healthz, /readyz) |
| Health | GET /healthz (liveness), GET /readyz (readiness: DB required, ES/relay reported) |
| Resources (request-limit) | CPU 500m-2, memory 1-2 GiB |
| State | Stateless. Uploaded media / analyses and plate crops go to DATA_DIR (shared PVC `uvp-data`, RWX) — use object storage for everything else. |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
