import { basename, relative } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AgentSpec, PatchOp } from "@kampong/spec";
import type { RunEvent } from "@kampong/engine";
import { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
import { SpecStore } from "./spec-store.js";
import { RunManager, type RunManagerOptions } from "./run-manager.js";

// KAN-1216: SpecStore.readSource()/applyPatchAndSave() throw the raw Node fs
// error (ENOENT when the spec file is deleted/renamed out from under a
// running `kampong dev`, EACCES if it becomes unreadable, etc.) -- letting
// that reach a route handler uncaught means Fastify's default error handler
// returns a bare 500 whose body is the raw error, absolute server
// filesystem path included. Both spec routes below catch that and translate
// it into a clean, specific 4xx/5xx JSON body instead -- never the raw
// error/path -- matching the { success: false, error } shape the /api/runs
// routes already use for their own error responses.
function shownSpecPath(specPath: string): string {
  // Relative to cwd (where `kampong dev` was launched, normally the project
  // root containing the spec) rather than the raw absolute path -- for the
  // normal case this collapses to something short like "agent.yaml". If cwd
  // and the spec path share no meaningful common ancestor, `relative()`
  // walks all the way up via `..` and back down through every real
  // directory name on the way -- which would leak just as much of the
  // host's absolute layout as the raw path. Fall back to just the file's
  // own name in that case.
  const rel = relative(process.cwd(), specPath);
  return rel.startsWith("..") ? basename(specPath) : rel;
}

function specFileErrorResponse(
  err: unknown,
  specPath: string,
): { status: number; body: { success: false; error: string } } {
  const shownPath = shownSpecPath(specPath);
  if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      status: 404,
      body: {
        success: false,
        error: `Spec file not found: ${shownPath}. It may have been deleted or moved.`,
      },
    };
  }
  return {
    status: 500,
    body: { success: false, error: `Spec file could not be read: ${shownPath}.` },
  };
}

// The local server `kampong dev` starts (PLAN.md Shape S5, ADR-0005,
// ADR-0007): serves the built canvas static assets, a spec-CRUD REST API,
// an SSE stream of file-change events, and (SLICES.md V2, KAN-1107) the
// in-canvas test-run endpoints -- start a run, stream its step-by-step
// progress over SSE, and approve/reject a pending guardrail/tool approval
// -- all as ONE localhost origin, per ADR-0005 ("the canvas is a local web
// app served by the CLI, not a desktop app"). `staticDir` is optional here
// (not on the CLI's own `kampong dev` path -- see cli.ts) purely so this
// package's server-focused tests can keep constructing a server without
// needing `apps/canvas` built first.

export interface CreateDevServerOptions {
  specPath: string;
  layoutPath: string;
  /** Directory of the canvas app's built static assets (`apps/canvas/dist`, ADR-0005). Omit to skip serving them (e.g. most of this package's own tests). */
  staticDir?: string;
  /** Test-only seam, forwarded to RunManager -- see its docstring. Production callers omit this. */
  run?: RunManagerOptions;
}

export function createDevServer({
  specPath,
  layoutPath,
  staticDir,
  run: runOptions,
}: CreateDevServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new SpecStore(specPath, layoutPath);
  const watcher = new SpecFileWatcher(specPath);
  const runManager = new RunManager(runOptions);
  watcher.start();

  app.addHook("onClose", (_instance, done) => {
    watcher.stop();
    done();
  });

  if (staticDir) {
    // Registered before the API routes below only in source-file order, not
    // matching precedence: Fastify's router matches the API routes' exact
    // paths ahead of this plugin's wildcard file-serving, so /api/* and
    // /api/events are never shadowed by a same-named static file.
    void app.register(fastifyStatic, { root: staticDir, index: ["index.html"] });
  }

  app.get("/api/spec", async (_request, reply) => {
    try {
      return store.loadWithLayout();
    } catch (err) {
      const { status, body } = specFileErrorResponse(err, specPath);
      reply.code(status);
      return body;
    }
  });

  app.put<{ Body: { ops: PatchOp[] } }>("/api/spec", async (request, reply) => {
    watcher.beginMutation();
    try {
      const result = store.applyPatchAndSave(request.body.ops);
      if (!result.success) {
        watcher.endMutation();
        reply.code(422);
        return { success: false, errors: result.errors };
      }
      // `result.source` is the exact bytes just written -- reusing it here
      // (rather than re-reading the file) is what avoids a second
      // store.readSource() call that used to throw its own ENOENT and mask
      // whatever error/response was already in flight if the file got
      // deleted mid-request.
      watcher.endMutation(result.source);
      return { success: true, spec: result.spec };
    } catch (err) {
      watcher.endMutation();
      const { status, body } = specFileErrorResponse(err, specPath);
      reply.code(status);
      return body;
    }
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const onChange = (event: FileWatchEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    watcher.on("change", onChange);
    request.raw.on("close", () => watcher.off("change", onChange));
  });

  app.post<{ Body: { input: string } }>("/api/runs", async (request, reply) => {
    const { success, spec, errors } = store.loadWithLayout();
    if (!success || !spec) {
      reply.code(422);
      return { success: false, errors };
    }

    try {
      // KAN-1187: returns as soon as the run is registered and kicked off --
      // `state` here is always the untouched initial "running" snapshot, not
      // the first pause/terminal state. The canvas (or any client) opens
      // `/api/runs/:id/events` with this `id` right away and drives all
      // further UI off that SSE stream, which is what makes the very first
      // step_started event (and everything after it) actually observable.
      const { id, state } = await runManager.start(spec as AgentSpec, request.body.input);
      return { success: true, id, state };
    } catch (err) {
      // Covers KAN-1106: a missing/invalid BYOK env var (or an unconfigured
      // model) throws synchronously from createAgentRun, before any network
      // call -- surfaced here as a specific 400, never a generic 500, and
      // the message never contains the resolved key value (only its name).
      reply.code(400);
      return { success: false, error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = runManager.get(request.params.id);
    if (!run) {
      reply.code(404);
      return { success: false, error: `Unknown run id "${request.params.id}".` };
    }
    return { success: true, state: run.getState() };
  });

  app.post<{ Params: { id: string }; Body: { approved: boolean; reason?: string } }>(
    "/api/runs/:id/approve",
    async (request, reply) => {
      // Routed through runManager.approve() (not run.resume() directly) so
      // the run map and its eviction bookkeeping have one entry point.
      try {
        const state = await runManager.approve(
          request.params.id,
          request.body.approved,
          request.body.reason,
        );
        if (state === undefined) {
          reply.code(404);
          return { success: false, error: `Unknown run id "${request.params.id}".` };
        }
        return { success: true, state };
      } catch (err) {
        reply.code(409);
        return { success: false, error: (err as Error).message };
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/runs/:id/events", (request, reply) => {
    const run = runManager.get(request.params.id);
    if (!run) {
      reply.code(404);
      reply.send({ success: false, error: `Unknown run id "${request.params.id}".` });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    reply.raw.write(`data: ${JSON.stringify({ type: "state", state: run.getState() })}\n\n`);

    const onEvent = (event: RunEvent) => {
      reply.raw.write(
        `data: ${JSON.stringify({ type: "event", event, state: run.getState() })}\n\n`,
      );
    };
    run.on("event", onEvent);
    request.raw.on("close", () => run.off("event", onEvent));
  });

  return app;
}
