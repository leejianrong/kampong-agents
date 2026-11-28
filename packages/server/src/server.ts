import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { runStartupWiringCheck, type WiringCheckResult } from "./wiring-check.js";
import { createAuth } from "./auth/config.js";
import { registerSpecRoutes } from "./routes/specs.js";
import { registerByokRoutes } from "./routes/byok.js";
import { registerSecretsRoutes } from "./routes/secrets.js";
import { registerRunRoutes } from "./routes/runs.js";
import { buildSecurityTxt, type SecurityTxtConfig } from "./security-txt.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerDeploymentRoutes } from "./routes/deployments.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuditHook } from "./audit/audit.js";
import { HostedRunManager, type HostedRunManagerOptions } from "./run/manager.js";
import { HostedScheduler, type HostedSchedulerOptions } from "./run/scheduler.js";
import type { DbClient } from "./db/client.js";
import type { IngressLimits } from "./run/rate-limit.js";

// The hosted variant of packages/cli/src/server.ts (ADR-0013, KAN-1221 --
// the first V5 implementation card). No real spec-CRUD/BYOK/execution
// routes yet (KAN-1227-1231) -- this is still mostly a scaffold proving the
// package boundary, static-asset serving, and cross-package dependency
// wiring. KAN-1226 (ADR-0015) is the first real HTTP surface: Better
// Auth's own sign-up/sign-in/session/OAuth-callback endpoints, mounted
// below. Like packages/cli's `createDevServer`, this serves the built
// canvas static assets and the API from one origin (ADR-0005's "one
// localhost origin" framing carries over to the hosted case per ADR-0013's
// decision record) -- `staticDir` is optional here for the same reason it
// is there: so this package's own tests can construct a server without
// needing apps/canvas built first.

export interface CreateServerOptions {
  /** Directory of the canvas app's built static assets (`apps/canvas/dist`, ADR-0005/ADR-0013). Omit to skip serving them (e.g. most of this package's own tests). */
  staticDir?: string;
  /**
   * A Drizzle client (`createDbClient`, src/db/client.ts) Better Auth's own
   * routes are mounted against. Omit to skip mounting Better Auth entirely
   * (e.g. this package's own no-DB unit tests, matching `staticDir`'s own
   * "omit to skip" shape) -- `main.ts` always provides one, since a real
   * deployment needs a real Postgres connection for auth to work at all.
   */
  db?: DbClient;
  /**
   * Options forwarded to the `HostedRunManager` (KAN-1231) -- notably its
   * `createModel` test seam, so this package's own tests can drive a run with
   * a fake `ModelClient` (no network, no stored BYOK key). Only consulted when
   * a `db` is given; production callers omit it.
   */
  run?: HostedRunManagerOptions;
  /**
   * Runs deployed `schedule` triggers (KAM-203, src/run/scheduler.ts). Off unless given: `main.ts` turns it on,
   * and a test that wants it passes `{}` (or seams). Only consulted when a `db` is given.
   */
  scheduler?: HostedSchedulerOptions | true;
  /** The public origin (`PUBLIC_BASE_URL`, KAM-321): deployment responses add a full `webhookUrl` built from it. Omit and they carry the path only. */
  publicBaseUrl?: string;
  /** A notice the hosted canvas pins to the top of every screen (`PREVIEW_NOTICE`, KAM-320), reported on /healthz. */
  previewNotice?: string;
  /** Rate and size limits on the public webhook ingress (KAM-322); omitted fields use defaults. */
  ingressLimits?: Partial<IngressLimits>;
  /** Where to report a vulnerability (KAM-331): served as /.well-known/security.txt. Omit and the route answers 404. */
  securityTxt?: SecurityTxtConfig;
  /** Trust `X-Forwarded-For`, so per-client limits see the real caller behind an ingress controller. Only set behind one. */
  trustProxy?: boolean;
}

export function createServer({
  staticDir,
  db,
  run,
  scheduler: schedulerOptions,
  publicBaseUrl,
  previewNotice,
  ingressLimits,
  securityTxt,
  trustProxy,
}: CreateServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, ...(trustProxy && { trustProxy: true }) });

  // Runs once, synchronously, before any route is registered -- see
  // wiring-check.ts's docstring for why this belongs at startup rather than
  // per-request. Throws (crashing startup) on failure rather than degrading
  // to an unhealthy route, since a failure here means the build/dependency
  // graph is broken, not a normal runtime condition.
  const wiringCheck: WiringCheckResult = runStartupWiringCheck();

  // KAN-1436: the public webhook-ingress route (registered below,
  // registerDeploymentRoutes) accepts any body shape a third-party caller
  // sends (JSON, form-urlencoded, plain text) as its run input, matching
  // `kampong serve`'s own /webhook route (packages/cli/src/serve-server.ts).
  // Registered as a fallback -- Fastify's built-in `application/json` parser
  // still runs for JSON bodies (a more specific match always wins over `*`),
  // so every authenticated JSON route above and below this line is
  // unaffected.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  if (staticDir) {
    // Registered before /healthz below only in source-file order, not
    // precedence: Fastify's router matches exact-path routes ahead of this
    // plugin's wildcard file-serving, so /healthz is never shadowed by a
    // same-named static file.
    void app.register(fastifyStatic, { root: staticDir, index: ["index.html"] });
  }

  if (db) {
    const auth = createAuth(db);

    // Better Auth's own documented Fastify integration pattern (its docs
    // site's "Integrations > Fastify" page, verified against the current
    // better-auth 1.7.3 release while building this card): reconstruct a
    // Fetch API `Request` from the incoming Fastify request and hand it to
    // `auth.handler`, rather than `better-auth/node`'s `toNodeHandler`
    // against the raw Node req/res -- `toNodeHandler` reads the request
    // body directly off the raw `IncomingMessage` stream, but Fastify's own
    // JSON body parser has already consumed that stream by the time a
    // route handler runs, so `toNodeHandler` would hang/see an empty body
    // here. Reusing Fastify's already-parsed `request.body` instead (only
    // re-serialized to JSON text for the `Request` constructor) sidesteps
    // that entirely. Every endpoint this card actually exercises (sign-up,
    // sign-in, organization create/list, the GitHub OAuth callback) is
    // JSON-bodied or body-less (GET), matching what this reconstruction
    // supports; a future multipart/form-data Better Auth endpoint would
    // need a different approach, but none exists in the plugin set this
    // card registers.
    app.all("/api/auth/*", async (request: FastifyRequest, reply) => {
      const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
      const headers = fromNodeHeaders(request.headers);

      const fetchRequest = new Request(url, {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });

      const response = await auth.handler(fetchRequest);

      void reply.status(response.status);
      response.headers.forEach((value, key) => {
        void reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    });

    // KAN-1227 (ADR-0014/ADR-0015): the authenticated, workspace-scoped
    // spec-CRUD routes. Registered only when a `db` is present, the same
    // "omit db to skip the DB-backed HTTP surface" shape Better Auth's own
    // routes above already use -- these need both a real Postgres (for RLS
    // scoping) and the same `auth` instance (to resolve the request's
    // session/workspace), so they live inside this block alongside it.
    registerAuditHook(app, db);
    registerAuditRoutes(app, { db, auth });
    registerSpecRoutes(app, { db, auth });

    // KAN-1229 (ADR-0016): the workspace-scoped, masked BYOK key-management
    // API. Same db+auth dependency and "only mounted when a db is present"
    // shape as the spec routes above.
    registerByokRoutes(app, { db, auth });
    registerSecretsRoutes(app, { db, auth });

    // KAN-1231 (ADR-0014): durable hosted execution. One HostedRunManager per
    // server holds the live in-flight runs and persists each to the `runs`
    // table; the routes start/read them scoped to the request's workspace.
    const runManager = new HostedRunManager(db, run);
    registerRunRoutes(app, { db, auth, manager: runManager });
    registerUsageRoutes(app, { db, auth, manager: runManager });

    // KAN-1436 (ADR-0022): the managed "go live" lifecycle API + the public
    // webhook-ingress route. Shares the same `HostedRunManager` instance as
    // the routes above -- a webhook-triggered run is durable and traceable
    // exactly like a canvas-triggered one, just started by a different route.
    const scheduler = schedulerOptions
      ? new HostedScheduler(db, runManager, schedulerOptions === true ? {} : schedulerOptions)
      : undefined;
    registerDeploymentRoutes(app, {
      db,
      auth,
      manager: runManager,
      ...(scheduler && { scheduler }),
      ...(publicBaseUrl && { publicBaseUrl }),
      ...(ingressLimits && { ingressLimits }),
    });
    if (scheduler) {
      // After listen, so a slow scan never delays the port; a failure is logged, not fatal.
      app.addHook("onReady", async () => {
        await scheduler.start().catch((err: unknown) => {
          console.error("kampong server: could not start the scheduler:", err);
        });
      });
      app.addHook("onClose", async () => {
        await scheduler.stop();
      });
    }
  }

  app.get("/.well-known/security.txt", async (_request, reply) => {
    if (!securityTxt) return reply.code(404).send({ error: "Not found" });
    return reply.type("text/plain; charset=utf-8").send(buildSecurityTxt(securityTxt));
  });

  app.get("/healthz", async () => {
    return { status: "ok", checks: wiringCheck, ...(previewNotice && { previewNotice }) };
  });

  return app;
}
