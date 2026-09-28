#!/usr/bin/env bash
# One-shot installer for a Linux host with Docker: creates .env with random secrets, builds, starts, checks health.
#   bash scripts/install.sh [--with-sim] [--with-monitoring] [--with-tls PUBLIC_HOST]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
PROFILES=(); TLS_HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sim) PROFILES+=(--profile sim);;
    --with-monitoring) PROFILES+=(--profile monitoring);;
    --with-tls) PROFILES+=(--profile tls); TLS_HOST="$2"; shift;;
    *) echo "unknown option $1"; exit 1;;
  esac; shift
done
command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required"; exit 1; }
rand() { python3 -c "import secrets;print(secrets.token_urlsafe(32))" 2>/dev/null || openssl rand -base64 32 | tr -d '/+=' ; }
if [[ ! -f .env ]]; then
  cp .env.example .env
  for k in INTERNAL_SECRET TOKEN_SECRET RELAY_INTERNAL_PASS POSTGRES_PASSWORD ECHALLAN_WEBHOOK_SECRET TICKET_WEBHOOK_SECRET; do
    v="$(rand)"; grep -q "^$k=" .env && sed -i "s|^$k=.*|$k=$v|" .env || echo "$k=$v" >> .env
  done
  [[ -n "$TLS_HOST" ]] && { sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$TLS_HOST|" .env; echo "RELAY_PUBLIC_BASE=https://$TLS_HOST/relay" >> .env; }
  echo "created .env with generated secrets (edit departmental credentials before connecting real systems)"
else
  echo ".env exists: keeping it"
fi
mkdir -p data
echo "building images (first time takes a few minutes: ANPR models are downloaded into the image)…"
docker compose "${PROFILES[@]}" build
docker compose "${PROFILES[@]}" up -d
echo -n "waiting for the API"
for i in $(seq 1 60); do curl -fs localhost:8000/api/version >/dev/null 2>&1 && break; echo -n .; sleep 3; done; echo
curl -fs localhost:8000/api/version || { echo "API did not come up; see: docker compose logs api"; exit 1; }
echo
echo "Installed. Console: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):8000  (admin / admin123 - change in config/users.yaml)"
[[ -n "$TLS_HOST" ]] && echo "TLS console: https://$TLS_HOST"
echo "Field app: /m/   API docs: /docs   Metrics: /metrics"
