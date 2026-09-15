import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { SpecNotFoundError } from "../db/spec-repository.js";
import { WorkspaceApiKeyNotConfiguredError } from "../model/resolve.js";
import { HostedRunManager, InvalidStoredSpecError } from "../run/manager.js";

// KAN-1231 (ADR-0014, SLICES.md V5 build-plan step 11): the workspace-scoped,
// durable hosted-execution routes -- start a run of one of the workspace's
// specs server-side, and read its (persisted) state back. Mirrors
// packages/cli's `/api/runs` surface (packages/cli/src/server.ts) but scoped
// to the authenticated user's workspace and backed by the `runs` table
// instead of an in-memory Map. The SSE run-progress stream and the HITL
// approval route are wired in a follow-up; this slice is the durable
// start/read half.

export interface RunRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
  manager: HostedRunManager;
}

export function registerRunRoutes(
  app: FastifyInstance,
  { db, auth, manager }: RunRoutesDeps,
): void {
  // POST /api/specs/:id/runs -- start a run of this workspace's spec.
  app.post<{ Params: { id: string }; Body: { input?: unknown } }>(
    "/api/specs/:id/runs",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const input = request.body?.input;
      if (typeof input !== "string") {
        return reply
          .code(400)
          .send({ success: false, error: "`input` (a string) is required to start a run." });
      }

      try {
        const { id, state } = await manager.start(ctx.workspaceId, request.params.id, input);
        return reply.code(201).send({ success: true, id, state });
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          return reply
            .code(404)
            .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
        }
        if (err instanceof InvalidStoredSpecError) {
          return reply.code(422).send({ success: false, error: err.message });
        }
        if (err instanceof WorkspaceApiKeyNotConfiguredError) {
          // Mirrors the CLI's own 400 for a missing/unconfigured model key --
          // a specific, actionable failure, never a generic 500. The message
          // names only the provider, never any key material.
          return reply.code(400).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // GET /api/runs/:id -- the run's current state (live if resident, otherwise
  // its persisted snapshot). 404 if no such run in this workspace -- RLS makes
  // another workspace's run indistinguishable from a nonexistent one.
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const state = await manager.get(ctx.workspaceId, request.params.id);
    if (!state) {
      return reply
        .code(404)
        .send({ success: false, error: `Unknown run id "${request.params.id}".` });
    }
    return { success: true, state };
  });
}
