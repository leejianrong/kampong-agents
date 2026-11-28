#!/usr/bin/env bash
# The restore and failover drill for the hosted database (KAM-329). Run it against a cluster where the
# `kampong-postgres` chart is installed and its backups work (docs/hosted/restore-runbook.md). It
#   1. writes known data into the database,
#   2. takes a backup and times it,
#   3. writes more after the backup and waits for that WAL to reach the object store,
#   4. restores into a NEW cluster from the object store only, and times it,
#   5. checks the restored database holds exactly what the source held (a row count and a checksum),
#   6. kills the primary of the source cluster and times the failover (with two or more instances).
# Everything it prints is the record to keep. Exits non-zero on the first failed check.
#
# Settings: RELEASE (default kampong-postgres)  ROWS (default 200000)  DB (default app)  KEEP=1 keeps the restored cluster
set -euo pipefail

RELEASE="${RELEASE:-kampong-postgres}"
ROWS="${ROWS:-200000}"
DB="${DB:-app}"
KEEP="${KEEP:-0}"
SOURCE="$RELEASE"
STORE="${RELEASE}-backup"
STAMP="$(date +%s)"
RESTORE="${RELEASE}-restore-${STAMP}"
BACKUP="drill-${STAMP}"

say() { printf '\n== %s\n' "$*"; }
note() { printf '%s\n' "$*"; SUMMARY="${SUMMARY:-}$*"$'\n'; }
now() { date +%s; }
primary_of() { kubectl get cluster "$1" -o jsonpath='{.status.currentPrimary}'; }
sql() { # sql <cluster> <statement>: run on that cluster's primary, return the bare value
  kubectl exec "$(primary_of "$1")" -c postgres -- psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAc "$2"
}
fingerprint() { sql "$1" "select count(*) || ' ' || coalesce(md5(string_agg(h, '' order by id)), '-') from drill_marker"; }

say "Waiting for the source cluster $SOURCE"
kubectl wait --for=condition=Ready "cluster/$SOURCE" --timeout=600s

say "1. Writing $ROWS rows"
sql "$SOURCE" "drop table if exists drill_marker; create table drill_marker (id int primary key, h text not null); insert into drill_marker select g, md5(g::text) from generate_series(1,$ROWS) g" >/dev/null

say "2. Taking a backup"
t0=$(now)
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: $BACKUP
spec:
  cluster:
    name: $SOURCE
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
kubectl wait --for=jsonpath='{.status.phase}'=completed "backup/$BACKUP" --timeout=900s
t1=$(now)
BACKUP_SECS=$((t1 - t0))
note "backup: ${BACKUP_SECS}s for a database of $(sql "$SOURCE" "select pg_size_pretty(pg_database_size('$DB'))")"

say "3. Writing after the backup, and waiting for that WAL to be archived"
sql "$SOURCE" "insert into drill_marker select g, md5(g::text) from generate_series($((ROWS + 1)), $((ROWS + 1000))) g" >/dev/null
SWITCHED="$(sql "$SOURCE" "select pg_walfile_name(pg_switch_wal())")"
for _ in $(seq 1 60); do
  [ "$(sql "$SOURCE" "select coalesce(last_archived_wal, '') >= '$SWITCHED' from pg_stat_archiver")" = t ] && break
  sleep 2
done
[ "$(sql "$SOURCE" "select coalesce(last_archived_wal, '') >= '$SWITCHED' from pg_stat_archiver")" = t ] ||
  { echo "drill: WAL $SWITCHED was never archived; check the object store and the plugin" >&2; exit 1; }
WANT="$(fingerprint "$SOURCE")"
note "source holds: $WANT"

say "4. Restoring into a new cluster, $RESTORE, from the object store only"
IMAGE="$(kubectl get cluster "$SOURCE" -o jsonpath='{.spec.imageName}')"
SIZE="$(kubectl get cluster "$SOURCE" -o jsonpath='{.spec.storage.size}')"
t2=$(now)
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $RESTORE
spec:
  instances: 1
  imageName: $IMAGE
  storage:
    size: $SIZE
  bootstrap:
    recovery:
      source: origin
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: $STORE
          serverName: $SOURCE
EOF
kubectl wait --for=condition=Ready "cluster/$RESTORE" --timeout=1200s
t3=$(now)
RESTORE_SECS=$((t3 - t2))
note "restore: ${RESTORE_SECS}s until the new cluster was ready"

say "5. Checking what was restored"
GOT="$(fingerprint "$RESTORE")"
note "restored holds: $GOT"
[ "$GOT" = "$WANT" ] || { echo "drill: the restored database differs from the source" >&2; exit 1; }
note "restored data matches the source, including the rows written after the backup (WAL replay)"

if [ "$(kubectl get cluster "$SOURCE" -o jsonpath='{.spec.instances}')" -ge 2 ]; then
  say "6. Failover: deleting the primary of $SOURCE"
  OLD="$(primary_of "$SOURCE")"
  t4=$(now)
  kubectl delete pod "$OLD" --wait=false
  for _ in $(seq 1 120); do
    NEW="$(primary_of "$SOURCE" 2>/dev/null || true)"
    [ -n "$NEW" ] && [ "$NEW" != "$OLD" ] && break
    sleep 1
  done
  [ "${NEW:-}" != "$OLD" ] && [ -n "${NEW:-}" ] || { echo "drill: no new primary after the old one was deleted" >&2; exit 1; }
  kubectl wait --for=condition=Ready "cluster/$SOURCE" --timeout=300s
  t5=$(now)
  FAILOVER_SECS=$((t5 - t4))
  AFTER="$(fingerprint "$SOURCE")"
  [ "$AFTER" = "$WANT" ] || { echo "drill: data changed across the failover" >&2; exit 1; }
  note "failover: new primary $NEW took over in ${FAILOVER_SECS}s with no data lost"
else
  note "failover: skipped (the source has one instance)"
fi

[ "$KEEP" = 1 ] || kubectl delete cluster "$RESTORE" --wait=false >/dev/null

say "Drill record"
printf '%s' "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Restore drill"; echo; printf '%s' "$SUMMARY" | sed 's/^/- /'; } >>"$GITHUB_STEP_SUMMARY"
fi
echo "drill passed"
