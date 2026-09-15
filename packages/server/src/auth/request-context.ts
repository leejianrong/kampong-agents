import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthInstance } from "./config.js";
import type { DbClient } from "../db/client.js";
import { InvalidWorkspaceIdError, withWorkspaceScope } from "../db/workspace-scope.js";
import { workspaceMembers } from "../db/schema.js";

// KAN-1227 (ADR-0014/ADR-0015, ADR-0019): resolves the authenticated user
// and the workspace an incoming request is scoped to, for every
// tenant-scoped route (the spec-CRUD routes in ../routes/specs.ts today).
// This is the per-request half of the tenancy design KAN-1225 built the
// database half of: `withWorkspaceScope` sets `app.workspace_id` so RLS can
// enforce isolation, and THIS module decides which workspace id a given
// request is allowed to set it to.
//
// The load-bearing subtlety (ADR-0019, and why membership is verified here
// rather than left to RLS): the RLS policies on `specs`/`layouts`
// (drizzle/0001_enable_row_level_security.sql) key ONLY on a row's
// `workspace_id` equalling `app.workspace_id`. They do NOT themselves check
// that the requesting user is a member of that workspace -- RLS has no
// concept of "the current user," only of the session variable. So if we set
// `app.workspace_id` straight from whatever workspace the client claims is
// active, a caller who pointed `session.activeOrganizationId` at an
// arbitrary workspace uuid would read and write another tenant's specs, with
// RLS happily allowing it (the ids match). Membership must be proven in the
// application layer, before scoping, which is what `resolveWorkspaceContext`
// does below.

export type WorkspaceContext =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Resolves the `{ userId, workspaceId }` an authenticated, workspace-scoped
 * request runs as, or a typed failure the caller turns into an HTTP error:
 *
 * - `401` when there is no valid session at all (Better Auth's own
 *   `getSession` returns `null` for a missing/expired/invalid cookie).
 * - `403` when there is a session but no active workspace on it, or the user
 *   is not actually a member of the active workspace.
 *
 * Membership is checked INSIDE `withWorkspaceScope`, so RLS itself scopes the
 * `workspace_members` read to the candidate workspace: the row comes back iff
 * `(this user, this workspace)` is a real membership. See the file-level
 * comment for why this application-layer check is required and not redundant
 * with RLS.
 */
export async function resolveWorkspaceContext(
  auth: AuthInstance,
  db: DbClient,
  request: FastifyRequest,
): Promise<WorkspaceContext> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    return { ok: false, status: 401, error: "Authentication required." };
  }

  // `activeOrganizationId` is the `organization` plugin's "which workspace is
  // this browser session currently acting in" field on the session row
  // (schema.ts's `session.activeOrganizationId`), set by Better Auth's own
  // organization create / set-active endpoints. Null until the user has
  // created or selected a workspace.
  const workspaceId = session.session.activeOrganizationId;
  if (!workspaceId) {
    return {
      ok: false,
      status: 403,
      error: "No active workspace. Create or select a workspace before making this request.",
    };
  }

  let isMember: boolean;
  try {
    isMember = await withWorkspaceScope(db, workspaceId, async (tx) => {
      const rows = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, session.user.id));
      return rows.length > 0;
    });
  } catch (err) {
    // A non-UUID `activeOrganizationId` can only mean a tampered/corrupt
    // session value -- treat it as "no valid workspace" (403), not a 500.
    if (err instanceof InvalidWorkspaceIdError) {
      return { ok: false, status: 403, error: "Active workspace is not a valid workspace id." };
    }
    throw err;
  }

  if (!isMember) {
    return { ok: false, status: 403, error: "You are not a member of the active workspace." };
  }

  return { ok: true, userId: session.user.id, workspaceId };
}

/**
 * The one-line gate every authenticated, workspace-scoped route opens with:
 * resolve + authorize the request's workspace, or send the typed 401/403 body
 * and return `undefined` so the caller bails. Shared by the spec, BYOK, and
 * run routes so the auth-gate shape stays in exactly one place.
 */
export async function authorizeWorkspace(
  auth: AuthInstance,
  db: DbClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Extract<WorkspaceContext, { ok: true }> | undefined> {
  const ctx = await resolveWorkspaceContext(auth, db, request);
  if (!ctx.ok) {
    void reply.code(ctx.status).send({ success: false, error: ctx.error });
    return undefined;
  }
  return ctx;
}
