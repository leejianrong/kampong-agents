import type { FastifyInstance } from "fastify";
import { loadWithLayout, parseSpec, pinNodePositions, type SpecOp } from "@kampong/spec";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { PgSpecRepository, SpecNotFoundError } from "../db/spec-repository.js";

// KAN-1227 (ADR-0014/ADR-0015, SLICES.md V5 build-plan step 7): the
// authenticated, workspace-scoped hosted equivalent of packages/cli's
// spec-CRUD routes (packages/cli/src/server.ts's `/api/spec`). The CLI is a
// one-spec-per-process tool (ADR-0011), so its routes address a single
// implicit spec; a hosted workspace holds many, so these are addressed by id
// (`/api/specs/:id`) with a `list`/`create` pair on the collection.
//
// Every route runs the same shape: `resolveWorkspaceContext` (401/403) to
// find and authorize the request's workspace, then ONE `withWorkspaceScope`
// transaction so `PgSpecRepository`'s queries run under `app.workspace_id`
// and Postgres RLS enforces tenant isolation for free -- the validator
// (`@kampong/spec`) and repository are reused entirely unchanged. Error
// bodies mirror the CLI's own `{ success: false, error }` / `{ success:
// false, errors }` shapes so the canvas's existing `api.ts` error handling
// (apps/canvas/src/api.ts) works against either server.

export interface SpecRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
}

export function registerSpecRoutes(app: FastifyInstance, { db, auth }: SpecRoutesDeps): void {
  app.get("/api/specs", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const specs = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      // `list()` is workspace-wide and ignores the per-spec id the repository
      // is otherwise scoped to (see SpecRepository.list()'s docstring in
      // @kampong/spec), so the placeholder id here is never read. RLS scopes
      // the underlying query to `ctx.workspaceId`.
      new PgSpecRepository(tx, ctx.workspaceId, "").list(),
    );
    return { success: true, specs };
  });

  app.post<{ Body: { name?: unknown; source?: unknown } }>("/api/specs", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const { name, source } = request.body ?? {};
    if (typeof name !== "string" || name.length === 0) {
      return reply.code(400).send({ success: false, error: "A non-empty `name` is required." });
    }
    if (typeof source !== "string") {
      return reply.code(400).send({
        success: false,
        error: "A `source` (the initial AgentSpec YAML) is required to create a spec.",
      });
    }

    // Validate before persisting -- an invalid spec never reaches storage,
    // the same guarantee applyPatchAndSave gives on mutation (PLAN.md S1).
    const parsed = parseSpec(source);
    if (!parsed.success) {
      return reply.code(422).send({ success: false, errors: parsed.errors });
    }

    const id = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
      const repo = await PgSpecRepository.create(tx, ctx.workspaceId, name, source);
      return repo.id;
    });
    return reply.code(201).send({ success: true, id, name });
  });

  app.get<{ Params: { id: string } }>("/api/specs/:id", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    try {
      return await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
        const repo = new PgSpecRepository(tx, ctx.workspaceId, request.params.id);
        // Read first: a version older than the text is the safe direction for a stale guard.
        const revision = await repo.readRevision();
        return { ...(await loadWithLayout(repo)), revision };
      });
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        return reply
          .code(404)
          .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
      }
      throw err;
    }
  });

  // KAM-186 (ADR-0061): a dragged node is pinned in the `layouts` row, through the same `pinNodePositions` that
  // `kampong dev`'s `PUT /api/layout` runs over `.kampong/layout.json`.
  app.put<{ Params: { id: string }; Body: { positions?: unknown } }>(
    "/api/specs/:id/layout",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const positions = request.body?.positions;
      if (typeof positions !== "object" || positions === null || Array.isArray(positions)) {
        return reply
          .code(400)
          .send({ success: false, error: "Request body must include a `positions` object." });
      }

      try {
        const result = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
          pinNodePositions(
            new PgSpecRepository(tx, ctx.workspaceId, request.params.id),
            positions as Record<string, { x: number; y: number } | null>,
          ),
        );
        return reply.code(result.success ? 200 : 422).send(result);
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          return reply
            .code(404)
            .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { ops?: SpecOp[]; baseRevision?: string } }>(
    "/api/specs/:id",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const ops = request.body?.ops;
      if (!Array.isArray(ops)) {
        return reply
          .code(400)
          .send({ success: false, error: "Request body must include an `ops` array." });
      }

      try {
        const result = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
          new PgSpecRepository(tx, ctx.workspaceId, request.params.id).applyOpsAndSave(ops, {
            baseRevision: request.body?.baseRevision,
          }),
        );
        if (!result.success) {
          return reply
            .code(result.stale ? 409 : 422)
            .send({ success: false, errors: result.errors, revision: result.revision });
        }
        return {
          success: true,
          spec: result.spec,
          revision: result.revision,
          changes: result.changes,
        };
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          return reply
            .code(404)
            .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
        }
        throw err;
      }
    },
  );

  // KAM-207 (ADR-0054): import. Replaces the stored text with the text given if it validates; an invalid
  // text is a 422 with line-numbered errors and nothing is written.
  app.put<{ Params: { id: string }; Body: { source?: unknown; baseRevision?: string } }>(
    "/api/specs/:id/source",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const source = request.body?.source;
      if (typeof source !== "string") {
        return reply
          .code(400)
          .send({ success: false, error: "Request body must include a `source` string." });
      }

      try {
        const result = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
          new PgSpecRepository(tx, ctx.workspaceId, request.params.id).replaceSourceAndSave(
            source,
            {
              baseRevision: request.body?.baseRevision,
            },
          ),
        );
        if (!result.success) {
          return reply
            .code(result.stale ? 409 : 422)
            .send({ success: false, errors: result.errors, revision: result.revision });
        }
        return { success: true, spec: result.spec, revision: result.revision };
      } catch (err) {
        if (err instanceof SpecNotFoundError) {
          return reply
            .code(404)
            .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
        }
        throw err;
      }
    },
  );
}
