# archiver

Cuts event clips from the relay recording buffer, copies clips / crops / segments to object storage, runs the nightly archival policies and weekly reports

| | |
|---|---|
| Image | `<OCIR>/uvp-archiver:2.0.0` (built with `docker build -f archiver/Dockerfile .` from the repository root) |
| Command | `["python", "-m", "uvp.services.archiver"]` |
| Code | `platform/uvp/services/archiver.py` (shared package `platform/uvp`; `src/main.py` is the entrypoint shim) |
| Ports | 9100/tcp (Prometheus /metrics; also the liveness probe) |
| Health | GET /metrics on METRICS_PORT |
| Resources (request-limit) | CPU 250m-1, memory 512 MiB-1 GiB |
| State | Stateless (one replica). Needs read access to the relay recordings PVC and the data PVC. |
| Config | `/app/config/*.yaml` (ConfigMap `uvp-config`), secrets from env (`uvp-secrets`) - see DEPLOYMENT.md |
