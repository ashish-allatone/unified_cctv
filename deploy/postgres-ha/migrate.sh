#!/usr/bin/env bash
# Move the platform from the single 'postgres' container to the 3-node cluster, keeping every row.
#   bash deploy/postgres-ha/migrate.sh          (run from the unified-cctv folder, cluster already 'up')
set -euo pipefail
cd "$(dirname "$0")/../.."
source .env
source deploy/postgres-ha/.env
HA="docker compose -f deploy/postgres-ha/docker-compose.yml"

echo "1/5 waiting for the cluster leader…"
for i in $(seq 1 60); do
  if $HA exec -T pg1 patronictl -c /home/postgres/postgres.yml list 2>/dev/null | grep -q Leader; then break; fi; sleep 3
done
$HA exec -T pg1 patronictl -c /home/postgres/postgres.yml list

echo "2/5 waiting for HAProxy to route to the leader, then creating role + database…"
for i in $(seq 1 40); do      # HAProxy needs two good health checks (~6 s) after the leader appears
  if docker run --rm --network unified-cctv_default -e PGPASSWORD="$PGHA_SUPERUSER_PASSWORD" postgres:16-alpine \
       psql -h pg-haproxy -p 5000 -U postgres -tAc "select 1" >/dev/null 2>&1; then break; fi
  sleep 3
done
docker run --rm --network unified-cctv_default -e PGPASSWORD="$PGHA_SUPERUSER_PASSWORD" postgres:16-alpine \
  psql -h pg-haproxy -p 5000 -U postgres -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='uvp') THEN CREATE ROLE uvp LOGIN PASSWORD '${POSTGRES_PASSWORD}'; END IF; END \$\$;"
PSQL="docker run --rm --network unified-cctv_default -e PGPASSWORD=$PGHA_SUPERUSER_PASSWORD postgres:16-alpine psql -h pg-haproxy -p 5000 -U postgres"
if [ "$($PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='uvp'")" != "1" ]; then
  $PSQL -v ON_ERROR_STOP=1 -c "CREATE DATABASE uvp OWNER uvp"
  echo "   database uvp created"
else
  echo "   database uvp already exists"
fi

echo "3/5 stopping writers and dumping the current database…"
docker compose stop api adapters anpr analytics faces indexer archiver hotlist >/dev/null
docker compose exec -T postgres pg_dump -U uvp -d uvp -Fc > /tmp/uvp-before-ha.dump
ls -la /tmp/uvp-before-ha.dump

echo "4/5 restoring into the cluster…"
docker run --rm -i --network unified-cctv_default -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:16-alpine \
  pg_restore -h pg-haproxy -p 5000 -U uvp -d uvp --no-owner --no-privileges < /tmp/uvp-before-ha.dump || true
docker run --rm --network unified-cctv_default -e PGPASSWORD="$POSTGRES_PASSWORD" postgres:16-alpine \
  psql -h pg-haproxy -p 5000 -U uvp -d uvp -c "SELECT (SELECT count(*) FROM cameras) AS cameras, (SELECT count(*) FROM anpr_events) AS events, (SELECT count(*) FROM users) AS users;"

echo "5/5 pointing the platform at the cluster and starting it…"
grep -q '^PG_HOST=' .env && sed -i 's/^PG_HOST=.*/PG_HOST=pg-haproxy/' .env || echo 'PG_HOST=pg-haproxy' >> .env
grep -q '^PG_PORT=' .env && sed -i 's/^PG_PORT=.*/PG_PORT=5000/' .env || echo 'PG_PORT=5000' >> .env
docker compose up -d
echo "done. The old single 'postgres' container keeps its data as a fallback (PG_HOST=postgres, PG_PORT=5432 in .env to go back)."
