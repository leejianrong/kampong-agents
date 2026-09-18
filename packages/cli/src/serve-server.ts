import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { parseSpec, type AgentSpec, type SpecError } from "@kampong/spec";
import {
  isApproveAction,
  isRejectAction,
  parseSlackInteractionPayload,
  postInteractionUpdate,
  verifySlackSignature,
  type RunEvent,
} from "@kampong/engine";
import { RunManager, type RunManagerOptions } from "./run-manager.js";

// KAN-1431 (ADR-0021/ADR-0022): the server behind `kampong serve <spec>` -- the
// laptop/self-host path for a *live*, triggerable workflow. Unlike `kampong
// run` (execute once and exit) this stays running and starts a run per incoming
// webhook POST; unlike `kampong dev` it serves no canvas, no file watcher, no
// spec-CRUD -- just the trigger ingress and the run status/approval routes. The
// exact same engine + spec + connectors as every other mode; the only thing new
// is the persistent HTTP listener. Connector `${ENV}` tokens resolve from this
// process's environment (KAN-1430), so deploying is "run this with the tokens
// set" -- see the exporter's Dockerfile for the container form of that.
//
// Execution is on-demand (ADR-0022): a webhook event drives one run on this
// shared process; there is no always-on per-workflow worker.

export class ServeSpecInvalidError extends Error {
  constructor(public readonly errors: SpecError[]) {
    super(
      `The spec could not be parsed into a runnable AgentSpec:\n` +
        errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n"),
    );
    this.name = "ServeSpecInvalidError";
  }
}

export interface CreateServeServerOptions {
  specPath: string;
  /** Test seam forwarded to RunManager (fake model / fixtures). Production omits it. */
  run?: RunManagerOptions;
}

export function createServeServer({ specPath, run }: CreateServeServerOptions): FastifyInstance {
  const source = readFileSync(specPath, "utf8");
  const parsed = parseSpec(source);
  if (!parsed.success || !parsed.spec) {
    throw new ServeSpecInvalidError(parsed.errors);
  }
  const spec = parsed.spec as AgentSpec;

  // The trigger field is validated by the schema (only "webhook" today), so an
  // unsupported trigger already failed `parseSpec` above. A spec with no
  // trigger still serves -- the webhook is exposed regardless; the trigger
  // field documents intent, it isn't required to serve.

  const app = Fastify({ logger: false });
  // KAN-1432 (ADR-0021 Slice D): headless -- no canvas is ever attached to
  // `kampong serve` -- so every approval pause here should try to notify
  // Slack when the spec configures a target, unlike `kampong dev`'s canvas
  // server (server.ts), which never sets this.
  const runManager = new RunManager({ ...run, notifyApprovalsViaSlack: true });
  const slackFetchImpl = run?.slackFetchImpl;
  const env = run?.env ?? process.env;

  // Accept any non-JSON content type as a raw string body, so `curl -d "..."`
  // (which defaults to urlencoded) and text/plain both work; JSON bodies keep
  // Fastify's built-in object parsing.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  // POST /webhook -- the trigger. The request body becomes the run input (raw
  // string as-is; a JSON body is passed through as its JSON text). Returns the
  // run id immediately (on-demand execution, ADR-0022); the caller polls
  // /runs/:id or streams /runs/:id/events and resolves approvals via
  // /runs/:id/approve (Slack-button approval is a later slice).
  app.post("/webhook", async (request, reply) => {
    const input = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const { id, state } = await runManager.start(spec, input);
    return reply.code(201).send({ success: true, id, state });
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    const run = runManager.get(request.params.id);
    if (!run) {
      return reply
        .code(404)
        .send({ success: false, error: `Unknown run id "${request.params.id}".` });
    }
    return { success: true, state: run.getState() };
  });

  app.post<{ Params: { id: string }; Body: { approved?: boolean; reason?: string } }>(
    "/runs/:id/approve",
    async (request, reply) => {
      const { approved, reason } = request.body ?? {};
      if (typeof approved !== "boolean") {
        return reply
          .code(400)
          .send({ success: false, error: "`approved` (a boolean) is required." });
      }
      try {
        const state = await runManager.approve(request.params.id, approved, reason);
        if (state === undefined) {
          return reply
            .code(404)
            .send({ success: false, error: `Unknown run id "${request.params.id}".` });
        }
        return { success: true, state };
      } catch (err) {
        return reply.code(409).send({ success: false, error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/runs/:id/events", (request, reply) => {
    const run = runManager.get(request.params.id);
    if (!run) {
      reply.code(404).send({ success: false, error: `Unknown run id "${request.params.id}".` });
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

  // POST /slack/interactions -- KAN-1432 (ADR-0021 Slice D): Slack's
  // interactivity callback for the Approve/Reject buttons posted above.
  // The request body arrives as the raw `application/x-www-form-urlencoded`
  // string via the catch-all content-type parser registered above, which is
  // exactly what signature verification needs (the *exact* bytes Slack
  // signed, before any parsing). SLACK_SIGNING_SECRET is a fixed, well-known
  // env var name (not a spec-level `${ENV}` reference, unlike
  // approval_notifier.token) -- the whole deployed process has one Slack app,
  // one signing secret, regardless of which spec it's serving.
  app.post("/slack/interactions", async (request, reply) => {
    const signingSecret = env.SLACK_SIGNING_SECRET;
    const timestamp = request.headers["x-slack-request-timestamp"];
    const signature = request.headers["x-slack-signature"];
    const rawBody = typeof request.body === "string" ? request.body : "";

    if (
      !signingSecret ||
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !verifySlackSignature({ signingSecret, timestamp, rawBody, signature })
    ) {
      // Fails closed: a missing SLACK_SIGNING_SECRET is a configuration
      // error, not "trust anything" -- an unverified interaction must never
      // be allowed to resolve a run.
      return reply.code(401).send({ success: false, error: "Invalid Slack request signature." });
    }

    const interaction = parseSlackInteractionPayload(rawBody);
    if (!interaction) {
      return reply.code(400).send({ success: false, error: "Unrecognized interaction payload." });
    }

    const approved = isApproveAction(interaction.actionId);
    if (!approved && !isRejectAction(interaction.actionId)) {
      return reply.code(400).send({ success: false, error: "Unrecognized action." });
    }

    let outcomeText: string;
    try {
      const state = await runManager.approve(interaction.runId, approved);
      outcomeText =
        state === undefined
          ? `Run "${interaction.runId}" not found (it may have already finished).`
          : approved
            ? `Approved${interaction.userName ? ` by ${interaction.userName}` : ""}.`
            : `Rejected${interaction.userName ? ` by ${interaction.userName}` : ""}.`;
    } catch (err) {
      // The run had already moved past this approval (e.g. a second click,
      // or the same run resolved through /runs/:id/approve directly) --
      // acknowledge Slack without crashing, and say so in the message.
      outcomeText = `Could not apply this decision: ${(err as Error).message}`;
    }

    await postInteractionUpdate(interaction.responseUrl, outcomeText, slackFetchImpl).catch(
      (err: unknown) => {
        console.error(`Failed to update Slack message for run ${interaction.runId}:`, err);
      },
    );

    return reply.code(200).send();
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
