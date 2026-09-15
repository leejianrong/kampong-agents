import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { getByokRootKey } from "../auth/env.js";
import { encryptSecret, maskLastFour } from "../crypto/envelope.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { withWorkspaceScope } from "../db/workspace-scope.js";
import { byokKeys } from "../db/schema.js";

// KAN-1229 (ADR-0016): the workspace-scoped, masked BYOK key-management API.
// A workspace owner can add/replace and delete a provider key and list which
// providers are configured -- but a decrypted key value is NEVER returned by
// any route here (ADR-0016): the raw key is encrypted (src/crypto/envelope.ts)
// under the deployment root key and only ever leaves storage inside the
// model-resolution path at call time (KAN-1230/1231), never through this API.
// Every response carries only a masking hint (`lastFour`, e.g. "ab12"),
// enough for a UI to show a key is configured.
//
// Same shape as the spec-CRUD routes (src/routes/specs.ts): resolve +
// authorize the request's workspace (401/403), then run inside one
// `withWorkspaceScope` transaction so RLS on `byok_keys`
// (drizzle/0007_enable_byok_keys_rls.sql) enforces tenant isolation. The
// key-management UI that consumes this lands with the canvas-auth slice
// (KAN-1228); this card is the storage + API half.

export interface ByokRoutesDeps {
  db: DbClient;
  auth: AuthInstance;
}

// Provider identifiers are simple slugs (openai, anthropic, ...), also used
// as a path segment -- constrain them rather than accept arbitrary text.
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function registerByokRoutes(app: FastifyInstance, { db, auth }: ByokRoutesDeps): void {
  // GET /api/byok -- list the workspace's configured providers, masked. Never
  // selects `ciphertext`, so a decrypted or encrypted key can't leak here.
  app.get("/api/byok", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const keys = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .select({
          provider: byokKeys.provider,
          lastFour: byokKeys.lastFour,
          updatedAt: byokKeys.updatedAt,
        })
        .from(byokKeys),
    );
    return { success: true, keys };
  });

  // PUT /api/byok/:provider -- add or replace this workspace's key for a
  // provider. The raw key is encrypted before storage and only its last four
  // characters are echoed back.
  app.put<{ Params: { provider: string }; Body: { key?: unknown } }>(
    "/api/byok/:provider",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;

      const provider = request.params.provider;
      if (!PROVIDER_RE.test(provider)) {
        return reply.code(400).send({
          success: false,
          error: "`provider` must be a lowercase slug (letters, digits, hyphens).",
        });
      }
      const key = request.body?.key;
      if (typeof key !== "string" || key.length === 0) {
        return reply
          .code(400)
          .send({ success: false, error: "A non-empty `key` value is required." });
      }

      let ciphertext: string;
      try {
        ciphertext = encryptSecret(key, getByokRootKey(process.env));
      } catch {
        // A missing/invalid BYOK_ROOT_KEY is a deploy misconfiguration. Fail
        // visibly with a safe message -- never echo the key or the error's
        // own text (which could conceivably include key material).
        return reply.code(500).send({
          success: false,
          error: "BYOK encryption is not configured on this server.",
        });
      }
      const lastFour = maskLastFour(key);

      await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
        tx
          .insert(byokKeys)
          .values({ workspaceId: ctx.workspaceId, provider, ciphertext, lastFour })
          .onConflictDoUpdate({
            target: [byokKeys.workspaceId, byokKeys.provider],
            set: { ciphertext, lastFour, updatedAt: new Date() },
          }),
      );
      return reply.code(200).send({ success: true, provider, lastFour });
    },
  );

  // DELETE /api/byok/:provider -- remove this workspace's key for a provider.
  app.delete<{ Params: { provider: string } }>("/api/byok/:provider", async (request, reply) => {
    const ctx = await authorizeWorkspace(auth, db, request, reply);
    if (!ctx) return reply;

    const provider = request.params.provider;
    const deleted = await withWorkspaceScope(db, ctx.workspaceId, (tx) =>
      tx
        .delete(byokKeys)
        .where(and(eq(byokKeys.workspaceId, ctx.workspaceId), eq(byokKeys.provider, provider)))
        .returning({ provider: byokKeys.provider }),
    );
    if (deleted.length === 0) {
      return reply
        .code(404)
        .send({ success: false, error: `No key configured for provider "${provider}".` });
    }
    return { success: true, provider };
  });
}
