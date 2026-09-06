# ADR-0014: V5 database choice and multi-tenancy data model

- Status: Accepted
- Date: 2026-09-06
- Deciders: Jian (product owner)

## Context

ADR-0007 named "no database in v1" and flagged Postgres as "the working default assumption" for
hosted mode "not a decision made now." V5 (KAN-1118, KAN-1119, KAN-1121) needs accounts,
workspaces, per-workspace spec storage, and durable run history — none of which exist today.

**What exists today, concretely:** `SpecStore` (`packages/cli/src/spec-store.ts:33-91`) is
constructed with a single `specPath`/`layoutPath` pair and talks to the filesystem directly —
`readSource()` calls `readFileSync(this.specPath, "utf8")` (`spec-store.ts:39-40`), and
`writeLayout`/`applyPatchAndSave` call `writeFileSync` directly (`spec-store.ts:48-55, 89`). There
is no repository/interface boundary today — `createDevServer` (`packages/cli/src/server.ts:72-95`)
instantiates `new SpecStore(...)` concretely, so nothing currently stands between "the server
route handler" and "a literal file on disk." `RunManager` (`packages/cli/src/run-manager.ts:47-
115`) holds runs in a plain in-memory `Map`, by design and by comment ("process-local and
in-memory... no run-history store," `run-manager.ts:12-16`) — there is no run persistence
anywhere. This ADR is also the concrete answer to the question AGENTS.md poses about ADR-0002:
does "YAML is the single lossless source of truth" still hold server-side, multi-tenant? — see
Decision, final point.

The operator has confirmed this deployment is a genuine multi-tenant SaaS with public signup and
that Postgres needs to be stood up from scratch as part of this work (no existing instance to
connect to).

## Decision

**Database: Postgres**, confirming ADR-0007's placeholder, run via the CloudNativePG operator per
ADR-0013.

**ORM/query layer: Drizzle**, not Prisma. Drizzle's SQL-like, schema-as-TypeScript-code approach
(no separate schema DSL file, no codegen step generating an opaque client) fits this project's
established preference for thin, explicit layers over the query surface — the same reasoning that
picked the `yaml` package over `js-yaml` for a specific, concrete property (comment/format
preservation) rather than picking a heavier tool by default (ADR-0007). Drizzle also ships a
first-party adapter for Better Auth (ADR-0015), which is a real, load-bearing synergy: the auth
system and the application data layer share one ORM and one migration pipeline rather than two.

**Multi-tenancy model: shared database, shared schema, `workspace_id` column on every tenant-scoped
table, enforced by both the application's repository layer _and_ Postgres Row-Level Security (RLS)
policies.** Given "real multi-tenant SaaS, others will sign up" (the operator's own framing), an
application-layer-only scoping discipline — every query must remember to add `WHERE workspace_id =
$1` — is a realistic and severe failure mode: one missed clause in one route handler is a
cross-tenant data leak. RLS makes that a database-enforced guarantee instead of a code-review
discipline: every tenant-scoped table gets a policy keyed on a session-local `app.workspace_id`
setting that the connection-handling middleware sets per request, so a query that forgets to filter
by workspace still cannot see another workspace's rows. Schema-per-tenant or database-per-tenant
(the two usual stronger-isolation alternatives) are rejected for now — real operational weight
(one schema/DB per signup, migrations fan out across all of them) with no corresponding benefit
until a specific tenant has a real requirement (e.g. contractual data-residency) that shared-schema

- RLS can't satisfy; nothing today indicates that need.

**`SpecRepository` interface, introduced now, implemented twice.** `SpecStore`'s direct
`readFileSync`/`writeFileSync` calls are replaced by a call through a new `SpecRepository`
interface (read/write spec source, read/write layout, list specs in a directory/workspace);
`packages/cli` keeps its existing filesystem-backed implementation (now behind the interface rather
than hardcoded), and `packages/server` adds a new Postgres-backed implementation. This is the
concrete realization of something ADR-0005 already claimed as true but that today, per the code, is
not: "local-mode-specific code is isolated behind an interface the hosted backend implements
differently later." V5 is where that promised seam actually gets built — a small, real piece of
V1-era debt this ADR is naming honestly, not new scope invented for V5's sake.

**Schema sketch** (exact column types/constraints are implementation detail, not an ADR-level
decision):

- `workspaces` (id, name, created_at)
- `workspace_members` (workspace_id, user_id, role — role is a placeholder column V6's RBAC
  (ADR-0017) defines the actual value set for; V5 itself only needs "member of this workspace or
  not")
- `specs` (id, workspace_id, name, yaml_source, version, created_at, updated_at)
- `layouts` (id, workspace_id, spec_id, layout_json)
- `byok_keys` (id, workspace_id, provider, ciphertext, ... — ADR-0016 owns everything about this
  table's cryptography, this ADR only claims it is a normal `workspace_id`-scoped, RLS-protected
  table like any other)
- `runs` (id, workspace_id, spec_id, status, trace_json, started_at, completed_at) — replacing
  `RunManager`'s in-memory `Map`, and finally giving V1's own PLAN.md Shape table's long-standing
  "Local run-history log (SQLite or flat JSON)" placeholder a real, durable, hosted-mode
  implementation.

**Migrations: `drizzle-kit`**, with generated SQL migration files checked into
`packages/server/drizzle/`, applied via a Kubernetes `Job` (or Helm pre-upgrade hook) on deploy —
not a manual, ad hoc process a human runs by hand against production.

**Does ADR-0002 ("YAML is the single lossless source of truth") still hold, server-side,
multi-tenant? Yes, unchanged in spirit.** The `specs.yaml_source` column _is_ the same lossless YAML
text ADR-0002 already mandates — the database replaces the filesystem as YAML's storage medium, it
does not replace YAML as the format or introduce a second, parallel representation of a spec's
content. Canvas mutations still flow through the same `packages/spec` parse/validate/serialize
functions unchanged; only what's on the other end of "write the resulting text somewhere" differs
(a `UPDATE specs SET yaml_source = $1` instead of a `writeFileSync`), which is exactly what the new
`SpecRepository` interface exists to abstract.

## Alternatives considered

| Option                                                                                    | Why not                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prisma instead of Drizzle                                                                 | Heavier codegen-generated client, a separate schema DSL file rather than TypeScript-native schema definitions, and no first-party Better Auth adapter as clean as Drizzle's — more machinery than this project's stack conventions favor for no offsetting benefit here. |
| Schema-per-tenant or database-per-tenant                                                  | Real operational cost (migrations, connection management, and backups all fan out per tenant) with no currently-identified requirement driving the need for that level of isolation; shared-schema + RLS gives strong-enough isolation at far lower operational weight.  |
| Application-layer scoping only, no RLS                                                    | A single forgotten `WHERE workspace_id = ...` clause becomes a cross-tenant data leak — unacceptable risk once real strangers' data and BYOK credentials are involved, per the operator's own "real SaaS" framing.                                                       |
| Keep `RunManager` in-memory-only for V5, add persistence later                            | Defeats the actual point of hosted mode (surviving a process restart, letting a user return to see past runs) — an in-memory-only run store is a regression from what a hosted product needs, not a reasonable first cut.                                                |
| Skip the `SpecRepository` interface, hardcode `packages/server` against Postgres directly | Repeats exactly the gap this ADR calls out — ADR-0005 already promised this seam exists; leaving it unbuilt again means the next slice inherits the same debt instead of it being paid down here.                                                                        |

## Consequences

- `packages/spec`'s validator and serializer are entirely unchanged and reused as-is by
  `packages/server` — direct validation that ADR-0002's module-boundary design ("every other
  package depends on S1, none of them bypass it") holds up under a genuinely new consumer, not just
  the ones it was originally built alongside.
- `packages/cli`'s `SpecStore` needs a real, scoped refactor (implement the new interface rather
  than being filesystem-hardcoded) as part of V5 implementation work — small, but a genuine change
  to existing V1 code, not purely additive.
- RLS policies need their own dedicated test coverage — a new test shape (cross-tenant-isolation
  tests: "workspace A's session cannot read workspace B's rows even via a maliciously-crafted
  query") this repo has not needed before, and should be a required part of V5's slice-level test
  plan (SLICES.md), not an afterthought.
- Every tenant-scoped table added later (by V6 or beyond) must remember to add both the
  `workspace_id` column and its RLS policy — this ADR establishes the pattern but does not
  automatically enforce it; a schema-review checklist item, not a mechanical guarantee.

## Open questions for V5 implementation to revisit

- The exact mechanism for setting the RLS session variable per request (a `SET LOCAL` inside each
  transaction vs. a connection-pool-per-workspace scheme) — a real implementation decision with
  performance implications, not resolved here.
- Whether `runs.trace_json` needs to become a more queryable, structured shape later if V6's audit
  log (ADR-0017) needs to query into run detail rather than treat it as an opaque blob.
