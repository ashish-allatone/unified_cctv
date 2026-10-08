# mediamtx (relay)

Streaming relay: pulls each camera once from the departmental system (RTSP), serves WebRTC (WHEP) / HLS to the
console, records segments for recorded cameras, and accepts key-authenticated RTSP pushes from site connectors.

| | |
|---|---|
| Image | `bluenviron/mediamtx:1.15.1-ffmpeg` (upstream) or `<OCIR>/uvp-relay:2.0.0` (this Dockerfile = upstream + `mediamtx.yml`) |
| Ports | 8554/tcp RTSP · 8889/tcp WebRTC signalling · 8189/udp+tcp WebRTC media · 8888/tcp HLS · 9997/tcp control API (internal) · 9996/tcp playback API (internal) · 9998/tcp metrics |
| Env | `MTX_AUTHHTTPADDRESS=http://api:8000/internal/relay-auth`, `MTX_PATHDEFAULTS_RECORDPATH=/recordings/<pod>/%path/%Y-%m-%d_%H-%M-%S-%f`, `TZ=UTC`, `RELAY_INTERNAL_USER/PASS` (same values as the platform services), optional `MTX_WEBRTCADDITIONALHOSTS=<public IP/DNS>` |
| Health | `GET :9997/v3/paths/list` (control API) or `GET :9998/metrics` |
| Resources | CPU 1-4, memory 1-4 GiB per relay (≈500-800 pulls per node) |
| State | **Stateful**: StatefulSet, one PVC per pod for the recording buffer (`/recordings`, ~200 GB), headless Service so each relay is addressable (`relay-0`, `relay-1`); cameras are spread over relays by rendezvous hashing |

`mediamtx.yml` is the same file as `config/mediamtx.yml` (kept in both places; the config one is what docker compose mounts).
