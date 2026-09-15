-- KAN-1226 (ADR-0015): a narrow, additive SECOND policy on
-- "workspace_members" plus the trigger/function that back it. Does NOT
-- edit KAN-1225's own 0001_enable_row_level_security.sql migration or its
-- existing "workspace_members_workspace_isolation" policy in any way.
-- Hand-authored, like 0001, since drizzle-kit's schema diffing has no
-- concept of CREATE POLICY/CREATE TRIGGER/CREATE FUNCTION. Registered by
-- hand in drizzle/meta/_journal.json (tag
-- "0004_workspace_members_bootstrap_insert").
--
-- Why this exists: verified empirically while building this card (see
-- test/integration/db/auth.test.ts) that, under KAN-1225's existing FORCE
-- ROW LEVEL SECURITY + single WITH CHECK policy alone, Better Auth's own
-- `organization` plugin cannot create a workspace at all. Its
-- `/organization/create` endpoint inserts the `workspaces` row (unprotected
-- by RLS -- ADR-0014: "workspaces itself has no workspace_id column"),
-- then, still in the same request, a `workspace_members` row for the
-- creator (role "owner") via a plain, non-transaction-wrapped Drizzle
-- insert with no knowledge of this project's `app.workspace_id`
-- session-variable convention at all (that convention is
-- `withWorkspaceScope`'s, src/db/workspace-scope.ts -- wiring it per
-- request, for every route, is explicitly KAN-1227's job, not this
-- card's, and Better Auth's own plugin hook surface -- `organizationHooks.
-- beforeAddMember`, etc. -- only lets a caller rewrite the row being
-- inserted, not redirect the write through a different, transaction-scoped
-- connection). Concretely: this INSERT fails with "new row violates
-- row-level security policy for table workspace_members" every time, with
-- the schema and RLS as KAN-1225 left them -- a workspace could never be
-- created through Better Auth's own API at all otherwise, contradicting
-- this card's own required verification step and SLICES.md's V5 demo
-- bullet ("create a workspace").
--
-- Design, and the two simpler designs tried and rejected first (both
-- verified empirically, not just reasoned about):
--
--   1. An INSERT-only policy checking
--      "NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id =
--      ...)" -- i.e. querying workspace_members itself to ask "is this the
--      first member row for this workspace?". This let the INSERT through,
--      but Better Auth's insert uses `.returning()` (confirmed in the
--      failing query's own SQL text), and Postgres re-checks a table's
--      SELECT-permissive policies against the just-inserted row to decide
--      what RETURNING is allowed to show -- with no SELECT-granting policy
--      applicable, that re-check itself fails with the exact same
--      "violates row-level security policy" error, RETURNING or not.
--   2. Making that same policy `FOR ALL` (so it also grants the SELECT
--      RETURNING needs) hits a different, harder failure:
--      "infinite recursion detected in policy for relation
--      workspace_members" -- the policy's own subquery, run to decide
--      whether *this* table's rows are visible, is itself subject to
--      *this table's own RLS*, including this same policy, recursively.
--      The standard fix for that (a `SECURITY DEFINER` helper function
--      with `SET row_security = off`, so the internal check bypasses RLS)
--      was tried too and Postgres itself refuses it outright under FORCE:
--      "ERROR: query would be affected by row-level security policy for
--      table workspace_members / HINT: To disable the policy for the
--      table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY." --
--      i.e. FORCE is specifically designed so nothing short of dropping
--      FORCE itself (out of scope -- KAN-1225's whole point) or granting
--      BYPASSRLS (out of scope -- this card's own verification setup
--      deliberately uses a non-BYPASSRLS role) can create that kind of
--      owner-side escape hatch.
--
-- This migration's actual design breaks that recursion by never having
-- the policy query `workspace_members` at all: `workspaces.member_count`
-- (0003_hesitant_captain_universe.sql -- a plain integer column, `schema.
-- ts`) tracks how many member rows each workspace has, maintained by an
-- AFTER INSERT trigger on `workspace_members` below. `workspaces` itself
-- has no RLS whatsoever, so a policy predicate that only ever queries
-- `workspaces` cannot recurse into `workspace_members`'s own policies.
--
-- The resulting policy is deliberately narrow -- it does NOT generally
-- loosen workspace_members' isolation guarantee. It permits an INSERT (and
-- the RETURNING-time re-check of that same row) only when BOTH:
--   (a) the new row's role is exactly "owner" (Better Auth's own
--       `organization` plugin default `creatorRole` -- the only role this
--       bootstrap path is ever supposed to produce), AND
--   (b) the target workspace's `member_count` is still exactly 0.
-- The very row this policy allows in is, itself, what the AFTER INSERT
-- trigger below increments `member_count` for -- closing the bootstrap
-- window for that workspace permanently the moment its first member
-- lands. Every subsequent write against workspace_members (adding a
-- second member, an invite-accept, anything else) still requires
-- `app.workspace_id` to be set correctly via
-- `withWorkspaceScope`/KAN-1227's future per-request middleware, exactly
-- as KAN-1225's original policy already enforces -- verified directly
-- (test/integration/db/auth.test.ts): once a workspace has one member, a
-- second, unscoped insert into it is rejected exactly as before this
-- migration existed. In practice this means: creating a brand-new
-- workspace through Better Auth works today; inviting *additional*
-- members into an existing workspace remains blocked by RLS until
-- KAN-1227 lands (a real, deliberate, temporary limitation -- flagged in
-- this card's own report, not silently left broken).
--
-- Residual risk, named plainly rather than glossed over: between a
-- workspace's `workspaces` row being inserted (`member_count` starts at
-- 0) and its first `workspace_members` row landing (milliseconds, within
-- one synchronous request handler), a caller who somehow already knows or
-- guesses that workspace's freshly-generated `uuid` could race to insert
-- themselves as its "owner" member instead of the legitimate creator --
-- mitigated by that `uuid` being cryptographically unguessable and the
-- window being a handful of milliseconds. This is the accepted cost of
-- this narrow bootstrap-only exception; closing it fully requires the
-- per-request workspace-scoping mechanism KAN-1227 introduces, at which
-- point this bootstrap policy/trigger pair could plausibly be retired --
-- left as a note for that card, not solved here.
--
-- Multiple PERMISSIVE policies on the same table are OR'd together by
-- Postgres (a row is allowed if it satisfies *any* PERMISSIVE policy) --
-- this is additive to, never a replacement for, KAN-1225's own policy.

CREATE OR REPLACE FUNCTION "bump_workspace_member_count"() RETURNS trigger
	LANGUAGE plpgsql
	AS $$
BEGIN
	UPDATE "workspaces" SET "member_count" = "member_count" + 1 WHERE "id" = NEW."workspace_id";
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "workspace_members_bump_member_count"
	AFTER INSERT ON "workspace_members"
	FOR EACH ROW EXECUTE FUNCTION "bump_workspace_member_count"();
--> statement-breakpoint
CREATE POLICY "workspace_members_bootstrap_insert" ON "workspace_members"
	AS PERMISSIVE FOR ALL TO PUBLIC
	USING (
		"role" = 'owner'
		AND EXISTS (
			SELECT 1 FROM "workspaces" w
			WHERE w."id" = "workspace_members"."workspace_id" AND w."member_count" = 0
		)
	)
	WITH CHECK (
		"role" = 'owner'
		AND EXISTS (
			SELECT 1 FROM "workspaces" w
			WHERE w."id" = "workspace_members"."workspace_id" AND w."member_count" = 0
		)
	);
