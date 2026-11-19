-- KAM-203 (ADR-0056): the hosted scheduler has to find every live deployment on boot, across workspaces. The
-- `deployments` table has FORCE row-level security, so a plain SELECT with no `app.workspace_id` sees nothing,
-- and even a SECURITY DEFINER function owned by the table owner would see nothing (FORCE applies to owners).
-- Instead of widening the isolation surface with a bypass role, this function stays SECURITY INVOKER and does
-- what `withWorkspaceScope` does, one workspace at a time: it sets `app.workspace_id` to each workspace in
-- turn and reads that workspace's live deployments through the normal policy. `workspaces` has no RLS, so
-- listing it is allowed. It returns only ids, never a spec, secret or payload, and it clears the setting before
-- it returns so nothing leaks into the caller's transaction.
--
-- Hand-authored and registered by hand in drizzle/meta/_journal.json (no drizzle snapshot), like 0011/0013.

CREATE OR REPLACE FUNCTION "list_live_deployments"()
RETURNS TABLE ("workspace_id" uuid, "deployment_id" uuid, "spec_id" uuid)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
	ws uuid;
BEGIN
	FOR ws IN SELECT "id" FROM "workspaces" LOOP
		PERFORM set_config('app.workspace_id', ws::text, true);
		RETURN QUERY
			SELECT d."workspace_id", d."id", d."spec_id"
			FROM "deployments" d
			WHERE d."status" = 'live';
	END LOOP;
	PERFORM set_config('app.workspace_id', '', true);
END;
$$;
