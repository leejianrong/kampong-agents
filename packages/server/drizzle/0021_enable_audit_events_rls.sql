-- KAM-66: Row-Level Security for `audit_events` (0020). Same session-variable scoping as the other tenant tables
-- (see 0017), but append only: one policy for SELECT and one for INSERT, none for UPDATE or DELETE, and FORCE so the
-- table owner is held to it too. With RLS on and no policy for a command, that command matches no rows, so an
-- UPDATE or DELETE through the application role changes nothing. (Deleting a workspace still cascades: referential
-- actions bypass row security.)
--
-- Hand-authored and registered by hand in drizzle/meta/_journal.json, following the 0007/0009/0013/0017 precedent.

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_select" ON "audit_events"
	AS PERMISSIVE FOR SELECT TO PUBLIC
	USING ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "audit_events_insert" ON "audit_events"
	AS PERMISSIVE FOR INSERT TO PUBLIC
	WITH CHECK ("workspace_id" = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
