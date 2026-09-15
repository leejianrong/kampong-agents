-- KAN-1231 (ADR-0014): Row-Level Security for the `runs` table created in
-- 0008_bitter_chronomancer.sql. Identical in shape to every other tenant
-- table's policy (see 0001_enable_row_level_security.sql for the full
-- reasoning behind FORCE and the NULLIF normalization) -- a single
-- `FOR ALL USING (...) WITH CHECK (...)` policy keyed on the
-- `app.workspace_id` session variable `withWorkspaceScope` sets. A run's
-- trace can carry a workspace's own data, so it is isolated on exactly the
-- same footing as its specs and BYOK keys.
--
-- Hand-authored (drizzle-kit has no concept of CREATE POLICY), registered by
-- hand in drizzle/meta/_journal.json with tag "0009_enable_runs_rls",
-- following the 0001/0004/0005/0007 precedent (RLS migrations carry no
-- drizzle snapshot of their own).

ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "runs_workspace_isolation" ON "runs"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
