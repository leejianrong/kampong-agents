import Fastify, { type FastifyInstance } from "fastify";
import type { PatchOp } from "@kampong/spec";
import { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
import { SpecStore } from "./spec-store.js";

// The local server `kampong dev` starts (PLAN.md Shape S5, ADR-0007):
// serves a spec-CRUD REST API and an SSE stream of file-change events to
// the browser canvas, since the canvas itself has no filesystem access.

export interface CreateDevServerOptions {
  specPath: string;
  layoutPath: string;
}

export function createDevServer({ specPath, layoutPath }: CreateDevServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = new SpecStore(specPath, layoutPath);
  const watcher = new SpecFileWatcher(specPath);
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

  return app;
}
