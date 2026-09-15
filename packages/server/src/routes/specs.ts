import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadWithLayout, parseSpec, type PatchOp } from "@kampong/spec";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../auth/request-context.js";
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
  // Resolve + authorize the request's workspace, or send the typed 401/403
  // body and return `undefined` so the caller bails. Keeps the auth gate in
  // exactly one place across all four routes.
  async function authorize(
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

  app.get("/api/specs", async (request, reply) => {
    const ctx = await authorize(request, reply);
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
    const ctx = await authorize(request, reply);
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
    const ctx = await authorize(request, reply);
    if (!ctx) return reply;

    try {
      return await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
        loadWithLayout(new PgSpecRepository(tx, ctx.workspaceId, request.params.id)),
      );
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        return reply
          .code(404)
          .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
      }
      throw err;
    }
  });

  app.put<{ Params: { id: string }; Body: { ops?: PatchOp[] } }>(
    "/api/specs/:id",
    async (request, reply) => {
      const ctx = await authorize(request, reply);
      if (!ctx) return reply;

      const ops = request.body?.ops;
      if (!Array.isArray(ops)) {
        return reply
          .code(400)
          .send({ success: false, error: "Request body must include an `ops` array." });
      }

      try {
        const result = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
          new PgSpecRepository(tx, ctx.workspaceId, request.params.id).applyPatchAndSave(ops),
        );
        if (!result.success) {
          return reply.code(422).send({ success: false, errors: result.errors });
        }
        return { success: true, spec: result.spec };
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
