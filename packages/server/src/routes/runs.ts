import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { RunEvent } from "@kampong/engine";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { runs, specs } from "../db/schema.js";
import { SpecNotFoundError } from "../db/spec-repository.js";
import {
  describeOutcome,
  parseRunListLimit,
  type PendingApprovalItem,
  type RunListItem,
} from "../run/run-list.js";
import { WorkspaceApiKeyNotConfiguredError } from "../model/resolve.js";
import {
  HostedRunManager,
  InvalidStoredSpecError,
  UnsupportedOnHostedError,
} from "../run/manager.js";

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
  // GET /api/specs/:id/runs?limit= -- this spec's recent runs, newest first (KAM-324): what the Deploy dashboard
  // lists. 404 when the spec is not in the caller's workspace.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/specs/:id/runs",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
      if (!ctx) return reply;
      const specId = request.params.id;
      const limit = parseRunListLimit(request.query.limit);
      const rows = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
        const [spec] = await tx
          .select({ id: specs.id })
          .from(specs)
          .where(and(eq(specs.id, specId), eq(specs.workspaceId, ctx.workspaceId)));
        if (!spec) return undefined;
        return tx
          .select({
            id: runs.id,
            status: runs.status,
            source: runs.source,
            triggeredBy: runs.triggeredBy,
            startedAt: runs.startedAt,
            completedAt: runs.completedAt,
            error: runs.error,
            costUsd: runs.costUsd,
          })
          .from(runs)
          .where(and(eq(runs.specId, specId), eq(runs.workspaceId, ctx.workspaceId)))
          .orderBy(desc(runs.startedAt))
          .limit(limit);
      });
      if (!rows) {
        return reply
          .code(404)
          .send({ success: false, error: `No spec "${specId}" in this workspace.` });
      }
      const items: RunListItem[] = rows.map((r) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        triggeredBy: r.triggeredBy,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        outcome: describeOutcome(r.status, r.error),
        costUsd: r.costUsd === null ? null : Number(r.costUsd),
      }));
      return { success: true, runs: items };
    },
  );

  // GET /api/specs/:id/approvals -- this spec's runs waiting for a person (KAM-324).
  app.get<{ Params: { id: string } }>("/api/specs/:id/approvals", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
    if (!ctx) return reply;
    const specId = request.params.id;
    const rows = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
      const [spec] = await tx
        .select({ id: specs.id })
        .from(specs)
        .where(and(eq(specs.id, specId), eq(specs.workspaceId, ctx.workspaceId)));
      if (!spec) return undefined;
      return tx
        .select({ id: runs.id, startedAt: runs.startedAt })
        .from(runs)
        .where(
          and(
            eq(runs.specId, specId),
            eq(runs.workspaceId, ctx.workspaceId),
            eq(runs.status, "awaiting_approval"),
          ),
        )
        .orderBy(desc(runs.startedAt))
        .limit(50);
    });
    if (!rows) {
      return reply
        .code(404)
        .send({ success: false, error: `No spec "${specId}" in this workspace.` });
    }
    const approvals: PendingApprovalItem[] = [];
    for (const r of rows) {
      const pending = (await manager.get(ctx.workspaceId, r.id))?.pendingApproval;
      approvals.push({
        runId: r.id,
        startedAt: r.startedAt.toISOString(),
        step: pending?.step ?? null,
        reason: pending?.reason ?? null,
      });
    }
    return { success: true, approvals };
  });

  // POST /api/specs/:id/runs -- start a run of this workspace's spec.
  app.post<{ Params: { id: string }; Body: { input?: unknown; vars?: unknown } }>(
    "/api/specs/:id/runs",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply, "run:start");
      if (!ctx) return reply;

      const input = request.body?.input;
      if (typeof input !== "string") {
        return reply
          .code(400)
          .send({ success: false, error: "`input` (a string) is required to start a run." });
      }

      // `vars` is `kampong run --var` for the hosted API: an object of typed values for a 1.1 spec's `vars`.
      // The engine checks the names and types and fails the run visibly, so only the shape is checked here.
      const vars = request.body?.vars;
      if (
        vars !== undefined &&
        (vars === null || typeof vars !== "object" || Array.isArray(vars))
      ) {
        return reply
          .code(400)
          .send({ success: false, error: "`vars` must be an object of var values." });
      }

      try {
        const { id, state } = await manager.start(ctx.workspaceId, request.params.id, input, {
          source: "manual",
          triggeredBy: ctx.userId,
          ...(vars ? { vars: vars as Record<string, unknown> } : {}),
        });
        return reply.code(201).send({ success: true, id, state });
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          return reply
            .code(404)
            .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
        }
        if (err instanceof InvalidStoredSpecError || err instanceof UnsupportedOnHostedError) {
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
    const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
    if (!ctx) return reply;

    const state = await manager.get(ctx.workspaceId, request.params.id);
    if (!state) {
      return reply
        .code(404)
        .send({ success: false, error: `Unknown run id "${request.params.id}".` });
    }
    return { success: true, state };
  });

  // GET /api/runs/:id/trace -- the span tree of a run still resident in the server (ADR-0063); 404 for an
  // unknown, another workspace's or an evicted run, until traces are stored (KAM-257).
  app.get<{ Params: { id: string } }>("/api/runs/:id/trace", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
    if (!ctx) return reply;

    const trace = await manager.getTrace(ctx.workspaceId, request.params.id);
    if (!trace) {
      return reply
        .code(404)
        .send({ success: false, error: `No trace for run "${request.params.id}".` });
    }
    return { success: true, trace };
  });

  // GET /api/runs/:id/events -- Server-Sent Events stream of the run's
  // progress, opening with its current state. If the run has already finished
  // (no live run left), sends that final state once and closes. 404 if the run
  // isn't this workspace's.
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "run:read");
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
      const ctx = await authorizeWorkspace(auth, db, request, reply, "approval:resolve");
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
