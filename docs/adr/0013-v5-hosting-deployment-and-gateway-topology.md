# ADR-0013: V5 hosting, deployment topology, and LLM gateway placement

- Status: Accepted
- Date: 2026-09-06
- Deciders: Jian (product owner)

## Context

V5 (SLICES.md, KAN-1118/1120/1121) is the first slice that needs any deployment story at all —
V1–V4 ship as an `npx`-installable local tool with no server to operate (ADR-0005's "no
app-store distribution... consistent with the developer-tool positioning"). ADR-0007 left
"Postgres for hosted mode" explicitly as "a placeholder assumption, not an ADR-grade decision...
revisited with its own ADR when V5 is actually being built" — this ADR is where that, and the
rest of the deployment shape, becomes real.

The operator has confirmed two constraints that materially shape this decision: (1) V5 deploys to
a **self-hosted k3s cluster on homelab hardware**, not a managed cloud provider — no AWS/GCP/Azure
account, no managed RDS/Cloud SQL, no managed KMS; and (2) this is a **real multi-tenant SaaS with
public signup**, not a private single-team deployment — so backup/DR, public network exposure, and
abuse-resistance are real requirements from day one, not deferred hardening.

**What exists today, concretely (verified against the codebase):** `packages/cli`'s `SpecStore`
(`packages/cli/src/spec-store.ts:33-91`) does direct `readFileSync`/`writeFileSync` against a
single spec + layout file pair; `RunManager` (`packages/cli/src/run-manager.ts:47-115`) holds runs
in a plain in-memory `Map`, explicitly documented as process-local with no durable store
(`run-manager.ts:12-16`); the Fastify server (`packages/cli/src/server.ts:72-228`) has flat,
unauthenticated, unscoped routes (`/api/spec`, `/api/runs`, ...) with zero concept of a user,
session, or workspace anywhere in the code. `apps/canvas`'s API client
(`apps/canvas/src/api.ts:89-149`) is already origin-agnostic — `createApiClient(baseUrl = "")` is
parameterized and called as `createApiClient(apiBaseUrl)` (`App.tsx:29`) — so the same built
canvas assets can point at a hosted origin with no canvas-side rewrite, exactly realizing
ADR-0005's "one UI codebase serves both local and hosted modes" intent. None of this touches
containers, Kubernetes, or a database today; there is no `Dockerfile`, no `deploy/` directory, no
CI image-build step.

## Decision

**New package: `packages/server`** — a hosted variant of `packages/cli`'s Fastify server, sharing
`packages/spec` (schema/validator, unchanged — ADR-0002 still applies) and `packages/engine`
(execution, unchanged in its core logic) but backed by Postgres (ADR-0014) instead of the
filesystem, and by session-based auth (ADR-0015) instead of no auth at all. `packages/cli` is not
deleted or rewritten — the local single-tenant tool keeps working exactly as it does today; V5 is
a new, additive consumer of the same `spec`/`engine` packages, matching how `packages/exporter`
(ADR-0010) already reuses `packages/engine`'s source without depending on `packages/cli`.

**Containerization.** One container image built from `packages/server` (bundling the built
`apps/canvas` static assets it serves), mirroring `kampong dev`'s single-process shape — one
process serves both the UI and the API in hosted mode too, consistent with ADR-0005's "identical
UI" framing rather than splitting into a separate static-hosting tier for no functional benefit at
homelab scale.

**Orchestration: Helm, not raw manifests.** A chart checked in at `deploy/helm/kampong-server/`,
templating `Deployment`/`Service`/`Ingress`/`Secret`-reference objects, with a `values.yaml` for
homelab-specific settings (replica count, resource limits, ingress host). Raw manifests would work
for a single environment, but a values-templated chart is the standard, low-cost way to keep
"homelab today" from silently becoming "hand-edited YAML nobody can safely change" later.

**Database: Postgres via the CloudNativePG (CNPG) operator**, not a bare `StatefulSet` or a
generic community Helm chart (e.g. Bitnami's). CNPG is purpose-built for running production-grade
Postgres on Kubernetes — it manages failover, connection pooling, and, critically for a
self-hosted deployment with no managed-DB safety net, **scheduled backups to S3-compatible object
storage** (a self-hosted MinIO instance or an actual cloud bucket both work identically from CNPG's
point of view) out of the box. Given "real SaaS, other people's data, no managed cloud DB behind
it," backup/restore cannot be a hand-rolled `pg_dump` cron job bolted on later — it needs to be
part of the initial deployment, and CNPG is what makes that tractable without a dedicated DBA.

**Ingress and TLS.** k3s ships Traefik as its default ingress controller — reuse it rather than
installing a second ingress controller (nginx-ingress, etc.) for no reason; the operator's existing
local-dev Traefik familiarity (per the `traefik-dev-proxy` skill already in this environment)
carries over directly. TLS: `cert-manager` with a Let's Encrypt `ClusterIssuer` (HTTP-01 or DNS-01
challenge, chosen at implementation time based on whether the homelab's DNS provider has a
supported ACME plugin) — real, publicly-trusted certificates are non-negotiable once strangers are
signing up and submitting real API keys over the connection.

**LLM gateway (revisits ADR-0004, KAN-1120): self-hosted LiteLLM as its own Deployment in the same
cluster**, not a library-level retry wrapper inside `packages/server`. ADR-0004's objection to a
local gateway — "adds an extra local service/process to run and configure for a single-user local
tool" — is specific to the *local* single-user case and does not carry over once a Kubernetes
cluster, an operator model, and a real ops surface already exist for V5 regardless. `packages/
server`'s `ModelClient` construction (the DB-backed successor to today's `createMastraModelClient`,
`packages/engine/src/model.ts:393-454`) points at LiteLLM's internal cluster-DNS service address
instead of calling `Anthropic`/`OpenAI`/`Ollama` endpoints directly, giving every workspace's calls
cross-provider failover/retry now that multiple tenants share this path — exactly the "reliability
matters once shared infrastructure exists" trigger ADR-0004 named as the condition for building
this. Hosted Ollama (if offered at all) needs a GPU-capable node in the cluster; homelab GPU
availability is unknown and flagged as an open question, not assumed.

**Secrets at the Kubernetes layer.** Kubernetes `Secret` objects hold: the BYOK root encryption key
(ADR-0016), Postgres credentials (managed automatically by CNPG), and OAuth client secrets
(ADR-0015). If cluster manifests are managed via GitOps (checked into a repo), `SOPS` or Sealed
Secrets should encrypt these before they're committed — flagged as an operational recommendation,
not a blocking decision for this ADR.

**CI/CD.** Extend the existing GitHub Actions CI (`.github/workflows/ci.yml`) with an image
build-and-push step on merge to `main` (or on tag). Full continuous *deployment* (auto-apply to the
cluster) is explicitly **not** decided here — start with a manual `helm upgrade` or a
manually-triggered pipeline step, and revisit GitOps automation (Argo CD, Flux) once V5 has run
in production for a while and the manual step is a real, felt friction — building full CD
automation before there's evidence it's needed repeats exactly the pattern AGENTS.md's governance
guidance already warns against for other infrastructure.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Managed cloud hosting (AWS/GCP/Fly.io/Render) | Directly contradicts the operator's stated k3s-homelab deployment target; would also mean paying for infrastructure already owned. |
| Raw Kubernetes manifests instead of a Helm chart | Works for exactly one environment but has no templating story if a second environment (staging, a future non-homelab deploy) is ever needed; Helm's marginal cost over raw YAML is low. |
| Generic community Postgres Helm chart or a bare `StatefulSet` | Requires hand-rolling failover and backup/restore logic CNPG already implements and operationally tests; a bare `StatefulSet` in particular has no backup story at all without extra tooling. |
| Build a custom retry/failover wrapper inside `packages/server` instead of LiteLLM | Re-derives logic LiteLLM already implements and maintains; repeats the exact "build governance/reliability infra before it's justified" mistake ADR-0004 warned against, except now the infra genuinely is justified (shared, multi-tenant traffic), so there's no reason to hand-roll it. |
| nginx-ingress instead of Traefik | k3s already ships Traefik; installing a second ingress controller adds operational surface for no functional gain, and diverges from the operator's existing local Traefik familiarity. |
| Full GitOps (Argo CD/Flux) from day one | Real value once deploy cadence is high and multiple people/environments are involved; premature operational complexity for a first deployment with one operator. |

## Consequences

- `packages/server` is a new, additive package (per the monorepo's existing `workspaces:
  ["packages/*", "apps/*"]` convention, root `package.json:11-14`) — it does not replace or modify
  `packages/cli`, keeping the local-first MVP fully intact and independently shippable.
- Public exposure of a homelab-hosted service (DDNS/port-forwarding vs. a tunnel like Cloudflare
  Tunnel, defending against a hostile public internet hitting home network infrastructure) is a
  real operational decision this ADR does not resolve — it is network/homelab infrastructure
  outside this project's software scope, but is flagged here as a real, non-optional risk given
  "real SaaS, other people's accounts" rather than left implicit.
- The BYOK root key's own backup/DR (ADR-0016) must be covered by whatever backup plan this ADR's
  CNPG choice establishes for the database — losing the root key without a backup of the key
  itself is a distinct, worse failure mode than losing ordinary application data, and needs its own
  explicit runbook at implementation time.
- LiteLLM introduces a new external dependency (its own container image, its own configuration
  surface for provider routing) that V5 implementation work must track and update independently of
  this project's own release cadence — an accepted, bounded cost, not an oversight.

## Open questions for V5 implementation to revisit

- GPU node availability in the homelab cluster, and whether hosted Ollama is offered at all in a
  first cut or deferred.
- The exact backup retention window and a tested (not just configured) restore runbook.
- Whether public exposure goes through a tunnel service or direct port-forwarding/DDNS, and what
  additional edge protection (rate limiting, a WAF) that choice implies.
- The point at which manual `helm upgrade` deploys become enough of a felt friction to justify
  GitOps automation.
