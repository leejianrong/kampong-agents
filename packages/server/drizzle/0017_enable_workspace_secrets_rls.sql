-- KAM-81 (ADR-0014/ADR-0016): Row-Level Security for `workspace_secrets`, created in 0016_workspace_secrets.sql.
-- Identical in shape to the policy 0007_enable_byok_keys_rls.sql put on `byok_keys` (see its comment for why FORCE
-- and the NULLIF normalization): one `FOR ALL USING (...) WITH CHECK (...)` policy keyed on the `app.workspace_id`
-- session variable `withWorkspaceScope` sets. The table holds other people's live connector credentials at rest, so
-- it is covered on exactly the same footing as every other tenant table.
--
-- Hand-authored (drizzle-kit has no concept of CREATE POLICY) and registered by hand in drizzle/meta/_journal.json
-- with tag "0017_enable_workspace_secrets_rls", following the 0007/0009/0013 precedent.

ALTER TABLE "workspace_secrets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_secrets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_secrets_workspace_isolation" ON "workspace_secrets"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
