#!/usr/bin/env bash
# Single-host "lite" run without Docker: simulators + relay + platform services.
# Uses PostgreSQL if DATABASE_URL is set, otherwise SQLite; events go straight
# to the API (BUS=http) instead of Kafka; search runs on the database.
#
#   scripts/lite.sh start      start everything
#   scripts/lite.sh stop       stop everything
#   scripts/lite.sh status     show what is running
#   scripts/lite.sh sims       start only the two departmental simulators
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${RUN_DIR:-$ROOT/data/run}"
mkdir -p "$RUN"
export PYTHONPATH="$ROOT/platform:${PYTHONPATH:-}"
export UVP_ROOT="$ROOT"
set -a; [[ -f "$ROOT/.env" ]] && . "$ROOT/.env"; set +a

start_bg() {  # name, command...
  local name=$1; shift
  if [[ -f "$RUN/$name.pid" ]] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
    echo "  $name already running"; return
  fi
  nohup "$@" >"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
  echo "  started $name (pid $!)"
}

stop_one() {  # stop a service and wait until it has exited (frees its ports)
  local f="$RUN/$1.pid"; [[ -f "$f" ]] || return 0
  local pid; pid=$(cat "$f")
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  rm -f "$f"
}

stop_all() {
  for f in "$RUN"/*.pid; do
    [[ -e "$f" ]] || continue
    local pid; pid=$(cat "$f")
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
    echo "  stopped $(basename "$f" .pid)"
  done
}

sims() {
  echo "Departmental simulators:"
  [[ -f "$ROOT/data/media/police-cam1_main.mp4" ]] || { echo "  run: python simulators/traffic_synth.py --out data/media"; exit 1; }
  MEDIA_DIR="$ROOT/data/media" start_bg sim-police-video mediamtx "$ROOT/simulators/dept_a_mediamtx.yml"
  MEDIA_DIR="${MEDIA_DIR_B:-$ROOT/data/media}" start_bg sim-muni-video mediamtx "$ROOT/simulators/dept_b_mediamtx.yml"
  (cd "$ROOT/simulators" && start_bg sim-police-onvif python3 -m uvicorn dept_a_police_nvr:app --port 18080 --log-level warning)
  (cd "$ROOT/simulators" && start_bg sim-muni-api python3 -m uvicorn dept_b_municipal_vms:app --port 18090 --log-level warning)
  (cd "$ROOT/simulators" && HOTLIST_API_KEY="${HOTLIST_API_KEY:-demo}" start_bg sim-hotlist python3 -m uvicorn sim_hotlist:app --port 18095 --log-level warning)
}

platform() {
  echo "Unified viewing platform:"
  [[ -f "$RUN/relay-b.pid" ]] && LITE_HA=1     # a second relay is running: keep the cluster env on restarts
  mkdir -p "$ROOT/data/recordings"
  TZ=UTC MTX_PATHDEFAULTS_RECORDPATH="$ROOT/data/recordings/relay/%path/%Y-%m-%d_%H-%M-%S-%f" \
    start_bg relay mediamtx "$ROOT/config/mediamtx.yml"
  if [[ "${LITE_HA:-0}" == "1" ]]; then   # second relay on +30000 ports: LITE_HA=1 scripts/lite.sh start
    TZ=UTC MTX_PATHDEFAULTS_RECORDPATH="$ROOT/data/recordings/relay-b/%path/%Y-%m-%d_%H-%M-%S-%f" \
      MTX_APIADDRESS=:39997 MTX_METRICSADDRESS=:39998 MTX_RTSPADDRESS=:38554 MTX_RTPADDRESS=:38000 MTX_RTCPADDRESS=:38001 \
      MTX_WEBRTCADDRESS=:38889 MTX_WEBRTCLOCALUDPADDRESS=:38189 MTX_HLSADDRESS=:38888 MTX_PLAYBACKADDRESS=:39996 \
      start_bg relay-b mediamtx "$ROOT/config/mediamtx.yml"
    export RELAY_APIS="relay=http://localhost:9997,relay-b=http://localhost:39997"
    export RELAY_RTSPS="relay=rtsp://localhost:8554,relay-b=rtsp://localhost:38554"
    export RELAY_PLAYBACKS="relay=http://localhost:9996,relay-b=http://localhost:39996"
    export RELAY_PUBLIC_HOSTS="relay=localhost:8889:8888,relay-b=localhost:38889:38888"
  fi
  start_bg api python3 -m uvicorn uvp.services.api:app --host 0.0.0.0 --port 8000 --log-level warning
  sleep 3
  METRICS_PORT=9104 start_bg adapters python3 -m uvp.services.adapter_service
  sleep 4
  METRICS_PORT=9101 start_bg anpr python3 -m uvp.services.anpr_worker
  METRICS_PORT=9103 start_bg archiver python3 -m uvp.services.archiver
  METRICS_PORT=9102 start_bg analytics python3 -m uvp.services.analytics_worker
  HOTLIST_API_KEY="${HOTLIST_API_KEY:-demo}" start_bg hotlist python3 -m uvp.services.hotlist_sync
}

case "${1:-start}" in
  start) sims; platform; echo "Open http://localhost:8000  (admin / admin123)";;
  sims) sims;;
  platform) platform;;
  stop) stop_all;;
  restart) shift; for n in "$@"; do stop_one "$n"; done; sims >/dev/null; platform;;
  status) for f in "$RUN"/*.pid; do [[ -e "$f" ]] || continue; n=$(basename "$f" .pid); if kill -0 "$(cat "$f")" 2>/dev/null; then echo "  $n: running"; else echo "  $n: DEAD (see $RUN/$n.log)"; fi; done;;
  *) echo "usage: $0 start|stop|status|sims|platform|restart <service...>"; exit 1;;
esac
