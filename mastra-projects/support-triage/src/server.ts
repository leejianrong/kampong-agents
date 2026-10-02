import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import FastifyStatic from "@fastify/static";
import { pollInbox, resolveEscalation, getPendingTicket } from "./pipeline.js";
import {
  isApproveAction,
  isRejectAction,
  parseSlackInteractionPayload,
  postInteractionUpdate,
  verifySlackSignature,
} from "./slack-approval.js";
import { emitTriageEvent, onTriageEvent, recentTriageEvents } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8789);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

if (!SLACK_SIGNING_SECRET) {
  throw new Error("SLACK_SIGNING_SECRET is not set (see .env.example).");
}

const app = Fastify({ logger: true });

await app.register(FastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, body);
});

// smee.io re-sends Slack's form-encoded click as JSON ({ payload }), destroying the
// exact bytes Slack signed. Rebuild them the way Slack encodes (RFC 3986 strict,
// spaces as "+"); the HMAC is still fully verified against the rebuilt body.
function recoverSlackRawBody(body: unknown): string {
  if (typeof body === "string") return body;
  const payload = (body as { payload?: unknown } | null)?.payload;
  if (typeof payload !== "string") return "";
  const strict = encodeURIComponent(payload).replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return "payload=" + strict.replace(/%20/g, "+");
}

app.post("/slack/interactions", async (req, reply) => {
  const rawBody = recoverSlackRawBody(req.body);
  const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
  const signature = req.headers["x-slack-signature"] as string | undefined;

  if (
    !timestamp ||
    !signature ||
    !verifySlackSignature({ signingSecret: SLACK_SIGNING_SECRET, timestamp, rawBody, signature })
  ) {
    req.log.warn("rejected slack interaction: bad or missing signature");
    reply.code(401).send({ error: "invalid signature" });
    return;
  }

  const interaction = parseSlackInteractionPayload(rawBody);
  reply.code(200).send({ ok: true });
  if (!interaction) return;

  const pending = getPendingTicket(interaction.ticketId);
  const decision = isApproveAction(interaction.actionId)
    ? "approved"
    : isRejectAction(interaction.actionId)
      ? "rejected"
      : undefined;
  if (!decision) return;

  emitTriageEvent({
    type: "human_decision",
    ticket: interaction.ticketId,
    decision,
    by: interaction.userName,
    at: Date.now(),
  });

  await resolveEscalation(interaction.ticketId, decision).catch((err) => {
    req.log.error({ err }, "failed to resolve escalation");
  });

  const subject = pending?.subject ?? interaction.ticketId;
  const label = decision === "approved" ? "approved -- real Gmail draft created" : "rejected -- no draft created";
  await postInteractionUpdate(
    interaction.responseUrl,
    `Ticket "${subject}": ${label}, by ${interaction.userName ?? "someone"}.`,
  );
});

app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of recentTriageEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = onTriageEvent((event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.raw.on("close", unsubscribe);
});

app.get("/healthz", async () => ({ ok: true }));

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`support-triage listening on ${address}`);
});

function poll(): void {
  pollInbox().catch((err) => {
    app.log.error({ err }, "inbox poll failed");
  });
}

// Real IMAP polling, not push -- Gmail has no free/simple inbound-webhook
// equivalent to GitHub's or Slack's for a plain consumer inbox (Gmail's
// push-notification API needs a Google Cloud Pub/Sub topic + domain-wide
// delegation, real infra this discovery demo doesn't need). Polling every
// POLL_INTERVAL_MS is the real, honest mechanism here.
poll();
setInterval(poll, POLL_INTERVAL_MS);
