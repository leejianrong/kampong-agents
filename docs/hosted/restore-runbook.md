# Database backup, restore and failover

The hosted database is a PostgreSQL cluster run by the CloudNativePG operator (`deploy/helm/kampong-postgres`). It
archives write-ahead log (WAL) continuously and takes base backups to an S3-compatible bucket through the Barman Cloud
plugin. A backup that has never been restored is not a backup, so this page has two parts: the drill that proves a
restore works, and the steps to follow on a bad day. ADR-0066 holds the preview to this: no customer pays before the
drill has been run on the real install and its time written down.

## What the drill proved

`scripts/restore-drill.sh` runs in CI (the **Restore drill** workflow) on a throwaway kind cluster with two Postgres
instances and a LocalStack S3 bucket. On 2026-11-28 it did this:

| Step                                                                                 | Result                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Wrote 200,000 rows (25 MB), took a base backup                                       | 6 s                                                           |
| Wrote 1,000 more rows after the backup and waited for that WAL to reach the bucket   | archived                                                      |
| Restored into a **new** cluster using the bucket alone                               | ready in 54 s                                                 |
| Compared the restored database with the source (row count and a checksum of every row) | identical: 201,000 rows, including the 1,000 written after the backup (so WAL replay works) |
| Deleted the primary pod of the source cluster                                        | a new primary was serving in 17 s, no data lost               |

Read these numbers as what they are: a 25 MB database on a CI runner. Restore time grows with the size of the database
and the speed of the link to the bucket, so they prove that the mechanism works, not that your restore will take 54
seconds. **Run the drill on the real install** (below) and record that time; it is the one the preview terms may rely on.

The failover figure is the operator promoting the replica. Clients see a short error while it happens; the server's
database connections reconnect on their own, and a run in flight on that replica may fail and can be started again.

## Run the drill on your own cluster

You need the `kampong-postgres` chart installed with working backups and at least two instances (use one to skip the
failover step). Then, from a checkout:

```bash
kubectl config use-context <your cluster>
RELEASE=kampong-postgres ROWS=200000 scripts/restore-drill.sh
```

It writes a table named `drill_marker` into the `app` database (set `DB` for another), takes a backup, restores into a
new cluster named `<release>-restore-<time>`, compares, kills the primary of the source, and prints the record to keep.
The restored cluster is deleted at the end unless you set `KEEP=1`. To rehearse with a bigger database, raise `ROWS`.

Do this before the first paying customer, after any change to the chart's backup settings, and at least once a quarter.
Write the date and the three times in the place you keep operations notes.

## Set up the bucket

1. Create a bucket that only the database's credentials can write to, with versioning off (the plugin manages
   retention) and encryption on at rest if your store offers it.
2. Create the credentials Secret in the database's namespace before installing the chart:

    ```bash
    kubectl create secret generic kampong-postgres-s3-credentials \
      --from-literal=ACCESS_KEY_ID='...' --from-literal=ACCESS_SECRET_KEY='...'
    ```

3. Install with the bucket and, for a store that is not AWS, its endpoint:

    ```bash
    helm install kampong-postgres deploy/helm/kampong-postgres \
      --set backup.objectStore.bucket=<bucket> --set backup.objectStore.pathPrefix=prod \
      --set backup.objectStore.endpointURL=https://<store>
    ```

4. **Retention** is `backup.retentionPolicy`, 30 days by default: backups and the WAL they need older than that are
   removed. Keep it at least as long as the oldest point you would want to recover to. The schedule is
   `backup.scheduledBackup.schedule`, daily at 02:00 by default.
5. Confirm it works the first day: `kubectl get backup` shows a completed backup, and `kubectl get cluster` shows the
   continuous archiving condition as healthy. A failed backup does not alert anyone by itself; see
   [Know it is working](#know-it-is-working).

## When you need to restore

Use this when the database is lost or damaged and the cluster cannot be repaired by failing over to a replica.

1. **Stop writes.** Scale the server to zero so nothing writes to a database you are about to replace:
   `kubectl scale deployment <server release> --replicas=0`.
2. **Choose the point.** Without a target the restore replays all archived WAL and ends at the latest point the bucket
   holds. For a point in time (before a bad migration, say) add `recoveryTarget.targetTime`.
3. **Create the new cluster** from the bucket. This is what the drill does:

    ```yaml
    apiVersion: postgresql.cnpg.io/v1
    kind: Cluster
    metadata:
      name: kampong-postgres-restored
    spec:
      instances: 2
      imageName: <the same image as the source>
      storage:
        size: <at least the source's>
      bootstrap:
        recovery:
          source: origin
          # recoveryTarget:
          #   targetTime: "2026-11-28 09:15:00+00"
      externalClusters:
        - name: origin
          plugin:
            name: barman-cloud.cloudnative-pg.io
            parameters:
              barmanObjectName: kampong-postgres-backup
              serverName: kampong-postgres
    ```

4. **Wait for it:** `kubectl wait --for=condition=Ready cluster/kampong-postgres-restored --timeout=1h`.
5. **Check it** before pointing anything at it: connect and look at the newest rows in `runs` and `audit_events`,
   and count `workspaces`. The drill's row-count and checksum comparison is the model.
6. **Point the server at it.** Update the `kampong-postgres-app` Secret's `uri` to the new cluster's service (the new
   cluster generates its own `<name>-app` Secret), then scale the server back up. The migration job runs on upgrade and
   is safe on a restored database.
7. **Give the new cluster its own backups.** Install or upgrade the chart so the restored cluster archives to a **new**
   server name or a new path prefix; a cluster must not archive into the path of the one it was restored from.
8. **Keep `BYOK_ROOT_KEY`.** Stored model keys and connector secrets are encrypted under it. A restored database is
   unreadable for those without it, which is why it has its own backup, apart from the database's.

What is lost: anything written after the last archived WAL segment, normally seconds, and any run that was in
flight, which fails and can be started again. Approvals waiting for a person survive, since they are stored in the
database.

## Know it is working

- The **Restore drill** workflow runs weekly and on any change to the chart, and fails loudly if a backup stops
  restoring. It runs against a test bucket, not yours.
- On the real install, alert on a backup that has not completed in 26 hours and on continuous archiving reporting a
  failure. The operator exposes both as metrics; wiring them to an alert is part of the status page work (KAM-330) and
  is **not done**. Until then, check `kubectl get backup` by hand each week.

## Not covered

Losing the whole site (the homelab) is a disaster the bucket survives only if the bucket is somewhere else. Keep the
bucket off the homelab, or accept that a site loss is a data loss. Multi-region replication is out of scope.
