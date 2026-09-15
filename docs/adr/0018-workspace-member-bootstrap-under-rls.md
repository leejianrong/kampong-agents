# ADR-0018: Workspace-member bootstrap under RLS

- Status: Accepted
- Date: 2026-09-15
- Deciders: Jian (product owner)

## Context

KAN-1225 put `FORCE ROW LEVEL SECURITY` on `workspace_members` (ADR-0014): every read and write is
gated on an `app.workspace_id` session variable that `withWorkspaceScope` (src/db/workspace-scope.ts)
sets per transaction. That is the tenant-isolation backstop the whole hosted design leans on — one
workspace can never read or write another's rows.

KAN-1226 wires up Better Auth's `organization` plugin, mapped onto the existing
`workspaces`/`workspace_members` tables. Its `/organization/create` endpoint inserts the
`workspaces` row and then, in the same request, the creator's `workspace_members` row (role
`owner`). That member insert goes through Better Auth's own adapter with no knowledge of this
project's `app.workspace_id` convention, so under KAN-1225's policy alone it fails every time with
`new row violates row-level security policy for table workspace_members` — a workspace can't be
created through Better Auth at all.

We need to let exactly that one bootstrap insert through without loosening isolation for any other
write. Three options were on the table (from the KAN-1226 decision review):

- **Option A — a narrow, additive bootstrap RLS policy.** A second PERMISSIVE policy on
  `workspace_members` that admits an insert only when the row's role is `owner` and the target
  workspace's `member_count` is still `0`, with an `AFTER INSERT` trigger bumping `member_count` to
  close the window the instant the first member lands. Already built and verified (migration
  `0004_workspace_members_bootstrap_insert.sql`).
- **Option B — suppress Better Auth's member insert and do it ourselves through
  `withWorkspaceScope`.** This would keep isolation resting on the single existing mechanism with no
  new RLS surface.
- **Option C — a `SECURITY DEFINER` bootstrap function owned by a `BYPASSRLS` role.**

**Option B is infeasible, verified against better-auth 1.7.3.** Its `createOrganization` handler
calls `adapter.createMember(data)` unconditionally, routed through `context.adapter.create(...)` —
the raw Drizzle adapter, not the hooks-enabled `internalAdapter` — so core
`databaseHooks.member.create.before` never runs; the `organization` plugin's own hooks
(`beforeAddMember`) only let a caller rewrite the row, not skip or redirect it; and there is no
`disableCreatorMembership`/`customCreateMember` option (teams have `customCreateDefaultTeam`,
members have no equivalent). **Option C is not cleanly feasible either:** Better Auth emits a plain
`INSERT`, not a function call, so a definer function can't be slotted into its write path without
wrapping the adapter, and `0004` already documents that `FORCE ROW LEVEL SECURITY` refuses the
`SECURITY DEFINER ... SET row_security = off` escape hatch outright. Option A is the only approach
that works against Better Auth's actual insert path.

Option A's one real weakness, raised in review: its safety rests entirely on `workspaces.member_count`
— a plain integer column on a table with no RLS — never being lowered. Any future
`UPDATE workspaces SET member_count = 0` on an already-populated workspace would reopen its bootstrap
window and let an unscoped `owner` insert into someone else's workspace. Not exploitable today (no
route exposes a workspaces update), but the invariant was enforced by the _absence_ of such code,
not by the schema — a latent landmine for the next card that adds a workspace-update route.

## Decision

**Adopt Option A, hardened with a database-level guard on `member_count` (migration
`0005_guard_member_count_monotonic.sql`).**

1. Keep `0004`'s bootstrap-insert policy and `member_count` counter/trigger unchanged.
2. Add a `BEFORE UPDATE` trigger on `workspaces` that RAISEs whenever `NEW.member_count <
OLD.member_count`. `member_count` becomes monotonic non-decreasing: the legitimate
   `bump_workspace_member_count` increment (`NEW = OLD + 1`) and ordinary edits that leave the
   counter unchanged (`NEW = OLD`) both pass; only an actual decrease — the one motion that could
   reopen a bootstrap window — is rejected, loudly (fail-visibly, ADR-0004).

This converts Option A's "safe by convention" into "safe by mechanism," which is what Option B was
wanted for, achieved at the database layer without needing Better Auth to cooperate. Lowering
`member_count` now requires deliberately dropping or amending the guard, rather than being something
a careless `UPDATE` can do by accident.

## Consequences

- Creating a workspace through Better Auth works today; inviting _additional_ members into an
  existing workspace stays blocked by RLS until KAN-1227 wires `withWorkspaceScope` into every
  authenticated request — a deliberate, temporary limitation, not a silent gap.
- The bootstrap policy plus this guard are a self-contained pair that KAN-1227 can retire together
  once per-request scoping makes the bootstrap exception unnecessary.
- **Residual risk, unchanged from `0004` and named plainly:** the millisecond race between a
  `workspaces` row being inserted (`member_count = 0`) and its first `workspace_members` row landing,
  within one synchronous request handler. A caller who already knew or guessed the freshly generated
  workspace `uuid` could race to insert themselves as `owner`. Mitigated by that `uuid` being
  cryptographically unguessable and the window being a handful of milliseconds; closed for good by
  KAN-1227. This ADR does **not** address that race — it closes the separate,
  indefinite-duration hole of an already-populated workspace being reset to `0` later.
- Regression coverage lives in `packages/server/test/integration/db/auth.test.ts`: an increment and
  an unchanged-count update both succeed, a decrement is rejected, and a real Better-Auth-created
  workspace cannot be reset to `member_count = 0`.
