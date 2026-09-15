import type { FastifyInstance } from "fastify";
import type { RunEvent } from "@kampong/engine";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { SpecNotFoundError } from "../db/spec-repository.js";
import { WorkspaceApiKeyNotConfiguredError } from "../model/resolve.js";
import { HostedRunManager, InvalidStoredSpecError } from "../run/manager.js";

// KAN-1231/KAN-1425 (ADR-0014, SLICES.md V5 build-plan step 11): the
// workspace-scoped, durable hosted-execution routes -- start a run of one of
// the workspace's specs server-side, read its (persisted) state, stream its
// progress over SSE, and resolve a HITL approval. Mirrors packages/cli's
// `/api/runs` surface (packages/cli/src/server.ts) but scoped to the
// authenticated user's workspace and backed by the `runs` table instead of an
// in-memory Map. Every per-run route confirms the run belongs to the request's
// workspace (via HostedRunManager, RLS-gated) before touching the id-keyed
// live-run map.

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

  // GET /api/runs/:id/events -- Server-Sent Events stream of the run's
  // progress, opening with its current state. If the run has already finished
  // (no live run left), sends that final state once and closes. 404 if the run
  // isn't this workspace's.
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return;

    const resolved = await manager.resolveForStream(ctx.workspaceId, request.params.id);
    if (!resolved) {
      return reply
        .code(404)
        .send({ success: false, error: `Unknown run id "${request.params.id}".` });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "state", state: resolved.state })}\n\n`);

    const run = resolved.run;
    if (!run) {
      // Already terminal and evicted -- nothing more will ever be emitted.
      reply.raw.end();
      return;
    }

    const onEvent = (event: RunEvent) => {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "event", event, state: run.getState() })}\n\n`,
      );
    };
    run.on("event", onEvent);
    request.raw.on("close", () => run.off("event", onEvent));
  });

  // POST /api/runs/:id/approve -- resolve a run paused at an approval gate.
  app.post<{ Params: { id: string }; Body: { approved?: unknown; reason?: unknown } }>(
    "/api/runs/:id/approve",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const { approved, reason } = request.body ?? {};
      if (typeof approved !== "boolean") {
        return reply
          .code(400)
          .send({ success: false, error: "`approved` (a boolean) is required." });
      }

      try {
        const state = await manager.approve(
          ctx.workspaceId,
          request.params.id,
          approved,
          typeof reason === "string" ? reason : undefined,
        );
        if (state === undefined) {
          return reply
            .code(404)
            .send({ success: false, error: `Unknown run id "${request.params.id}".` });
        }
        return { success: true, state };
      } catch (err) {
        // resume() throws when the run isn't awaiting approval (or is no longer
        // live) -- a conflict with the run's current state, not a 500.
        return reply.code(409).send({ success: false, error: (err as Error).message });
      }
    },
  );
}
