import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthInstance } from "../auth/config.js";
import type { DbClient } from "../db/client.js";
import { authorizeWorkspace } from "../auth/request-context.js";
import { InvalidWorkspaceIdError, withWorkspaceScope } from "../db/workspace-scope.js";
import { deployments, specs } from "../db/schema.js";
import { SpecNotFoundError } from "../db/spec-repository.js";
import { WorkspaceApiKeyNotConfiguredError } from "../model/resolve.js";
import {
  HostedRunManager,
  InvalidStoredSpecError,
  UnsupportedOnHostedError,
  hostedUnsupportedFeature,
} from "../run/manager.js";
import { parseSpec, type AgentSpec } from "@kampong/spec";
import {
  handleWebhookRequest,
  resolveWebhookAuth,
  type WebhookTriggerConfig,
} from "@kampong/engine";
import { getByokRootKey } from "../auth/env.js";
import { decryptSecret, encryptSecret } from "../crypto/envelope.js";

// The name of the env var a spec's webhook auth reads its secret from, or undefined when the trigger needs no
// secret (none, or no auth at all). Uses the engine's own resolver, so hosted and `kampong serve` agree on
// what each preset needs.
function webhookSecretEnv(spec: AgentSpec): string | undefined {
  const trigger = spec.agent.trigger;
  if (trigger?.type !== "webhook") return undefined;
  if (trigger.preset === undefined && trigger.auth === undefined) return undefined;
  const resolved = resolveWebhookAuth(
    trigger.preset as Parameters<typeof resolveWebhookAuth>[0],
    trigger.auth as Parameters<typeof resolveWebhookAuth>[1],
  );
  return resolved.ok && resolved.auth.type !== "none" ? resolved.auth.secretEnv : undefined;
}

/** A fresh secret for a deployment's webhook: 256 random bits, prefixed so it is recognisable in a secret scanner. */
function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

interface RawBodyRequest {
  rawBody?: Buffer;
}

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
      let issuedSecret: string | undefined;
      const [row] = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
        const [spec] = await tx
          .select({ id: specs.id, yamlSource: specs.yamlSource })
          .from(specs)
          .where(and(eq(specs.id, specId), eq(specs.workspaceId, ctx.workspaceId)));
        if (!spec) throw new SpecNotFoundError(specId, ctx.workspaceId);
        // A deployment that could never fire (a schedule or poll trigger) or would ignore the spec's webhook
        // auth is refused here, not accepted and silently inert (KAM-203).
        const parsed = parseSpec(spec.yamlSource);
        let needsSecret = false;
        if (parsed.success && parsed.spec) {
          const unsupported = hostedUnsupportedFeature(parsed.spec as AgentSpec, { webhook: true });
          if (unsupported) throw new UnsupportedOnHostedError(unsupported);
          needsSecret = webhookSecretEnv(parsed.spec as AgentSpec) !== undefined;
        }

        const rows = await tx
          .insert(deployments)
          .values({ workspaceId: ctx.workspaceId, specId })
          .onConflictDoUpdate({
            target: deployments.specId,
            set: { status: "live", updatedAt: new Date() },
          })
          .returning({
            id: deployments.id,
            status: deployments.status,
            secret: deployments.webhookSecretCiphertext,
          });
        const current = rows[0]!;
        // The webhook's secret is the server's to generate (ADR-0057), once per deployment: a redeploy keeps it.
        if (needsSecret && !current.secret) {
          issuedSecret = newWebhookSecret();
          await tx
            .update(deployments)
            .set({ webhookSecretCiphertext: encryptSecret(issuedSecret, getByokRootKey()) })
            .where(eq(deployments.id, current.id));
        } else if (!needsSecret && current.secret) {
          await tx
            .update(deployments)
            .set({ webhookSecretCiphertext: null })
            .where(eq(deployments.id, current.id));
        }
        return rows;
      });
      return reply.code(200).send({
        success: true,
        deploymentId: row!.id,
        status: row!.status,
        webhookPath: `/hooks/w/${ctx.workspaceId}/${row!.id}`,
        // Present only in the response that created it; it cannot be read back. Lose it and rotate.
        ...(issuedSecret ? { webhookSecret: issuedSecret } : {}),
      });
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        return reply
          .code(404)
          .send({ success: false, error: `No spec "${specId}" in this workspace.` });
      }
      if (err instanceof UnsupportedOnHostedError) {
        return reply.code(422).send({ success: false, error: err.message });
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

  // POST /api/specs/:id/deployment/webhook-secret -- issue a new webhook secret (shown once; the old one stops
  // working at once). For a lost secret or a leaked one. 422 when the spec's trigger has no auth to sign.
  app.post<{ Params: { id: string } }>(
    "/api/specs/:id/deployment/webhook-secret",
    async (request, reply) => {
      const ctx = await authorizeWorkspace(auth, db, request, reply);
      if (!ctx) return reply;
      const specId = request.params.id;
      const secret = newWebhookSecret();
      const result = await withWorkspaceScope(db, ctx.workspaceId, async (tx) => {
        const [spec] = await tx
          .select({ yamlSource: specs.yamlSource })
          .from(specs)
          .where(and(eq(specs.id, specId), eq(specs.workspaceId, ctx.workspaceId)));
        if (!spec) return "no-deployment" as const;
        const parsed = parseSpec(spec.yamlSource);
        if (
          !parsed?.success ||
          !parsed.spec ||
          webhookSecretEnv(parsed.spec as AgentSpec) === undefined
        ) {
          return "no-auth" as const;
        }
        const updated = await tx
          .update(deployments)
          .set({
            webhookSecretCiphertext: encryptSecret(secret, getByokRootKey()),
            updatedAt: new Date(),
          })
          .where(and(eq(deployments.specId, specId), eq(deployments.workspaceId, ctx.workspaceId)))
          .returning({ id: deployments.id });
        return updated.length > 0 ? ("ok" as const) : ("no-deployment" as const);
      });
      if (result === "no-deployment") {
        return reply
          .code(404)
          .send({ success: false, error: `Spec "${specId}" has never been deployed.` });
      }
      if (result === "no-auth") {
        return reply.code(422).send({
          success: false,
          error:
            "This spec's webhook trigger has no `auth` or `preset`, so there is no secret to issue.",
        });
      }
      return { success: true, webhookSecret: secret };
    },
  );

  // The public webhook ingress, in its own encapsulated scope because it needs the request's RAW bytes: a
  // signature (hmac) is over the exact body, which Fastify's default JSON parser throws away. The parsers
  // mirror `kampong serve`'s (packages/cli/src/serve-server.ts).
  void app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
      (req as unknown as RawBodyRequest).rawBody = body as Buffer;
      const text = (body as Buffer).toString("utf8");
      if (text === "") {
        const err = new Error(
          "Body cannot be empty when content-type is set to 'application/json'",
        );
        (err as Error & { statusCode: number }).statusCode = 400;
        return done(err, undefined);
      }
      try {
        // A "__proto__" key is dropped, as Fastify's default JSON parser does.
        done(
          null,
          JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value)),
        );
      } catch (parseError) {
        (parseError as Error & { statusCode: number }).statusCode = 400;
        done(parseError as Error, undefined);
      }
    });
    hooks.addContentTypeParser("*", { parseAs: "buffer" }, (req, body, done) => {
      (req as unknown as RawBodyRequest).rawBody = body as Buffer;
      done(null, (body as Buffer).toString("utf8"));
    });

    // POST /hooks/w/:workspaceId/:deploymentId -- the trigger. No session, no `authorizeWorkspace`: the two
    // path segments identify the deployment, and when the spec's trigger has `auth` or a `preset` the caller
    // must also prove itself with the deployment's webhook secret, checked by the engine's own
    // `handleWebhookRequest` (the code `kampong serve` runs), so the same spec accepts and rejects the same
    // requests in both. Authentication comes first; `when` and `map` follow. Body becomes the run input.
    hooks.post<{ Params: { workspaceId: string; deploymentId: string } }>(
      "/hooks/w/:workspaceId/:deploymentId",
      async (request, reply) => {
        const { workspaceId, deploymentId } = request.params;

        let row:
          { specId: string; status: string; secret: string | null; source: string } | undefined;
        try {
          [row] = await withWorkspaceScope(db, workspaceId, (tx) =>
            tx
              .select({
                specId: deployments.specId,
                status: deployments.status,
                secret: deployments.webhookSecretCiphertext,
                source: specs.yamlSource,
              })
              .from(deployments)
              .innerJoin(specs, eq(specs.id, deployments.specId))
              .where(
                and(eq(deployments.id, deploymentId), eq(deployments.workspaceId, workspaceId)),
              ),
          );
        } catch (err) {
          if (err instanceof InvalidWorkspaceIdError) row = undefined;
          else throw err;
        }

        // Deliberately the same 404 for "no such deployment," "wrong workspace," and "paused" -- an outside
        // caller can't distinguish a paused deployment from one that never existed, exactly like RLS already
        // makes another workspace's row indistinguishable from a nonexistent one.
        if (!row || row.status !== "live") {
          return reply.code(404).send({ success: false, error: "Unknown or inactive webhook." });
        }

        const parsed = parseSpec(row.source);
        let runTrigger:
          { headers?: Record<string, string>; fields?: Record<string, unknown> } | undefined;
        if (parsed.success && parsed.spec) {
          const spec = parsed.spec as AgentSpec;
          const trigger = spec.agent.trigger?.type === "webhook" ? spec.agent.trigger : undefined;
          // The spec names an env var for the secret; on hosted that name resolves to THIS deployment's own
          // secret and nothing else (never the server's environment). No stored secret -> the handler finds
          // the variable unset and refuses every request.
          const secretEnv = webhookSecretEnv(spec);
          const env: NodeJS.ProcessEnv = {};
          if (secretEnv !== undefined && row.secret) {
            env[secretEnv] = decryptSecret(row.secret, getByokRootKey());
          }
          const decision = await handleWebhookRequest(
            trigger as WebhookTriggerConfig | undefined,
            {
              headers: request.headers,
              rawBody: (request as unknown as RawBodyRequest).rawBody ?? "",
            },
            { env },
          );
          if (decision.action === "reject" || decision.action === "respond") {
            return reply.code(decision.status).send(decision.body);
          }
          if (decision.action === "error") return reply.code(decision.status).send(decision.body);
          if (decision.action === "ignore") {
            return reply.code(200).send({ success: true, ignored: true, reason: decision.reason });
          }
          runTrigger = {
            headers: decision.trigger.headers,
            ...(decision.trigger.fields && { fields: decision.trigger.fields }),
          };
        }

        const input =
          typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? "");

        try {
          const { id, state } = await manager.start(workspaceId, row.specId, input, {
            viaWebhook: true,
            ...(runTrigger ? { trigger: runTrigger } : {}),
          });
          return reply.code(201).send({ success: true, id, state });
        } catch (err) {
          if (err instanceof SpecNotFoundError) {
            // The spec was deleted after being deployed (the FK would have cascade-deleted this row too, so
            // this is only reachable via a genuine race) -- not this caller's fault to see.
            return reply.code(404).send({ success: false, error: "Unknown or inactive webhook." });
          }
          if (
            err instanceof InvalidStoredSpecError ||
            err instanceof UnsupportedOnHostedError ||
            err instanceof WorkspaceApiKeyNotConfiguredError
          ) {
            // A real misconfiguration on the deploying workspace's side (a spec that no longer parses, or a
            // model key that was removed after deploy) -- a 422, since the webhook itself was found.
            return reply.code(422).send({ success: false, error: err.message });
          }
          throw err;
        }
      },
    );
  });
}
