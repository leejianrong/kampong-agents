import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { runStartupWiringCheck, type WiringCheckResult } from "./wiring-check.js";

// The hosted variant of packages/cli/src/server.ts (ADR-0013, KAN-1221 --
// the first V5 implementation card). Deliberately minimal at this stage:
// there is no database (KAN-1222/1223), no auth/sessions/workspaces
// (KAN-1225/1226), and no real spec-CRUD/BYOK/execution routes yet
// (KAN-1227-1231) -- this is a scaffold proving the package boundary,
// static-asset serving, and cross-package dependency wiring, nothing more.
// Like packages/cli's `createDevServer`, this serves the built canvas
// static assets and the API from one origin (ADR-0005's "one localhost
// origin" framing carries over to the hosted case per ADR-0013's decision
// record) -- `staticDir` is optional here for the same reason it is there:
// so this package's own tests can construct a server without needing
// apps/canvas built first.

export interface CreateServerOptions {
  /** Directory of the canvas app's built static assets (`apps/canvas/dist`, ADR-0005/ADR-0013). Omit to skip serving them (e.g. most of this package's own tests). */
  staticDir?: string;
}

export function createServer({ staticDir }: CreateServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Runs once, synchronously, before any route is registered -- see
  // wiring-check.ts's docstring for why this belongs at startup rather than
  // per-request. Throws (crashing startup) on failure rather than degrading
  // to an unhealthy route, since a failure here means the build/dependency
  // graph is broken, not a normal runtime condition.
  const wiringCheck: WiringCheckResult = runStartupWiringCheck();

  if (staticDir) {
    // Registered before /healthz below only in source-file order, not
    // precedence: Fastify's router matches exact-path routes ahead of this
    // plugin's wildcard file-serving, so /healthz is never shadowed by a
    // same-named static file.
    void app.register(fastifyStatic, { root: staticDir, index: ["index.html"] });
  }

  app.get("/healthz", async () => {
    return { status: "ok", checks: wiringCheck };
  });

  return app;
}
