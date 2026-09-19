-- KAN-1436 (ADR-0014, ADR-0022): Row-Level Security for the `deployments`
-- table created in 0010_melodic_hellfire_club.sql. Identical in shape to
-- every other tenant table's policy (see 0001_enable_row_level_security.sql
-- for the full reasoning behind FORCE and the NULLIF normalization) -- a
-- single `FOR ALL USING (...) WITH CHECK (...)` policy keyed on the
-- `app.workspace_id` session variable `withWorkspaceScope` sets. The public
-- webhook-ingress route (routes/deployments.ts) sets this to the workspace id
-- taken from the URL path before reading the row, so a mistyped/foreign
-- workspaceId+deploymentId pair is rejected by RLS itself, not just by an
-- application-layer WHERE clause.
--
-- Hand-authored (drizzle-kit has no concept of CREATE POLICY), registered by
-- hand in drizzle/meta/_journal.json with tag "0011_enable_deployments_rls",
-- following the 0001/0004/0005/0007/0009 precedent (RLS migrations carry no
-- drizzle snapshot of their own).

ALTER TABLE "deployments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deployments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "deployments_workspace_isolation" ON "deployments"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
