-- KAM-113 (ADR-0028, KAM-203): Row-Level Security for the `state_entries` table created in
-- 0012_state_entries.sql. Identical in shape to every other tenant table's policy (see
-- 0001_enable_row_level_security.sql for the reasoning behind FORCE and the NULLIF normalization): a single
-- `FOR ALL USING (...) WITH CHECK (...)` policy keyed on the `app.workspace_id` session variable
-- `withWorkspaceScope` sets. Dedupe keys and, later, approval records can carry a workspace's own data, so
-- they are isolated on the same footing as its specs, runs and BYOK keys.
--
-- Hand-authored (drizzle-kit has no concept of CREATE POLICY), registered by hand in
-- drizzle/meta/_journal.json with tag "0013_enable_state_entries_rls", following the 0001/0004/0005/0007/
-- 0009/0011 precedent (RLS migrations carry no drizzle snapshot of their own).

ALTER TABLE "state_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "state_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "state_entries_workspace_isolation" ON "state_entries"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
