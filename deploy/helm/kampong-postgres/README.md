# kampong-postgres

V5 hosted Postgres for Kampong Agents (ADR-0013, ADR-0014, KAN-1222) — a
[CloudNativePG](https://cloudnative-pg.io) (CNPG) `Cluster`, wired to the
[Barman Cloud CNPG-I plugin](https://cloudnative-pg.io/plugin-barman-cloud)
for scheduled backups to S3-compatible object storage from day one.

This chart is infrastructure-as-code only. It does **not** install the CNPG
operator or the Barman Cloud plugin themselves (those are one-time,
cluster-wide prerequisites, step 1 below) and it does **not** touch
`packages/server` — wiring the server's DB client to the connection secret
this chart produces is a separate, later card (KAN-1223/1224).

## Versions this chart targets

| Component                  | Version                                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudNativePG operator     | **v1.30.x** (authored against v1.30.0, released 2026-06-29)       | Current stable minor release line as of this chart's authoring (2026-09).                                                                                                                                                                                                                                                                                                                                   |
| Barman Cloud CNPG-I plugin | **v0.15.x** (authored against v0.15.0, released 2026-09-04)       | Current release of the plugin that implements CNPG's _current_ backup mechanism (see below). Its own metadata marks it `alpha` maturity — it is nonetheless the CNPG project's own documented, supported path forward; re-check `https://cloudnative-pg.io/plugin-barman-cloud/docs/` before bumping either version, since this mechanism has already superseded one prior approach and could evolve again. |
| PostgreSQL                 | **18.4** (`ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie`) | CNPG 1.30's own default image; pinned explicitly in `values.yaml` (`cluster.imageName`) rather than left to float.                                                                                                                                                                                                                                                                                          |

**Backup mechanism note:** CNPG's backup configuration has changed shape
over its history. Older CNPG releases configured backups with an in-CR
`Cluster.spec.backup.barmanObjectStore` field. Current CNPG releases
implement backups through a separate plugin architecture (CNPG-I) — this
chart targets that current mechanism: a standalone `ObjectStore` custom
resource (`barmancloud.cnpg.io/v1`, installed by the Barman Cloud plugin)
that the `Cluster` references via `spec.plugins[].parameters.barmanObjectName`,
with `Backup`/`ScheduledBackup` resources set to `method: plugin`. If you are
reading this well after 2026-09 and CNPG's docs describe something different,
trust CNPG's own current documentation over this file — re-verify before
reusing this chart's templates unchanged.

## 1. One-time cluster-wide prerequisites (outside this chart)

Operators (CNPG, the Barman Cloud plugin) are cluster singletons, not
per-application Helm releases — install them once, cluster-wide, before
installing this chart. This is a deliberate manual step for now (ADR-0013:
"start with a manual step," not full GitOps automation from day one).

### 1a. Install the CNPG operator

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update
helm upgrade --install cnpg \
  --namespace cnpg-system --create-namespace \
  cnpg/cloudnative-pg \
  --version 0.29.0   # chart version whose appVersion is operator v1.30.0
```

Verify:

```bash
kubectl get deployment -n cnpg-system cnpg-controller-manager
```

### 1b. Install cert-manager (a Barman Cloud plugin prerequisite)

The plugin communicates with the CNPG operator over gRPC/TLS and needs
cert-manager present in the cluster. If it isn't already installed:

```bash
helm repo add jetstack https://charts.jetstack.io --force-update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true
```

### 1c. Install the Barman Cloud CNPG-I plugin

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update
helm upgrade --install plugin-barman-cloud \
  --namespace cnpg-system \
  cnpg/plugin-barman-cloud \
  --version 0.8.0   # chart version whose appVersion is plugin v0.15.0
```

Verify:

```bash
kubectl -n cnpg-system rollout status deploy/plugin-barman-cloud
```

## 2. Create the S3 credentials Secret (before installing this chart)

This chart never creates, embeds, or defaults real S3 credentials — per
ADR-0013's "secrets at the Kubernetes layer" decision, you create this
`Secret` yourself, in the same namespace this chart's release will target,
**before** running `helm install`. `values.yaml`'s
`backup.objectStore.credentialsSecretName` must name it (default:
`kampong-postgres-s3-credentials`).

Required shape (a plain `Opaque` Secret with these two keys — the key names
must match `values.yaml`'s `backup.objectStore.credentialsSecretKeys`,
defaulted below):

```bash
kubectl create secret generic kampong-postgres-s3-credentials \
  --namespace <your-namespace> \
  --from-literal=ACCESS_KEY_ID='...' \
  --from-literal=ACCESS_SECRET_KEY='...'
```

This works identically whether the bucket is a self-hosted MinIO instance or
a real cloud bucket (ADR-0013) — only the access key ID/secret access key
pair need to be real credentials for whichever S3-compatible endpoint you
configure via `values.yaml`'s `backup.objectStore.endpointURL`.

Note: the S3 **region** is _not_ expected in this Secret. CNPG's own
`S3Credentials` API models region as a secret reference too (not a plain
string field on the custom resource), but since a region name isn't
sensitive, this chart materializes its own small Secret from the plain
`values.yaml` string `backup.objectStore.region` (`us-east-1` by default) —
see `templates/region-secret.yaml`. You only need to hand-create the Secret
above for the two real credential values.

## 3. Configure and install this chart

At minimum, set the bucket (and endpoint, if using a self-hosted MinIO
instance rather than real AWS S3):

```bash
helm install kampong-postgres deploy/helm/kampong-postgres \
  --namespace <your-namespace> \
  --set backup.objectStore.bucket=kampong-postgres-backups \
  --set backup.objectStore.pathPrefix=prod \
  --set backup.objectStore.endpointURL=https://minio.your-homelab.svc:9000 \
  --set cluster.storage.storageClass=<your-storage-class>
```

See `values.yaml` for every configurable field (instance count, storage
size/class, resource requests/limits, backup schedule, retention policy,
etc.) — every field there carries a comment explaining what it does and why
it defaults the way it does.

## 4. Where the resulting connection details land

Once applied, CNPG auto-generates (by its own "convention over
configuration" behavior, confirmed against its current documentation) a
Kubernetes `Secret` named **`<cluster-name>-app`** — with this chart's
default `fullnameOverride`/release-name behavior, that's
`kampong-postgres-app` for a release named `kampong-postgres`. It is a
`kubernetes.io/basic-auth`-classed Secret holding, among other keys:
`username`, `password`, `dbname`, `host`, `port`, `uri`, and `jdbc-uri` — the
`app`-user connection details `packages/server` will eventually consume as
its `DATABASE_URL`-equivalent.

**Wiring `packages/server` to actually read and use this Secret is a
separate, later card (KAN-1223/1224)** — this chart's job stops at standing
up the database and its connection Secret; it does not modify any
TypeScript source.

## 5. What this chart does not (yet) validate

There is no live cluster available to this repository's CI or to whoever
authors this chart — so validation here is necessarily static:

- `helm lint` and `helm template` (piped through a YAML parser) confirm the
  chart renders syntactically valid Kubernetes/CNPG-shaped YAML.
- **Full schema/admission validation against the CNPG and Barman Cloud
  plugin CRDs has NOT been performed** — that requires those CRDs installed
  against a real (or at least a `kubectl apply --dry-run=server`-capable)
  cluster, which isn't available here. The `Cluster`, `ObjectStore`, and
  `ScheduledBackup` shapes in this chart's templates were checked by hand
  against CNPG's and the Barman Cloud plugin's own current source/API
  reference (`cluster_types.go`, `objectstore_types.go`,
  `scheduledbackup_types.go`, `backup_types.go` in their respective GitHub
  repos) and documented examples, not against a running admission webhook.
  Before relying on this in a real deployment, apply it to a real (even a
  throwaway `k3d`/`kind`) cluster with the operator and plugin installed and
  confirm the `Cluster` reaches a healthy state and a manual `Backup`
  succeeds — a real restore drill (per ADR-0013's own open question) is a
  separate, later exercise this chart does not claim to have performed.

## 6. Explicitly out of scope for this chart/card

- Installing the CNPG operator or the Barman Cloud plugin as part of this
  repo's own CI/CD — a one-time, out-of-band cluster-admin action (ADR-0013,
  KAN-1222's own scoping).
- Any change to `packages/server` (DB client, Drizzle, connection wiring) —
  KAN-1223/1224.
- Row-Level Security policies — KAN-1225.
- Auth/Better Auth — KAN-1226.
