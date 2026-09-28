#!/usr/bin/env bash
# Update to a new release: backup, replace code, rebuild, migrate (automatic on start), restart, health-check.
#   bash scripts/update.sh /path/to/unified-cctv-pilot.zip        (or: bash scripts/update.sh --git to pull the current branch)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
SRC="${1:-}"
[[ -z "$SRC" ]] && { echo "usage: $0 <release.zip> | --git"; exit 1; }
bash scripts/backup.sh
OLD=$(cat VERSION 2>/dev/null || echo unknown)
if [[ "$SRC" == "--git" ]]; then
  git pull --ff-only
else
  TMP=$(mktemp -d); unzip -q "$SRC" -d "$TMP"
  NEW=$(find "$TMP" -maxdepth 2 -name VERSION | head -1)
  rsync -a --exclude data --exclude .env --exclude 'config/*.yaml' --exclude 'config/license.json' "$(dirname "$NEW")/" "$ROOT/"
  # new config keys: show a diff so the operator can merge them deliberately
  for f in "$(dirname "$NEW")"/config/*.yaml; do
    b=$(basename "$f"); [[ -f "config/$b" ]] || cp "$f" "config/$b"
    diff -q "$f" "config/$b" >/dev/null 2>&1 || echo "  config/$b differs from the release (kept yours; compare with $f)"
  done
  rm -rf "$TMP"
fi
echo "updating $OLD -> $(cat VERSION)"
PROFILES=$(docker compose ps --format '{{.Service}}' 2>/dev/null | grep -q sim-police && echo "--profile sim" || true)
docker compose $PROFILES build
docker compose $PROFILES up -d --remove-orphans      # schema migrations run automatically at service start
echo -n "waiting for the API"; for i in $(seq 1 60); do curl -fs localhost:8000/api/version >/dev/null && break; echo -n .; sleep 3; done; echo
curl -fs localhost:8000/api/version && echo && echo "update complete"
