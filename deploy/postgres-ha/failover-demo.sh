#!/usr/bin/env bash
# Shows automatic failover: stop the current leader, watch a replica take over, platform keeps working.
set -euo pipefail
cd "$(dirname "$0")"
HA="docker compose"
list() { $HA exec -T pg1 patronictl -c /home/postgres/postgres.yml list 2>/dev/null || $HA exec -T pg2 patronictl -c /home/postgres/postgres.yml list; }
echo "--- before"; list
LEADER=$(list | awk '/Leader/ {print $2}')
echo "--- stopping leader $LEADER"; $HA stop "$LEADER"
for i in $(seq 1 20); do sleep 2; NEW=$(list | awk '/Leader/ {print $2}' || true); [ -n "$NEW" ] && [ "$NEW" != "$LEADER" ] && break; done
echo "--- after ($((i*2)) s): new leader = $NEW"; list
echo "--- platform check"; curl -s -o /dev/null -w "API /api/version -> HTTP %{http_code}\n" http://localhost:8000/api/version
echo "--- bringing $LEADER back as a replica"; $HA start "$LEADER"; sleep 10; list
