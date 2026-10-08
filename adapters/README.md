# adapters

Talks to departmental VMS / NVR / gateways (ONVIF, RTSP templates, vendor REST, push), keeps the camera registry in sync and configures relay paths; camera health

| | |
|---|---|
| Image | `<OCIR>/uvp-adapters:1.9.10` (built with `docker build -f adapters/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.adapter_service"]` |
| Code | `platform/uvp/services/adapter_service.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 250m-500m, memory 512 MiB |
| State | Stateless (one replica; per-source session caps are enforced here). |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
