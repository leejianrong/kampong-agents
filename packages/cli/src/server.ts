import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  blankSpecSource,
  DEFAULT_SCHEMA_PATH,
  isBlankSource,
  loadWithLayout,
  parseSpec,
  type AgentSpec,
  type SpecOp,
  type SpecRepository,
} from "@kampong/spec";
import { isFirstPartyId, type RunEvent } from "@kampong/engine";
import { SpecFileWatcher, type FileWatchEvent } from "./file-watcher.js";
import { SpecStore, revisionOf } from "./spec-store.js";
import {
  answerQuestion,
  assistantHost,
  proposeEdits,
  resolveAssistantConfig,
  type FetchLike,
} from "./assistant.js";
import { componentCatalogFor, componentDispatcherFor, lockUses } from "./components.js";
import { envNamesIn, runDoctor, type DoctorOptions } from "./doctor.js";
import { SecretStore, validateSecret } from "./secrets.js";
import { copyTemplateFixtures, listTemplates, templateSource } from "./templates.js";
import { RunManager, type RunManagerOptions } from "./run-manager.js";
import {
  callsNothingOutside,
  defaultFixturesDir,
  describeRunOptions,
  replayDepsFor,
  replayFixturesDirFor,
} from "./run-options.js";

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

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

// The JSON Schema ships beside the spec package; the pragma wants a path from the spec file to it. Resolved
// when needed (not at import), and a runtime that cannot give a file URL falls back to the default path.
function schemaPragmaPath(specPath: string): string {
  try {
    const schemaFile = fileURLToPath(
      new URL("../../spec/schemas/agent-spec.v1.0.schema.json", import.meta.url),
    );
    return relative(dirname(specPath), schemaFile).split("\\").join("/");
  } catch {
    return DEFAULT_SCHEMA_PATH;
  }
}

/**
 * The response for a spec file that could not be read or written (KAM-195). A failed write is a save failure
 * and says why in a sentence, never the raw errno text or a host path; a failed read stays a read failure.
 */
export function specFileErrorResponse(
  err: unknown,
  specPath: string,
  op: "read" | "write" = "read",
): { status: number; body: { success: false; error: string } } {
  const shownPath = shownSpecPath(specPath);
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") {
    return {
      status: 404,
      body: {
        success: false,
        error: `Spec file not found: ${shownPath}. It may have been deleted or moved.`,
      },
    };
  }
  const denied = code === "EACCES" || code === "EPERM";
  if (op === "write") {
    const why = denied
      ? `${shownPath} is not writable (permission denied)`
      : code === "EROFS"
        ? `${shownPath} is on a read-only file system`
        : code === "ENOSPC"
          ? "the disk is full"
          : code === "EDQUOT"
            ? "the disk quota is exceeded"
            : `${shownPath} could not be written`;
    return { status: 500, body: { success: false, error: `Could not save: ${why}.` } };
  }
  return {
    status: 500,
    body: {
      success: false,
      error: `Spec file could not be read: ${shownPath}${denied ? " (permission denied)" : ""}.`,
    },
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
  doctor?: Partial<Pick<DoctorOptions, "env" | "connect" | "probeFetch" | "assistantFetch">>;
  /**
   * Host names the server answers to besides loopback (`kampong dev --host`). `"*"` when it was bound to
   * every interface on purpose. Anything else is refused, which is what stops a web page that rebinds
   * its own name to 127.0.0.1 from calling these endpoints as if it were the canvas.
   */
  allowedHosts?: string[];
  /** Test-only seam: the fetch the assistant calls its endpoint with (the real `fetch` otherwise). */
  assistantFetch?: FetchLike;
}

export function createDevServer({
  specPath,
  layoutPath,
  staticDir,
  run: runOptions,
  doctor: doctorOptions,
  allowedHosts = [],
  assistantFetch,
}: CreateDevServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  // Typed as the `SpecRepository` interface (KAN-1224, ADR-0014), not the
  // concrete `SpecStore` -- every route below reads/writes through the
  // interface (and the shared `loadWithLayout` helper), so this is the one
  // place that would need to change to point `kampong dev` at a different
  // `SpecRepository` implementation later.
  const fileStore = new SpecStore(specPath, layoutPath);
  const store: SpecRepository = fileStore;

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
      // KAM-196: no spec file is a new workflow, not an error. The canvas shows its empty state; the file is
      // created on the first save (or on "Start blank"). Anything else that stops a read is still an error.
      if (isNotFound(err)) {
        return { success: false, missing: true, errors: [], layout: {}, source: "" };
      }
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

  // KAM-249 (ADR-0060): the workflow assistant. GET says where a prompt would be sent, so the canvas can tell the
  // person before their first use; it never holds a key. POST asks the configured OpenAI-compatible endpoint for
  // a plan and returns it as validated ops: nothing is applied or written here, the canvas applies them through
  // PUT /api/spec when the person says so, and `revision` lets that write refuse if the file changed meanwhile.
  const assistantEnv = () => doctorOptions?.env ?? process.env;
  app.get("/api/assistant", async () => {
    let spec: AgentSpec | undefined;
    try {
      const loaded = await loadWithLayout(store);
      if (loaded.success) spec = loaded.spec as AgentSpec;
    } catch {
      // No file yet: the endpoint may still be configured from the environment.
    }
    const resolved = resolveAssistantConfig(assistantEnv(), spec);
    return resolved.ok
      ? {
          configured: true,
          host: assistantHost(resolved.config),
          model: resolved.config.model,
          from: resolved.config.from,
        }
      : { configured: false, code: resolved.code, error: resolved.error };
  });

  app.post<{ Body: { prompt?: unknown; mode?: unknown } }>(
    "/api/assistant",
    async (request, reply) => {
      const prompt = request.body?.prompt;
      const mode = request.body?.mode ?? "build";
      if (mode !== "build" && mode !== "ask") {
        reply.code(400);
        return { success: false, error: 'mode must be "build" or "ask".' };
      }
      if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > 4000) {
        reply.code(400);
        return { success: false, error: "Say what you want in 1 to 4000 characters." };
      }
      let source: string;
      try {
        source = await store.readSource();
      } catch (err) {
        if (isNotFound(err)) {
          reply.code(409);
          return { success: false, error: "There is no workflow yet. Start one first." };
        }
        const { status, body } = specFileErrorResponse(err, specPath);
        reply.code(status);
        return body;
      }
      if (isBlankSource(source)) {
        reply.code(409);
        return { success: false, error: "There is no workflow yet. Start one first." };
      }
      const loaded = parseSpec(source);
      if (!loaded.success || !loaded.spec) {
        reply.code(422);
        return { success: false, errors: loaded.errors };
      }
      const resolved = resolveAssistantConfig(assistantEnv(), loaded.spec);
      if (!resolved.ok) {
        reply.code(503);
        return { success: false, code: resolved.code, error: resolved.error };
      }
      // Ask mode (KAM-251): an answer in words. It builds no plan and returns no ops, whatever the model says.
      if (mode === "ask") {
        const asked = await answerQuestion(
          resolved.config,
          { prompt: prompt.trim(), source },
          assistantFetch,
        );
        if (asked.success) return { success: true, mode: "ask", answer: asked.answer };
        reply.code(502);
        return { success: false, code: "unavailable", error: asked.error };
      }
      const catalog = await componentCatalogFor(specPath);
      const result = await proposeEdits(
        resolved.config,
        {
          prompt: prompt.trim(),
          source,
          components: catalog.components.map((c) => ({
            use: `${c.id}@${c.version}`,
            ops: Object.keys(c.ops),
          })),
        },
        assistantFetch,
      );
      if (result.success) return { ...result, mode: "build", revision: revisionOf(source) };
      if (result.kind === "unavailable") {
        reply.code(502);
        return { success: false, code: "unavailable", error: result.error };
      }
      reply.code(422);
      return {
        success: false,
        code: "invalid",
        error: "The assistant's plan could not be applied, so nothing was changed.",
        errors: result.errors,
      };
    },
  );

  // KAM-196: "Start blank". Writes the minimal valid spec (with the schema pragma) when there is no spec yet or
  // the file is empty, and refuses to touch one that has content. Choosing a template (KAM-216) is the next route.
  app.post("/api/spec/blank", async (_request, reply) => {
    watcher.beginMutation();
    try {
      const current = await fileStore.readSourceOrBlank();
      if (!isBlankSource(current)) {
        watcher.endMutation();
        reply.code(409);
        return {
          success: false,
          error: "This workflow already has content, so it was not replaced.",
        };
      }
      const source = blankSpecSource({
        schemaPath: schemaPragmaPath(specPath),
      });
      const result = await fileStore.replaceSourceAndSave(source);
      if (!result.success) {
        watcher.endMutation();
        reply.code(422);
        return { success: false, errors: result.errors };
      }
      watcher.endMutation(result.source);
      return { success: true, spec: result.spec, revision: result.revision };
    } catch (err) {
      watcher.endMutation();
      const { status, body } = specFileErrorResponse(err, specPath, "write");
      reply.code(status);
      return body;
    }
  });

  // KAM-216: the template gallery. Lists the templates that ship with kampong; choosing one saves its spec as
  // this workflow (only into an empty one, as "Start blank" does, unless the request says `replace`) and copies its recorded fixtures to where a
  // replay run looks, so it runs with no key. The hosted server has no template route yet; the canvas hides the
  // gallery when the client has no `listTemplates`.
  app.get("/api/templates", async () =>
    listTemplates().map(({ name, title, description, stepKinds, runsOffline }) => ({
      name,
      title,
      description,
      stepKinds,
      runsOffline,
    })),
  );

  app.post<{ Body: { name?: unknown; replace?: unknown } }>(
    "/api/spec/template",
    async (request, reply) => {
      const wanted = request.body?.name;
      const info =
        typeof wanted === "string" ? listTemplates().find((t) => t.name === wanted) : undefined;
      if (!info) {
        reply.code(404);
        return { success: false, error: "There is no template with that name." };
      }
      watcher.beginMutation();
      try {
        const current = await fileStore.readSourceOrBlank();
        if (request.body?.replace !== true && !isBlankSource(current)) {
          watcher.endMutation();
          reply.code(409);
          return {
            success: false,
            error: "This workflow already has content, so it was not replaced.",
          };
        }
        const result = await fileStore.replaceSourceAndSave(
          templateSource(info, schemaPragmaPath(specPath)),
        );
        if (!result.success) {
          watcher.endMutation();
          reply.code(422);
          return { success: false, errors: result.errors };
        }
        copyTemplateFixtures(info, join(dirname(specPath), ".kampong", "fixtures"));
        watcher.endMutation(result.source);
        return { success: true, spec: result.spec, revision: result.revision };
      } catch (err) {
        watcher.endMutation();
        const { status, body } = specFileErrorResponse(err, specPath, "write");
        reply.code(status);
        return body;
      }
    },
  );

  // KAM-207 (ADR-0054): import. Replaces the spec file with the text given if it validates; an invalid text
  // is a 422 with line-numbered errors and the file is untouched.
  app.put<{ Body: { source?: unknown; baseRevision?: string } }>(
    "/api/spec/source",
    async (request, reply) => {
      if (typeof request.body?.source !== "string") {
        reply.code(400);
        return { success: false, error: "Request body must include a `source` string." };
      }
      watcher.beginMutation();
      try {
        const result = await store.replaceSourceAndSave(request.body.source, {
          baseRevision: request.body.baseRevision,
        });
        if (!result.success) {
          watcher.endMutation();
          reply.code(result.stale ? 409 : 422);
          return { success: false, errors: result.errors, revision: result.revision };
        }
        watcher.endMutation(result.source);
        return { success: true, spec: result.spec, revision: result.revision };
      } catch (err) {
        watcher.endMutation();
        const { status, body } = specFileErrorResponse(err, specPath, "write");
        reply.code(status);
        return body;
      }
    },
  );

  app.put<{ Body: { ops: SpecOp[]; baseRevision?: string } }>(
    "/api/spec",
    async (request, reply) => {
      watcher.beginMutation();
      try {
        // ADR-0055: `ops` may be raw patch ops or step/tool ops; `baseRevision` is optional.
        const result = await store.applyOpsAndSave(request.body.ops, {
          baseRevision: request.body.baseRevision,
        });
        if (!result.success) {
          watcher.endMutation();
          if (result.stale) {
            reply.code(409);
            return { success: false, errors: result.errors, revision: result.revision };
          }
          reply.code(422);
          return { success: false, errors: result.errors, revision: result.revision };
        }
        // `result.source` is the exact bytes just written -- reusing it here
        // (rather than re-reading the file) is what avoids a second
        // store.readSource() call that used to throw its own ENOENT and mask
        // whatever error/response was already in flight if the file got
        // deleted mid-request.
        watcher.endMutation(result.source);
        return {
          success: true,
          spec: result.spec,
          revision: result.revision,
          changes: result.changes,
        };
      } catch (err) {
        watcher.endMutation();
        const { status, body } = specFileErrorResponse(err, specPath, "write");
        reply.code(status);
        return body;
      }
    },
  );

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

  // KAM-188: which modes a test run can use for the spec on disk, and what a live run would call.
  app.get("/api/run-options", async (_request, reply) => {
    let loaded;
    try {
      loaded = await loadWithLayout(store);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      reply.code(422);
      return { success: false, error: "There is no workflow to run yet." };
    }
    if (!loaded.success || !loaded.spec) {
      reply.code(422);
      return {
        success: false,
        error: "The workflow has errors; fix them to see how it would run.",
      };
    }
    return { success: true, ...(await describeRunOptions(loaded.spec as AgentSpec, specPath)) };
  });

  app.post<{ Body: { input: string; mode?: "replay" | "live"; vars?: Record<string, unknown> } }>(
    "/api/runs",
    async (request, reply) => {
      let loaded;
      try {
        loaded = await loadWithLayout(store);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        reply.code(422);
        return {
          success: false,
          errors: [],
          error: "There is no workflow to run yet: choose a template or start blank first.",
        };
      }
      const { success, spec, errors } = loaded;
      if (!success || !spec) {
        reply.code(422);
        return { success: false, errors };
      }

      const mode = request.body.mode ?? "live";
      if (mode !== "live" && mode !== "replay") {
        reply.code(400);
        return { success: false, error: `Unknown run mode "${String(mode)}"; use replay or live.` };
      }

      // KAM-191: values for the spec's vars, for this run only. The spec on disk is not touched.
      const vars = request.body.vars;
      if (vars !== undefined) {
        if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
          reply.code(400);
          return { success: false, error: "vars must be an object of var name to value." };
        }
        const declared = Object.keys((spec as AgentSpec).vars ?? {});
        const unknown = Object.keys(vars).filter((name) => !declared.includes(name));
        if (unknown.length > 0) {
          reply.code(400);
          return {
            success: false,
            error:
              `${unknown.join(", ")} is not declared in the spec's vars` +
              (declared.length > 0 ? ` (declared: ${declared.join(", ")}).` : " (it has no vars)."),
          };
        }
      }

      try {
        // KAM-188: a replay answers from the recorded fixtures, so it needs no keys and touches no service.
        let replay;
        if (mode === "replay") {
          // A workflow that calls nothing outside itself has nothing to record: its replay reads no fixture at all.
          const dir =
            replayFixturesDirFor(specPath) ??
            (callsNothingOutside(spec as AgentSpec) ? defaultFixturesDir(specPath) : undefined);
          if (!dir) {
            reply.code(409);
            return {
              success: false,
              error: "There are no recorded fixtures to replay; run live, or record some first.",
            };
          }
          replay = await replayDepsFor(spec as AgentSpec, specPath, dir, runOptions?.env);
        }
        // KAN-1187: returns as soon as the run is registered and kicked off --
        // `state` here is always the untouched initial "running" snapshot, not
        // the first pause/terminal state. The canvas (or any client) opens
        // `/api/runs/:id/events` with this `id` right away and drives all
        // further UI off that SSE stream, which is what makes the very first
        // step_started event (and everything after it) actually observable.
        const { id, state } = await runManager.start(
          spec as AgentSpec,
          request.body.input,
          undefined,
          replay,
          vars,
        );
        return { success: true, id, state, mode };
      } catch (err) {
        // Covers KAN-1106: a missing/invalid BYOK env var (or an unconfigured
        // model) throws synchronously from createAgentRun, before any network
        // call -- surfaced here as a specific 400, never a generic 500, and
        // the message never contains the resolved key value (only its name).
        reply.code(400);
        return { success: false, error: (err as Error).message };
      }
    },
  );

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
