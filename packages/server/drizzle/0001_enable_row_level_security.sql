-- KAN-1225 (ADR-0014): Postgres Row-Level Security for the tenant-scoped
-- tables -- `workspace_members`, `specs`, and `layouts`. `workspaces` itself
-- is deliberately excluded: it has no `workspace_id` column to key a policy
-- on (it *is* the tenant), and scoping which workspaces a user belongs to is
-- a user/auth concern that doesn't exist until Better Auth is wired up
-- (KAN-1226/KAN-1227).
--
-- Hand-authored, not `drizzle-kit generate`d: drizzle-kit's schema diffing
-- can express CREATE TABLE / ALTER TABLE ADD COLUMN etc. from schema.ts,
-- but has no concept of `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY`.
-- This file is registered by hand in drizzle/meta/_journal.json (see that
-- file's entry with tag "0001_enable_row_level_security").
--
-- Why both ENABLE and FORCE: CNPG's default `app` database is owned by the
-- same `app` role that ran every migration (including this one) and that
-- every application query runs as (see src/db/client.ts's own comment on
-- this deployment's connection-string topology). By default, Postgres RLS
-- policies do not apply to a table's owning role, only to non-owner roles
-- -- so `ENABLE ROW LEVEL SECURITY` alone would silently do nothing at all
-- in this specific deployment topology, a trap this migration exists to
-- avoid. `FORCE ROW LEVEL SECURITY` makes the policy apply even to the
-- owning role (a real Postgres superuser, or the table owner acting via
-- `BYPASSRLS`, still bypasses RLS regardless of FORCE -- not a concern
-- here, since this deployment never connects as a superuser and grants no
-- role BYPASSRLS).
--
-- Policy predicate: `workspace_id = NULLIF(current_setting('app.workspace_id',
-- true), '')::uuid`. `current_setting(..., true)` -- the two-argument
-- "missing_ok" form -- returns SQL NULL instead of raising when
-- `app.workspace_id` has *never once* been referenced on this connection at
-- all. But a pooled connection is reused across many transactions over its
-- lifetime, and Postgres has a documented, surprising quirk for custom
-- ("placeholder") GUCs like this one: the *first* time a transaction on a
-- given connection sets `app.workspace_id` via `SET LOCAL`/`set_config(...,
-- true)` (exactly what `withWorkspaceScope`, src/db/workspace-scope.ts,
-- does), Postgres creates a session-level placeholder for it -- and once
-- that placeholder exists, `current_setting(..., true)` never reports NULL
-- again for the rest of that *session* (connection), even after the LOCAL
-- value reverts at COMMIT/ROLLBACK: it reports an *empty string*, not NULL.
-- (Verified directly against a real Postgres 18 while building this
-- migration -- a plain `BEGIN; SELECT set_config('app.workspace_id',
-- '<uuid>', true); COMMIT;` on a connection that had never touched
-- `app.workspace_id` before leaves `current_setting('app.workspace_id',
-- true)` reading `''`, not NULL, for every later transaction on that same
-- connection.) So on a connection that has *ever* been used by
-- `withWorkspaceScope`, a later query that forgets to go through it again
-- (the exact "some code path forgot to scope" failure mode this migration
-- exists to guard against) would otherwise hit `''::uuid`, which *raises*
-- ("invalid input syntax for type uuid") rather than the intended "zero
-- rows, no error" fail-closed behavior -- still safe (no cross-tenant leak
-- either way -- a raised error blocks the query outright), but an
-- inconsistent, connection-history-dependent failure mode for what should
-- be one uniform guarantee. `NULLIF(..., '')` normalizes that empty-string
-- "reverted but not truly unset" case back to real SQL NULL before the
-- `::uuid` cast, so "never set" and "set once, then reverted" behave
-- identically: `workspace_id = NULL::uuid` evaluates to NULL, which
-- Postgres/RLS treats as "this row is not visible" -- zero rows, not a
-- crash, not a leak, and not "every row visible." A caller that explicitly
-- sets `app.workspace_id` to some other non-empty, non-UUID-shaped string
-- still gets a loud `invalid input syntax for type uuid` error at query
-- time (not silently coerced into matching something unintended) -- only
-- the specific empty-string artifact of Postgres's own GUC-placeholder
-- machinery is normalized here, nothing else.
--
-- A single `FOR ALL USING (...) WITH CHECK (...)` policy per table, rather
-- than separate SELECT/INSERT/UPDATE/DELETE policies, since the same
-- predicate governs both here: `USING` restricts which existing rows are
-- visible to SELECT/UPDATE/DELETE, `WITH CHECK` restricts which new/
-- modified row values an INSERT/UPDATE is allowed to write -- both need to
-- agree a row belongs to the session's current workspace.

ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_members_workspace_isolation" ON "workspace_members"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "specs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "specs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "specs_workspace_isolation" ON "specs"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "layouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "layouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "layouts_workspace_isolation" ON "layouts"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
