-- KAN-1226 (ADR-0018): a BEFORE UPDATE trigger on "workspaces" that makes
-- "member_count" monotonic non-decreasing -- it may stay equal or increase,
-- but an UPDATE that lowers it RAISEs and is rejected. Hand-authored, like
-- 0001/0004, since drizzle-kit's schema diffing has no concept of
-- CREATE TRIGGER/CREATE FUNCTION. Registered by hand in
-- drizzle/meta/_journal.json (tag "0005_guard_member_count_monotonic").
--
-- Why this exists: 0004's bootstrap-insert policy on "workspace_members" is
-- what lets Better Auth's `organization` plugin create a workspace's first
-- ("owner") member row under KAN-1225's FORCE ROW LEVEL SECURITY at all
-- (see 0004's own comment for the full story and the two rejected
-- alternatives). That policy admits the insert ONLY while the target
-- workspace's "member_count" is still exactly 0, and the AFTER INSERT
-- `bump_workspace_member_count` trigger (0004) increments the counter to 1
-- the instant that first member lands -- closing the bootstrap window for
-- that workspace permanently.
--
-- The safety of that whole scheme therefore rests on a single invariant:
-- once a workspace's "member_count" has left 0, nothing ever puts it back.
-- Before this migration, that invariant was enforced only by convention --
-- "member_count" is a plain integer column on "workspaces", which has no
-- RLS at all (ADR-0014: it *is* the tenant, it has no workspace_id to key a
-- policy on), so ANY code path that issued
-- `UPDATE workspaces SET member_count = 0 WHERE id = <a populated ws>`
-- would silently REOPEN that workspace's bootstrap window, and the 0004
-- policy would once again admit an unscoped `INSERT ... role = 'owner'`
-- into *someone else's* already-populated workspace. Not exploitable today
-- (no route exposes a workspaces UPDATE yet), but "nothing ever lowers
-- member_count" was guarded by the *absence* of such code, not by the
-- schema -- a latent landmine for whoever builds the first workspace-
-- settings/update route (KAN-1227+). This migration converts that
-- convention into a database-enforced mechanism.
--
-- Design: a BEFORE UPDATE FOR EACH ROW trigger that RAISEs whenever
-- NEW.member_count < OLD.member_count. Deliberately non-decreasing (>=),
-- not "increment-by-one-only": the legitimate writer is 0004's
-- `bump_workspace_member_count` (NEW = OLD + 1), which this permits, and an
-- ordinary UPDATE that touches only other columns (name/slug/metadata --
-- e.g. Better Auth's own `updateOrganization`) leaves member_count
-- unchanged (NEW = OLD), which this also permits. Only an actual decrease
-- -- the one motion that could reopen a bootstrap window -- is rejected.
-- A future, deliberate decrement (e.g. a real "remove member" flow that
-- KAN-1227+ might add) would need to drop or amend this guard on purpose,
-- which is exactly the point: lowering member_count becomes a decision
-- someone has to make explicitly at the schema level, not an accident a
-- careless UPDATE can cause.
--
-- Note on ownership/FORCE: unlike "workspace_members", "workspaces" has no
-- RLS, so there is no owner-bypass subtlety here -- a plain BEFORE UPDATE
-- trigger fires for every role on every UPDATE to the table, including the
-- `app` role every application query runs as. RAISE is the fail-visibly
-- choice (ADR-0004): a rejected decrement surfaces as a loud error, never a
-- silently-ignored no-op.
--
-- This does NOT close the residual bootstrap race 0004 already named (the
-- millisecond window between a workspaces row being inserted with
-- member_count = 0 and its first member landing); that is mitigated by the
-- workspace uuid being cryptographically unguessable and is retired for
-- good once KAN-1227's per-request `withWorkspaceScope` middleware makes
-- the bootstrap policy unnecessary. What this migration closes is the
-- separate, indefinite-duration hole of an *already-populated* workspace
-- being reset to 0 later. See ADR-0018.

CREATE OR REPLACE FUNCTION "guard_workspace_member_count_monotonic"() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	IF NEW."member_count" < OLD."member_count" THEN
		RAISE EXCEPTION
			'workspaces.member_count may only increase; refusing to lower it from % to % for workspace %',
			OLD."member_count", NEW."member_count", OLD."id"
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspaces_member_count_monotonic"
	BEFORE UPDATE ON "workspaces"
	FOR EACH ROW EXECUTE FUNCTION "guard_workspace_member_count_monotonic"();
