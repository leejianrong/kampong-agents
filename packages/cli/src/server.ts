import Fastify, { type FastifyInstance } from "fastify";
import type { AgentSpec, PatchOp } from "@kampong/spec";
import type { RunEvent } from "@kampong/engine";
import { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
import { SpecStore } from "./spec-store.js";
import { RunManager, type RunManagerOptions } from "./run-manager.js";

// The local server `kampong dev` starts (PLAN.md Shape S5, ADR-0007):
// serves a spec-CRUD REST API, an SSE stream of file-change events, and
// (SLICES.md V2, KAN-1107) the in-canvas test-run endpoints -- start a run,
// stream its step-by-step progress over SSE, and approve/reject a pending
// guardrail/tool approval -- to the browser canvas, since the canvas itself
// has no filesystem or process access.

export interface CreateDevServerOptions {
  specPath: string;
  layoutPath: string;
  /** Test-only seam, forwarded to RunManager -- see its docstring. Production callers omit this. */
  run?: RunManagerOptions;
}

export function createDevServer({
  specPath,
  layoutPath,
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

  app.get("/api/spec", async () => store.loadWithLayout());

  app.put<{ Body: { ops: PatchOp[] } }>("/api/spec", async (request, reply) => {
    watcher.beginMutation();
    try {
      const result = store.applyPatchAndSave(request.body.ops);
      if (!result.success) {
        reply.code(422);
        return { success: false, errors: result.errors };
      }
      return { success: true, spec: result.spec };
    } finally {
      watcher.endMutation(store.readSource());
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
      const run = runManager.get(request.params.id);
      if (!run) {
        reply.code(404);
        return { success: false, error: `Unknown run id "${request.params.id}".` };
      }
      try {
        const state = await run.resume(request.body.approved, request.body.reason);
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
