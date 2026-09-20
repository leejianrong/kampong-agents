import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import FastifyStatic from "@fastify/static";
import type { AlertmanagerWebhookPayload } from "./pipeline.js";
import { handleAlertmanagerWebhook, getOpenIncident } from "./pipeline.js";
import {
  isApproveAction,
  isRejectAction,
  parseSlackInteractionPayload,
  postInteractionUpdate,
  verifySlackSignature,
} from "./slack-approval.js";
import { emitIncidentEvent, onIncidentEvent, recentIncidentEvents } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8788);
const ALERTMANAGER_TOKEN = process.env.ALERTMANAGER_WEBHOOK_TOKEN ?? "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

if (!ALERTMANAGER_TOKEN) {
  throw new Error("ALERTMANAGER_WEBHOOK_TOKEN is not set (see .env.example).");
}
if (!SLACK_SIGNING_SECRET) {
  throw new Error("SLACK_SIGNING_SECRET is not set (see .env.example).");
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

const app = Fastify({ logger: true });

await app.register(FastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, body);
});

app.post("/alertmanager-webhook", async (req, reply) => {
  const auth = req.headers.authorization ?? "";
  if (!safeEqual(auth, `Bearer ${ALERTMANAGER_TOKEN}`)) {
    req.log.warn("rejected alertmanager webhook: bad or missing bearer token");
    reply.code(401).send({ error: "invalid token" });
    return;
  }

  const payload = req.body as AlertmanagerWebhookPayload;
  reply.code(202).send({ accepted: true, alerts: payload.alerts?.length ?? 0 });

  // Ack Alertmanager fast; the real diagnosis can take as long as a real
  // LLM call plus a real Slack post need.
  handleAlertmanagerWebhook(payload).catch((err) => {
    req.log.error({ err }, "incident handling failed");
  });
});

app.post("/slack/interactions", async (req, reply) => {
  const rawBody = req.body as string;
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

  const incident = getOpenIncident(interaction.incidentId);
  const decision = isApproveAction(interaction.actionId)
    ? "approved"
    : isRejectAction(interaction.actionId)
      ? "rejected"
      : undefined;
  if (!decision) return;

  emitIncidentEvent({
    type: "human_decision",
    incident: interaction.incidentId,
    decision,
    by: interaction.userName,
    at: Date.now(),
  });

  const alertname = incident?.alertname ?? interaction.incidentId;
  const label = decision === "approved" ? "approved -- not auto-executed, see README" : "rejected";
  await postInteractionUpdate(
    interaction.responseUrl,
    `Incident ${alertname}: ${label} by ${interaction.userName ?? "someone"}.`,
  );
});

app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of recentIncidentEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = onIncidentEvent((event) => {
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
  app.log.info(`incident-responder listening on ${address}`);
});
