# Hosted smoke and isolation gate (KAM-340)

`smoke.mjs` drives a deployed hosted server over HTTP with no dependencies. The `Hosted smoke` workflow builds the
server image, installs `deploy/helm/kampong-server` on a throwaway kind cluster against a plain Postgres (a
non-superuser role, so row-level security applies), and runs it.

It checks, in order:

1. The isolation check itself fails against a server that leaks (a canary, run first every time).
2. `/healthz`, two tenants signing up, each deploying a spec.
3. Webhook, pause for approval, approve, finish.
4. Twenty runs in flight across both tenants: each ends with its own tenant's result, and the other tenant gets 404
   for it, including when it tries to approve it.
5. Tenant B sees nothing of A's: spec list, spec, deployment, audit export.

Run it by hand against any server: `BASE_URL=http://127.0.0.1:8080 node e2e/hosted-smoke/smoke.mjs`. With
`CANARY_ONLY=1` it runs only the first check, with no server.

The in-process half (two replicas firing a schedule once, concurrent tenants) is
`packages/server/test/integration/routes/hosted-gate.test.ts`, which runs in the normal Integration job.

It runs on changes to the server, the engine, the chart and itself, on a manual dispatch and on `v*` tags. It is not
yet a required check; make it one once it has been steady, so a failure blocks a release.
