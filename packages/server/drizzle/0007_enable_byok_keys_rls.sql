-- KAN-1229 (ADR-0014/ADR-0016): Row-Level Security for the `byok_keys` table
-- created in 0006_legal_thunderbolt.sql. Identical in shape to the policies
-- 0001_enable_row_level_security.sql put on `specs`/`layouts`/
-- `workspace_members` -- a single `FOR ALL USING (...) WITH CHECK (...)`
-- policy keyed on the same `app.workspace_id` session variable
-- `withWorkspaceScope` sets, with the same `NULLIF(current_setting(...), '')`
-- normalization (see 0001's own comment for the full reasoning behind both
-- the `FORCE` and the `NULLIF`). `byok_keys` holds other people's live
-- provider credentials at rest, so failing to force RLS on it would be the
-- single worst tenant-isolation gap in the schema -- this migration exists so
-- it is covered on exactly the same footing as every other tenant table.
--
-- Hand-authored, not `drizzle-kit generate`d (drizzle-kit has no concept of
-- CREATE POLICY), and registered by hand in drizzle/meta/_journal.json with
-- tag "0007_enable_byok_keys_rls" -- following the 0001/0004/0005 precedent
-- (those RLS/trigger migrations likewise have no drizzle snapshot of their
-- own; the drizzle-kit snapshot chain runs through the table-DDL migrations
-- only).

ALTER TABLE "byok_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "byok_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "byok_keys_workspace_isolation" ON "byok_keys"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
