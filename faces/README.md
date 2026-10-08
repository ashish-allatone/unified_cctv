# faces

Face detection + recognition against the persons-of-interest gallery on cameras with face: true

| | |
|---|---|
| Image | `<OCIR>/uvp-faces:1.9.10` (built with `docker build -f faces/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.face_worker"]` |
| Code | `platform/uvp/services/face_worker.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (/metrics) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 1-2, memory 2 GiB |
| State | Stateless. |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
