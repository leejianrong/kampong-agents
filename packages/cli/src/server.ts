import { basename, dirname, relative } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { loadWithLayout, type AgentSpec, type PatchOp, type SpecRepository } from "@kampong/spec";
import { isFirstPartyId, type RunEvent } from "@kampong/engine";
import { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
import { SpecStore } from "./spec-store.js";
import { componentCatalogFor, componentDispatcherFor, lockUses } from "./components.js";
import { envNamesIn, runDoctor, type DoctorOptions } from "./doctor.js";
import { SecretStore, validateSecret } from "./secrets.js";
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function hostAllowed(header: string | undefined, extra: string[]): boolean {
  if (!header) return false;
  // `[::1]:4310`, `localhost:4310` and `localhost` all name a host; keep only the host part.
  const name = (
    header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.split(":")[0]!
  ).toLowerCase();
  return LOOPBACK.has(name) || extra.some((host) => host.toLowerCase() === name);
}

export interface CreateDevServerOptions {
  specPath: string;
  layoutPath: string;
  /** Directory of the canvas app's built static assets (`apps/canvas/dist`, ADR-0005). Omit to skip serving them (e.g. most of this package's own tests). */
  staticDir?: string;
  /** Test-only seam, forwarded to RunManager -- see its docstring. Production callers omit this. */
  run?: RunManagerOptions;
  /** Test-only seams for the doctor routes (the environment, the dial and the probe's fetch). */
  doctor?: Partial<Pick<DoctorOptions, "env" | "connect" | "probeFetch">>;
  /**
   * Host names the server answers to besides loopback (`kampong dev --host`). `"*"` when it was bound to
   * every interface on purpose. Anything else is refused, which is what stops a web page that rebinds
   * its own name to 127.0.0.1 from calling these endpoints as if it were the canvas.
   */
  allowedHosts?: string[];
}

export function createDevServer({
  specPath,
  layoutPath,
  staticDir,
  run: runOptions,
  doctor: doctorOptions,
  allowedHosts = [],
}: CreateDevServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  // Typed as the `SpecRepository` interface (KAN-1224, ADR-0014), not the
  // concrete `SpecStore` -- every route below reads/writes through the
  // interface (and the shared `loadWithLayout` helper), so this is the one
  // place that would need to change to point `kampong dev` at a different
  // `SpecRepository` implementation later.
  const store: SpecRepository = new SpecStore(specPath, layoutPath);

  // KAN-1901: these endpoints can pin a component and send credentials to a service, so a page the author
  // happens to visit must not be able to reach them. DNS rebinding makes such a page same-origin with
  // localhost, so the Host header is checked, and a write must come from this origin.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (!allowedHosts.includes("*") && !hostAllowed(request.headers.host, allowedHosts)) {
      reply.code(403).send({ success: false, error: "This host name is not allowed." });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.origin;
      const site = request.headers["sec-fetch-site"];
      const crossOrigin =
        site === "cross-site" ||
        (typeof origin === "string" && origin !== "null"
          ? new URL(origin).host !== request.headers.host
          : origin === "null");
      if (crossOrigin) {
        reply.code(403).send({ success: false, error: "Cross-origin requests are not allowed." });
      }
    }
  });
  const watcher = new SpecFileWatcher(specPath);
  const runManager = new RunManager({
    ...runOptions,
    components: runOptions?.components ?? componentDispatcherFor(specPath),
  });
  watcher.start();

  // The Variables panel's store. Applied to this process's environment, which runs and checks already read.
  const secrets = new SecretStore(dirname(layoutPath), doctorOptions?.env ?? process.env);
  app.addHook("onReady", async () => {
    await secrets.load();
  });

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
      return await loadWithLayout(store);
    } catch (err) {
      const { status, body } = specFileErrorResponse(err, specPath);
      reply.code(status);
      return body;
    }
  });

  // KAN-1885: installed components, for the canvas's generated forms.
  app.get("/api/components", async () => componentCatalogFor(specPath));

  // KAN-1901: pin one installed component, as `kampong lock` would. A component that changed since it was
  // pinned is re-pinned here (the author has just been shown what it may do), but one that now may do more
  // than what was reviewed is refused unless the request says the wider permissions were accepted.
  app.post<{
    Body: { use?: unknown; allowWiderPermissions?: unknown; expectedDigest?: unknown };
  }>("/api/components/pin", async (request, reply) => {
    const { use, allowWiderPermissions, expectedDigest } = request.body ?? {};
    if (typeof use !== "string" || !use.includes("@")) {
      reply.code(400);
      return { success: false, error: 'use must be "id@version"' };
    }
    if (isFirstPartyId(use.slice(0, use.lastIndexOf("@")))) {
      reply.code(400);
      return { success: false, error: "A built-in component needs no pin." };
    }
    const outcome = await lockUses([use], specPath, {
      update: true,
      allowWiderPermissions: allowWiderPermissions === true,
      ...(typeof expectedDigest === "string" && { expectedDigest }),
    });
    if (!outcome.ok) {
      // What was reviewed is not what is on disk now: say so with the fresh catalog, so the author
      // reviews again instead of pinning something they were not shown.
      reply.code(outcome.stale ? 409 : 422);
      return {
        success: false,
        error: outcome.message,
        ...(outcome.stale && { catalog: await componentCatalogFor(specPath) }),
      };
    }
    return { success: true, catalog: await componentCatalogFor(specPath) };
  });

  // Variables: names and whether each is set, never a value. A value goes in with PUT and cannot come back out.
  async function referencedNames(): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const loaded = await loadWithLayout(store);
      if (loaded.spec) {
        envNamesIn(loaded.spec, names);
        // A component's credential is read through a slot that never appears as `${NAME}` in the spec, so
        // the offline checks, which already resolve slots and remaps, say which names are needed.
        await runDoctor(loaded.spec as AgentSpec, specPath, {
          env: process.env,
          ...doctorOptions,
          online: false,
          probe: false,
          onEnvName: (name) => names.add(name),
        });
      }
    } catch {
      // an unreadable spec just means no names are suggested
    }
    return names;
  }

  app.get("/api/secrets", async () => ({
    success: true,
    secrets: secrets.list(await referencedNames()),
  }));

  app.put<{ Params: { name: string }; Body: { value?: unknown } }>(
    "/api/secrets/:name",
    async (request, reply) => {
      const checked = validateSecret(request.params.name, request.body?.value);
      if (!checked.ok) {
        reply.code(400);
        return { success: false, error: checked.error };
      }
      await secrets.set(request.params.name, checked.value);
      return { success: true, secrets: secrets.list(await referencedNames()) };
    },
  );

  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (request, reply) => {
    if (!(await secrets.remove(request.params.name))) {
      reply.code(404);
      return { success: false, error: "No saved value with that name." };
    }
    return { success: true, secrets: secrets.list(await referencedNames()) };
  });

  // KAN-1901: `kampong doctor` for the canvas. Offline by default. `online` dials each host and `probe`
  // sends each credential to the service it belongs to, so both must be asked for.
  app.post<{ Body: { online?: unknown; probe?: unknown } }>(
    "/api/doctor",
    async (request, reply) => {
      let loaded;
      try {
        loaded = await loadWithLayout(store);
      } catch (err) {
        const { status, body } = specFileErrorResponse(err, specPath);
        reply.code(status);
        return body;
      }
      if (!loaded.success || !loaded.spec) {
        reply.code(422);
        return { success: false, errors: loaded.errors };
      }
      const checks = await runDoctor(loaded.spec as AgentSpec, specPath, {
        env: process.env,
        ...doctorOptions,
        online: request.body?.online === true,
        probe: request.body?.probe === true,
      });
      return { success: true, checks };
    },
  );

  app.put<{ Body: { ops: PatchOp[] } }>("/api/spec", async (request, reply) => {
    watcher.beginMutation();
    try {
      const result = await store.applyPatchAndSave(request.body.ops);
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
    const { success, spec, errors } = await loadWithLayout(store);
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
