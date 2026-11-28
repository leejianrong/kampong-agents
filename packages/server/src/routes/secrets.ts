import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { getByokRootKey } from "../auth/env.js";
import { encryptSecret, maskLastFour } from "../crypto/envelope.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { specs, workspaceSecrets } from "../db/schema.js";
import { SECRET_NAME_RE, secretNamesFor } from "../secrets/resolve.js";
import { parseSpec } from "@kampong/spec";

// KAM-81 (ADR-0016): the workspace-scoped, masked management API for the credentials a workflow's connectors read
// (`${SLACK_BOT_TOKEN}`). Same shape and guarantees as the BYOK routes (routes/byok.ts): authorize the request's
// workspace, run inside one `withWorkspaceScope` transaction so RLS on `workspace_secrets` isolates tenants, and
// NEVER return a value, encrypted or not. A response carries the name and a masking hint (`lastFour`) only. The
// decrypted value reaches only a run's own environment (src/secrets/resolve.ts).

export interface SecretsRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
}

export function registerSecretsRoutes(app: FastifyInstance, { db, auth }: SecretsRoutesDeps): void {
  // GET /api/secrets: the names stored for this workspace, masked. Never selects `ciphertext`.
  app.get("/api/secrets", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "secret:read");
    if (!ctx) return reply;
    const secrets = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .select({
          name: workspaceSecrets.name,
          lastFour: workspaceSecrets.lastFour,
          updatedAt: workspaceSecrets.updatedAt,
        })
        .from(workspaceSecrets),
    );
    return { success: true, secrets };
  });

  // GET /api/specs/:id/secrets (KAM-204): what the canvas's Secrets panel lists for the open spec. Every name the spec
  // reads through `${NAME}` (and the credential slots of its first-party components) with whether the workspace has
  // stored a value, plus every other stored name. The same shape as the local server's list, so the panel and the
  // Run bar's "Needed, not set" prompt work unchanged. Names and a stored/not-stored flag only, never a value.
  app.get<{ Params: { id: string } }>("/api/specs/:id/secrets", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "secret:read");
    if (!ctx) return reply;
    const found = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
      const [spec] = await tx
        .select({ yamlSource: specs.yamlSource })
        .from(specs)
        .where(and(eq(specs.id, request.params.id), eq(specs.workspaceId, ctx.workspaceId)));
      if (!spec) return undefined;
      const stored = await tx.select({ name: workspaceSecrets.name }).from(workspaceSecrets);
      return { source: spec.yamlSource, stored: new Set(stored.map((r) => r.name)) };
    });
    if (!found) {
      return reply
        .code(404)
        .send({ success: false, error: `No spec "${request.params.id}" in this workspace.` });
    }
    const parsed = parseSpec(found.source);
    const referenced =
      parsed.success && parsed.spec ? await secretNamesFor(parsed.spec) : new Set<string>();
    const names = new Set([...referenced, ...found.stored]);
    const secrets = [...names].sort().map((name) => ({
      name,
      source: found.stored.has(name) ? ("saved" as const) : ("unset" as const),
      referenced: referenced.has(name),
    }));
    return { success: true, secrets };
  });

  // PUT /api/secrets/:name: add or replace a secret. Encrypted before storage; only the last four characters echo.
  app.put<{ Params: { name: string }; Body: { value?: unknown } }>(
    "/api/secrets/:name",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply, "secret:write");
      if (!ctx) return reply;

      const name = request.params.name;
      if (!SECRET_NAME_RE.test(name)) {
        return reply.code(400).send({
          success: false,
          error:
            "`name` must be an environment-variable name: capital letters, digits and underscores.",
        });
      }
      const value = request.body?.value;
      if (typeof value !== "string" || value.length === 0) {
        return reply.code(400).send({ success: false, error: "A non-empty `value` is required." });
      }

      let ciphertext: string;
      try {
        ciphertext = encryptSecret(value, getByokRootKey(process.env));
      } catch {
        // A missing or invalid BYOK_ROOT_KEY is a deploy misconfiguration; never echo the value or the error text.
        return reply
          .code(500)
          .send({ success: false, error: "Secret encryption is not configured on this server." });
      }
      const lastFour = maskLastFour(value);

      await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
        tx
          .insert(workspaceSecrets)
          .values({ workspaceId: ctx.workspaceId, name, ciphertext, lastFour })
          .onConflictDoUpdate({
            target: [workspaceSecrets.workspaceId, workspaceSecrets.name],
            set: { ciphertext, lastFour, updatedAt: new Date() },
          }),
      );
      return reply.code(200).send({ success: true, name, lastFour });
    },
  );

  // DELETE /api/secrets/:name
  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply, "secret:write");
    if (!ctx) return reply;
    const name = request.params.name;
    const deleted = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .delete(workspaceSecrets)
        .where(
          and(eq(workspaceSecrets.workspaceId, ctx.workspaceId), eq(workspaceSecrets.name, name)),
        )
        .returning({ name: workspaceSecrets.name }),
    );
    if (deleted.length === 0) {
      return reply.code(404).send({ success: false, error: `No secret named "${name}".` });
    }
    return { success: true, name };
  });
}
