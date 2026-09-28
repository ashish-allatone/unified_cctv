#!/usr/bin/env bash
# Backup: database dump (PostgreSQL via compose, or the SQLite file), config, .env, signing key, licence -> backups/<timestamp>.tar.gz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
TS=$(date -u +%Y%m%dT%H%M%SZ); OUT="backups/$TS"; mkdir -p "$OUT"
if docker compose ps --format '{{.Service}}' 2>/dev/null | grep -q '^postgres$'; then
  docker compose exec -T postgres pg_dump -U uvp uvp | gzip > "$OUT/uvp.sql.gz"
elif [[ -f data/uvp.db ]]; then
  sqlite3 data/uvp.db ".backup '$OUT/uvp.db'" 2>/dev/null || cp data/uvp.db "$OUT/uvp.db"
fi
cp -r config "$OUT/config"; [[ -f .env ]] && cp .env "$OUT/env"; [[ -f data/signing_ed25519.key ]] && cp data/signing_ed25519.key "$OUT/"
docker compose ps --format '{{.Service}}' >/dev/null 2>&1 && docker compose cp api:/data/signing_ed25519.key "$OUT/signing_ed25519.key" 2>/dev/null || true
tar -czf "backups/$TS.tar.gz" -C backups "$TS" && rm -rf "$OUT"
echo "backup written: backups/$TS.tar.gz (video archive is in object storage; use bucket versioning/replication for it)"
