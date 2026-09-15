# ADR-0019: Authenticated, workspace-scoped request handling

- Status: Accepted
- Date: 2026-09-15
- Deciders: Jian (product owner)

## Context

KAN-1225 (ADR-0014) put `FORCE ROW LEVEL SECURITY` on `specs`, `layouts`, and
`workspace_members`, gated on an `app.workspace_id` session variable that `withWorkspaceScope`
(`packages/server/src/db/workspace-scope.ts`) sets per transaction. KAN-1226 (ADR-0015) wired up
Better Auth: sessions, email+password / GitHub sign-in, and the `organization` plugin mapped onto
`workspaces`/`workspace_members`. Neither card connected the two: `withWorkspaceScope` existed but
was deliberately not wired into any route, and no authenticated tenant-scoped HTTP surface existed
yet.

KAN-1227 (SLICES.md V5, build-plan step 7) is that connection: the hosted, authenticated,
workspace-scoped equivalent of `packages/cli`'s local spec-CRUD routes, against `PgSpecRepository`
+ RLS, reusing `packages/spec`'s validator unchanged. Wiring it forced a few decisions worth
recording, one of them load-bearing for tenant isolation.

## Decision

### 1. Route surface: a per-id collection, not a single implicit spec

`packages/cli` is a one-spec-per-process tool (ADR-0011), so its routes (`GET`/`PUT /api/spec`)
address a single implicit spec. A hosted workspace holds many, so the hosted routes
(`packages/server/src/routes/specs.ts`) are a collection addressed by id:

- `GET /api/specs` — list the workspace's specs (`SpecSummary[]`).
- `POST /api/specs` — create one from `{ name, source }`; the `source` is validated with the same
  `parseSpec` the repository uses, so an invalid spec never reaches storage (422 otherwise).
- `GET /api/specs/:id` — `loadWithLayout` for that spec (404 if absent in this workspace).
- `PUT /api/specs/:id` — `applyPatchAndSave(ops)` (422 on an invalid mutation, 404 if absent).

Error bodies mirror the CLI's `{ success: false, error }` / `{ success: false, errors }` shapes so
the canvas's existing `api.ts` error handling works against either server (canvas wiring itself is
step 8, a later card). The `SpecRepository` interface and `PgSpecRepository` are reused verbatim;
`PgSpecRepository`'s constructor was widened from `DbClient` to a `DbExecutor` (`DbClient` **or** a
transaction handle) so a route can construct it against the per-request `withWorkspaceScope`
transaction — the one change to existing code.

### 2. Per-request flow: resolve-and-authorize, then one scoped transaction

Every tenant-scoped route runs the same shape (`resolveWorkspaceContext`,
`packages/server/src/auth/request-context.ts`):

1. `auth.api.getSession({ headers })` → **401** if there is no valid session.
2. `session.activeOrganizationId` (the `organization` plugin's "active workspace" field on the
   session row) → **403** if null (no workspace selected).
3. **Verify membership** (see below), then run the actual operation inside
   `withWorkspaceScope(db, workspaceId, tx => …)`, so RLS scopes every query.

### 3. Membership is verified in the application layer — RLS does not do it (load-bearing)

The RLS policies on `specs`/`layouts` key **only** on a row's `workspace_id` equalling
`app.workspace_id`. They have no concept of "the current user" — only of the session variable. So
setting `app.workspace_id` straight from the client-controlled `activeOrganizationId` would let a
caller who pointed their session at an arbitrary workspace uuid read and write another tenant's
specs, with RLS allowing it because the ids match.

Therefore `resolveWorkspaceContext` proves membership before scoping any operation: it runs a
`workspace_members` read for the current user **inside** `withWorkspaceScope(candidateWorkspaceId,
…)`, so RLS itself scopes that read to the candidate workspace and the row returns iff `(this user,
this workspace)` is a real membership. No membership → **403**. This is the invariant the next
person adding a tenant-scoped route must preserve: **RLS is the backstop against a query that
forgot to scope; it is not the authorization check that the requester belongs to the workspace.**
Regression coverage is the "forged active workspace" test in
`test/integration/routes/specs.test.ts`, which points one user's session row at another workspace
directly in the database and asserts a 403.

The cost is one extra scoped transaction per request (the membership check, separate from the
operation's own scope). Acceptable for now; folding the two into one transaction is a possible
future optimization, not a correctness issue.

### 4. Workspace creation stays on Better Auth; the 0004/0005 bootstrap pair is NOT retired here

ADR-0018 noted the 0004 bootstrap-insert policy and 0005 `member_count` guard "could be retired"
once per-request scoping landed. They are **not** retired in KAN-1227, deliberately. Those exist
only because Better Auth's `/organization/create` inserts the creator's `workspace_members` row
through an unscoped connection (the same limitation that made ADR-0018's Option B infeasible).
Wiring the spec-CRUD routes does not touch that path — workspace creation still goes through Better
Auth's org-create, which sets `activeOrganizationId` on the session row directly (`session` has no
RLS), so this card relies on it working exactly as KAN-1226 left it. Retiring 0004/0005 requires
**replacing** the creation path with an authenticated route that does the creator-member insert
inside `withWorkspaceScope` — a separate, larger change with its own test rewrites, tracked as
**KAN-1393**, not smuggled into this card.

### 5. The RLS route tests now run in CI, as a non-superuser role

KAN-1227 also closes **KAN-1388**: the CI integration job provisions a `postgres:18` service and a
**non-superuser, non-BYPASSRLS** role (`app_test`) that owns the tables (migrations run as it), so
the RLS/auth integration suites — which `skipIf(!DATABASE_URL)` and had been skipping in CI
entirely — run for real. A superuser silently bypasses `FORCE ROW LEVEL SECURITY`, which would make
every isolation assertion pass vacuously; owning the tables as a non-superuser is what makes the
coverage genuine. The integration test layer is now serialized (`fileParallelism: false`) so the
DB-backed suites don't collide on the shared Postgres — the documented interim fix for
**KAN-1389**, whose proper per-file database isolation stays open.

## Consequences

- The canvas can be pointed at the hosted server for spec CRUD (the payoff of ADR-0005's reusable
  web app), pending the auth-aware client wiring in build-plan step 8.
- Tenant isolation for the spec surface now rests on two layers working together: the app-layer
  membership check (are you allowed into this workspace at all?) and RLS (once scoped, you cannot
  see or touch another workspace's rows). Both are exercised end-to-end in CI as of this card.
- `PgSpecRepository` accepting a transaction handle (`DbExecutor`) is the seam every future
  tenant-scoped route will build on; none should construct it against the bare pool for a
  request-path write.
- The bootstrap-exception surface (0004/0005) remains until KAN-1393; ADR-0018's named residual
  race is likewise still open until then.
