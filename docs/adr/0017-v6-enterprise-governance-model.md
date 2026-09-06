# ADR-0017: V6 enterprise governance model

- Status: Accepted
- Date: 2026-09-06
- Deciders: Jian (product owner)

## Context

V6 (KAN-1122–1126) requires SSO/SCIM, RBAC roles (Creator/Operator/Auditor/Tool Manager), PII
scrubbing/egress policy rules, SIEM-exportable audit logs, and per-run cost circuit breakers — five
one-line `[ROADMAP]` cards today, none scoped in depth. PLAN.md's own sequencing rationale is that
none of this is meaningful "in a single-user local tool" — V6 exists to satisfy IT/security review
of a _shared_ system, which only exists once V5 ships. The operator has confirmed strict
sequencing (V5 fully before V6 begins), so this ADR builds entirely on V5's now-decided
foundations: Postgres + Drizzle + RLS multi-tenancy (ADR-0014) and Better Auth's session/
organization/SSO-plugin account model (ADR-0015). This ADR is a scoping decision, in the same
"firm recommendation plus explicitly flagged open questions" style as ADR-0011/0012, not an
implementation plan.

## Decision

### 1. SSO/SCIM: activate Better Auth's already-adopted `sso` plugin; SCIM is a separate, unscoped gap.

**Firm recommendation.** ADR-0015 adopted Better Auth specifically so its `sso` plugin (OIDC/SAML
as a relying party) would be available, dormant, until V6. V6 turns it on: a workspace admin
configures their own identity provider (Okta, Azure AD, Google Workspace, etc.) as that workspace's
sign-in source, scoped per-workspace rather than globally — a workspace that hasn't configured SSO
keeps using V5's email+password/GitHub OAuth unchanged.

**Open question, not resolved here:** SCIM (automated user provisioning/deprovisioning driven by
the customer's IdP) is a distinct protocol Better Auth does not implement out of the box as of
today. This is a real, unscoped gap — V6 implementation work needs its own research pass on SCIM
specifically (a community plugin, a hand-rolled SCIM endpoint, or descoping automated provisioning
from a first V6 cut in favor of manual admin-driven user management) rather than assuming the SSO
plugin choice already covers it.

### 2. RBAC: four roles as a permission matrix over existing routes, built on Better Auth's organization/access-control primitive — not a new authorization engine.

**Firm recommendation.** Better Auth's `organization` plugin (adopted in ADR-0015 for workspace/
member modeling) ships an access-control primitive that roles attach to. V6 defines Creator/
Operator/Auditor/Tool Manager as a fixed permission matrix over the API routes `packages/server`
already exposes (spec read/write, run start/approve, tool config read/write) rather than inventing
a general-purpose policy language. Concretely: a Compliance Auditor role denies every mutating
route at the same auth middleware layer ADR-0015 already established for resolving the current
user and workspace, while allowing read-only routes (spec read, run history, audit log read) —
this is the acceptance criterion SLICES.md already names for this feature ("that user can view an
audit log entry for a real run but cannot edit or run agents").

**Open question:** whether four fixed roles remain sufficient once real customers use this, or
whether demand emerges for custom/composable roles — deferred until there's evidence of the need,
consistent with this project's general anti-premature-infrastructure stance.

### 3. PII scrubbing/egress: policy middleware around the existing tool-call path, reusing the existing guardrail pause mechanism — not a new blocking protocol.

**Firm recommendation.** Implemented as middleware wrapping the existing HTTP tool-call path
(`packages/engine/src/http-tool.ts`, also vendored per ADR-0010 into every exported project) — a
workspace-configurable policy (rule-based: block a disallowed HTTP verb, block a destination domain
not on an allowlist, redact a PII-shaped pattern from a request/response) evaluated before a tool
call is dispatched. A rule violation reuses the existing `requires_approval`/`fallback_action`
pause mechanism from ADR-0009 (the same yield/resume seam `AgentRun.start`/`resume` already
provides) rather than inventing a second, parallel blocking protocol — exactly the kind of reuse
ADR-0011 already validated this seam for when it extended it to sub-agent delegation.

**Open question:** whether policy rules are configured via a UI builder or as YAML/JSON policy
files (mirroring `AgentSpec`'s own YAML-first, hand-authorable ethos) — a real implementation
choice not resolved here, though the YAML-first option is the more consistent-with-this-project's-
conventions starting point.

### 4. Audit logs: a new `audit_events` table, populated as a side effect of RBAC/PII enforcement points already being built — not a separately instrumented pass.

**Firm recommendation.** A new `audit_events` table (`workspace_id`, `actor`, `action`, `resource`,
`timestamp`, structured JSON `detail`), following ADR-0014's shared-schema-plus-RLS pattern like
every other tenant-scoped table. Entries are written at the exact points RBAC's middleware (item 2)
and the PII/egress tool-call gate (item 3) already intercept requests — audit logging falls out of
enforcement work V6 is already doing, rather than requiring a separate instrumentation pass across
the whole codebase. "SIEM-exportable" means the JSON shape is documented, versioned, and stable,
plus a simple export endpoint or webhook — not a commitment to any specific SIEM vendor's
integration format.

**Open question:** exact retention and immutability guarantee — genuine WORM (write-once-read-many)
storage, or an application-level append-only convention enforced by Postgres permissions (e.g. no
`UPDATE`/`DELETE` grant on the table for the application role) — not decided here.

### 5. Cost circuit breakers: protect the operator's compute, not just the customer's BYOK spend.

**Firm recommendation.** Because V5 is BYOK, a workspace's own dollar cost is already the
workspace's own concern, not the operator's — the framing SLICES.md's original one-line sketch
implies ("per-run cost/token circuit breakers... department-level cost attribution") is only half
the picture on a self-hosted homelab deployment. The other half is protecting the _operator's own
compute_ (a homelab k3s cluster, not elastically-scaling cloud infrastructure, per ADR-0013) from
abusive or runaway workspace usage — run frequency/duration limits matter here regardless of whose
API key is being billed. Token/cost estimation per run (from whatever usage metadata the Vercel AI
SDK response already exposes) is recorded in `runs` (ADR-0014), with a configurable per-workspace
threshold that halts further runs once crossed — surfaced via the same fail-visibly convention
(ADR-0004) as any other guardrail, not a silent throttle.

**Open question:** the exact threshold model (hard stop vs. rate-limited degradation) and whether
department-level attribution (implying sub-workspace grouping) is real V6-launch scope or a
later refinement — SLICES.md's original phrasing names it, but the data model for "department"
within a workspace is not designed here.

## Alternatives considered

| Option                                                                                       | Why not                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-host Keycloak or Authentik as this app's own IdP for V6 SSO                             | Conflates being an IdP with accepting SSO from a _customer's_ IdP — the same distinction ADR-0015 already drew; this app remains the relying party, not the identity provider, for the customer's own users.                             |
| A generic policy engine (OPA/Rego) for RBAC and PII/egress instead of hand-rolled middleware | Disproportionate infrastructure for four fixed roles and a modest rule set; revisit only if the rule surface grows past what a readable middleware chain can express, which nothing today indicates.                                     |
| A dedicated eval/audit-log service instead of a Postgres table                               | No identified scale or query pattern justifies a separate system yet; a well-modeled table with RLS already gives per-workspace isolation and fits the existing data layer without new infrastructure.                                   |
| Building SCIM support as part of this ADR's firm recommendations                             | No existing library coverage (unlike SSO's OIDC/SAML, which Better Auth already implements) and no concrete design has been done — honestly flagging it as an open gap is more useful than a confident-sounding but ungrounded proposal. |

## Consequences

- V6 introduces almost no new _infrastructure_ of its own — it is new middleware and new tables
  layered entirely on V5's Postgres/Better Auth foundation (ADR-0014, ADR-0015), which is precisely
  the "nothing to review until a shared system exists" sequencing logic PLAN.md already gave for
  putting V6 after V5, now made concrete rather than asserted.
- SCIM remains a real, unscoped implementation gap that V6 work must budget explicit research time
  for, not assume is solved by the SSO plugin choice.
- RBAC, PII/egress, and audit logging share one enforcement point (the auth middleware and the
  tool-call gate) rather than three independent subsystems — a deliberate design choice that keeps
  V6 additive to V5's existing request-handling path rather than a parallel structure bolted
  alongside it.

## Open questions for V6 implementation to revisit

- SCIM protocol implementation approach (library, hand-rolled, or descoped from a first cut).
- Whether four fixed RBAC roles are sufficient at launch or need to become composable.
- PII/egress policy authoring surface (UI builder vs. YAML/JSON policy files).
- Audit log retention/immutability mechanism.
- The cost-circuit-breaker threshold model and whether department-level attribution is in scope for
  V6's first cut or a later refinement.
