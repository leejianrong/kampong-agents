import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { InvalidWorkspaceIdError, withWorkspaceScope } from "../db/workspace-scope.js";
import { deployments, specs } from "../db/schema.js";
import { SpecNotFoundError } from "../db/spec-repository.js";
import { WorkspaceApiKeyNotConfiguredError } from "../model/resolve.js";
import { HostedRunManager, InvalidStoredSpecError } from "../run/manager.js";

// KAN-1436 (ADR-0022, ADR-0023): the managed "go live" core. Two distinct
// surfaces, deliberately kept in one file since they share the `deployments`
// table:
//
// 1. An authenticated, workspace-scoped lifecycle API (deploy/pause/redeploy,
//    mirroring the byok/spec routes' `authorizeWorkspace` + `withWorkspaceScope`
//    shape) -- the foundation KAN-1438's canvas Deploy button/dashboard will
//    call. At most one deployment per spec (schema.ts's unique constraint),
//    so "deploy" is idempotent: calling it again on an already-deployed spec
//    just reactivates the same row and the same webhook URL.
// 2. A PUBLIC webhook-ingress route with no session/auth at all -- an
//    external caller (Slack, a real app, curl) has no Better Auth cookie, so
//    it cannot go through `authorizeWorkspace`. Its only "credential" is
//    knowing both the workspaceId and deploymentId path segments -- two
//    `defaultRandom()` uuids, matching the capability-URL pattern this
//    project already accepts for spec/run ids. `withWorkspaceScope` still
//    gates the actual row read through RLS, so a guessed/wrong pair is
//    rejected by the database, not just an application `if`.

export interface DeploymentRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
  manager: HostedRunManager;
}

export function registerDeploymentRoutes(
  app: FastifyInstance,
  { db, auth, manager }: DeploymentRoutesDeps,
): void {
  // PUT /api/specs/:id/deployment -- deploy (or redeploy) this workspace's
  // spec. Upserts on the spec's unique deployment slot, always setting status
  // back to "live" -- covers both "deploy for the first time" and "redeploy
  // after a pause" with one route.
  app.put<{ Params: { id: string } }>("/api/specs/:id/deployment", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const specId = request.params.id;
    try {
      const [row] = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
        const [spec] = await tx
          .select({ id: specs.id })
          .from(specs)
          .where(and(eq(specs.id, specId), eq(specs.workspaceId, ctx.workspaceId)));
        if (!spec) throw new SpecNotFoundError(specId, ctx.workspaceId);

        return tx
          .insert(deployments)
          .values({ workspaceId: ctx.workspaceId, specId })
          .onConflictDoUpdate({
            target: deployments.specId,
            set: { status: "live", updatedAt: new Date() },
          })
          .returning({ id: deployments.id, status: deployments.status });
      });
      return reply.code(200).send({
        success: true,
        deploymentId: row!.id,
        status: row!.status,
        webhookPath: `/hooks/w/${ctx.workspaceId}/${row!.id}`,
      });
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        return reply
          .code(404)
          .send({ success: false, error: `No spec "${specId}" in this workspace.` });
      }
      throw err;
    }
  });

  // GET /api/specs/:id/deployment -- this workspace's deployment for a spec,
  // if any. 404 (not an empty 200) when never deployed, matching the
  // spec/byok-key "no such row" convention elsewhere in this API.
  app.get<{ Params: { id: string } }>("/api/specs/:id/deployment", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const specId = request.params.id;
    const [row] = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .select({ id: deployments.id, status: deployments.status })
        .from(deployments)
        .where(and(eq(deployments.specId, specId), eq(deployments.workspaceId, ctx.workspaceId))),
    );
    if (!row) {
      return reply
        .code(404)
        .send({ success: false, error: `Spec "${specId}" has never been deployed.` });
    }
    return {
      success: true,
      deploymentId: row.id,
      status: row.status,
      webhookPath: `/hooks/w/${ctx.workspaceId}/${row.id}`,
    };
  });

  // PATCH /api/specs/:id/deployment -- pause or resume. `status: "live"` is
  // equivalent to PUT (redeploy); this route exists so a pause doesn't need
  // to re-send a full deploy, and so the intent ("pause" vs "deploy") is
  // explicit in the request rather than inferred.
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>(
    "/api/specs/:id/deployment",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const status = request.body?.status;
      if (status !== "live" && status !== "paused") {
        return reply
          .code(400)
          .send({ success: false, error: '`status` must be "live" or "paused".' });
      }

      const specId = request.params.id;
      const [row] = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
        tx
          .update(deployments)
          .set({ status, updatedAt: new Date() })
          .where(and(eq(deployments.specId, specId), eq(deployments.workspaceId, ctx.workspaceId)))
          .returning({ id: deployments.id, status: deployments.status }),
      );
      if (!row) {
        return reply
          .code(404)
          .send({ success: false, error: `Spec "${specId}" has never been deployed.` });
      }
      return { success: true, deploymentId: row.id, status: row.status };
    },
  );

  // DELETE /api/specs/:id/deployment -- tear down entirely (a new deploy
  // afterward gets a fresh deploymentId, so any leaked webhook URL stops
  // working for good, not just until the next redeploy).
  app.delete<{ Params: { id: string } }>("/api/specs/:id/deployment", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const specId = request.params.id;
    const deleted = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .delete(deployments)
        .where(and(eq(deployments.specId, specId), eq(deployments.workspaceId, ctx.workspaceId)))
        .returning({ id: deployments.id }),
    );
    if (deleted.length === 0) {
      return reply
        .code(404)
        .send({ success: false, error: `Spec "${specId}" has never been deployed.` });
    }
    return { success: true };
  });

  // POST /hooks/w/:workspaceId/:deploymentId -- the trigger. No session, no
  // `authorizeWorkspace`: the two path segments ARE the credential. Body
  // becomes the run input (raw string, or the JSON text of a JSON body,
  // matching `kampong serve`'s own /webhook route in packages/cli).
  app.post<{ Params: { workspaceId: string; deploymentId: string } }>(
    "/hooks/w/:workspaceId/:deploymentId",
    async (request, reply) => {
      const { workspaceId, deploymentId } = request.params;

      let row: { specId: string; status: string } | undefined;
      try {
        [row] = await withWorkspaceScope(db, workspaceId, (tx) =>
          tx
            .select({ specId: deployments.specId, status: deployments.status })
            .from(deployments)
            .where(and(eq(deployments.id, deploymentId), eq(deployments.workspaceId, workspaceId))),
        );
      } catch (err) {
        if (err instanceof InvalidWorkspaceIdError) row = undefined;
        else throw err;
      }

      // Deliberately the same 404 for "no such deployment," "wrong
      // workspace," and "paused" -- an outside caller can't distinguish a
      // paused deployment from one that never existed, exactly like RLS
      // already makes another workspace's row indistinguishable from a
      // nonexistent one (see runs.ts's own comment on this pattern).
      if (!row || row.status !== "live") {
        return reply.code(404).send({ success: false, error: "Unknown or inactive webhook." });
      }

      const input =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? "");

      try {
        const { id, state } = await manager.start(workspaceId, row.specId, input);
        return reply.code(201).send({ success: true, id, state });
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          // The spec was deleted after being deployed (deployments.specId's
          // FK would have cascade-deleted this row too, so this is only
          // reachable via a genuine race) -- not this caller's fault to see.
          return reply.code(404).send({ success: false, error: "Unknown or inactive webhook." });
        }
        if (
          err instanceof InvalidStoredSpecError ||
          err instanceof WorkspaceApiKeyNotConfiguredError
        ) {
          // A real misconfiguration on the deploying workspace's side (a spec
          // that no longer parses, or a model key that was removed after
          // deploy) -- surfaced as a 422 rather than a 404, since the webhook
          // itself was found and identified correctly.
          return reply.code(422).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );
}
