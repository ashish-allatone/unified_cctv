# PostgreSQL high-availability cluster (3 nodes)

Patroni manages three PostgreSQL 16 nodes (one leader, two synchronous/streaming replicas) with a 3-node etcd for
leader election; HAProxy gives the platform a single address that always points at the current leader. Losing
any one node — PostgreSQL or etcd — costs nothing; losing the leader triggers an automatic promotion in ~10 s,
and the platform reconnects by itself (`pool_pre_ping` on every connection).

```
 api / workers ──► pg-haproxy:5000 (writes → leader)      pg-haproxy:5001 (reads → replicas)
                        │ health: GET :8008/primary | /replica (Patroni REST)
            ┌───────────┼───────────┐
          pg1          pg2          pg3        Patroni + PostgreSQL 16 (Spilo image), streaming replication
            └─── etcd1 · etcd2 · etcd3 ───┘    consensus (quorum 2 of 3)
```

## Bring it up (same VM as the platform)

```bash
cd ~/unified-cctv/deploy/postgres-ha
cp .env.example .env && nano .env            # three random passwords: openssl rand -hex 16
docker compose up -d
docker compose exec pg1 patronictl -c /home/postgres/postgres.yml list     # one Leader, two Replicas, all "running"
```

## Move the platform's data onto it (keeps everything)

```bash
cd ~/unified-cctv
bash deploy/postgres-ha/migrate.sh
```
Stops the writers, dumps the single-container database, restores it into the cluster, sets
`PG_HOST=pg-haproxy` / `PG_PORT=5000` in `.env`, starts the platform. The old `postgres` container is left
untouched as a fallback (set `PG_HOST=postgres`, `PG_PORT=5432` to go back).

## Prove failover (for the demo)

```bash
bash deploy/postgres-ha/failover-demo.sh
```
Stops the current leader, prints the new leader a few seconds later, checks the API still answers, and brings
the old leader back as a replica. HAProxy stats: http://127.0.0.1:7000 (via SSH tunnel).

## Three VMs instead of one

Same files; run `etcdN` + `pgN` + an HAProxy on each VM, replace the service names in `ETCD3_HOSTS`, the etcd
`--initial-cluster` and `haproxy.cfg` with the VMs' private IPs, open 2379/2380 (etcd), 5432 and 8008
(Patroni) between the VMs only, and point every platform node at its local HAProxy. Backups:
`pg_dump` from a replica via port 5001 (or WAL archiving to the object-storage bucket with `wal-g`, which
Spilo supports through `AWS_*` / `WALG_S3_PREFIX` environment variables).

## Day-2

| task | command |
|---|---|
| cluster state | `docker compose exec pg1 patronictl -c /home/postgres/postgres.yml list` |
| planned switchover (maintenance) | `docker compose exec pg1 patronictl -c /home/postgres/postgres.yml switchover` |
| re-add a node that was out for long | `docker compose exec pgN patronictl -c /home/postgres/postgres.yml reinit uvp pgN` |
| logs | `docker compose logs -f pg1` |
