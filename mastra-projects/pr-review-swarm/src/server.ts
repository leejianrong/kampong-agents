import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import FastifyStatic from "@fastify/static";
import { verifyGithubSignature } from "./webhook-signature.js";
import { reviewPullRequest } from "./pipeline.js";
import { emitSwarmEvent, onSwarmEvent, recentSwarmEvents } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const SANDBOX_REPO = process.env.SANDBOX_REPO ?? "";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

if (!WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is not set (see .env.example).");
}

const app = Fastify({ logger: true });

await app.register(FastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

// Capture the raw body so the real HMAC signature can be verified against
// exactly what GitHub sent, before Fastify's JSON parser touches it.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  done(null, body);
});

app.post("/webhook", async (req, reply) => {
  const rawBody = req.body as string;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifyGithubSignature(rawBody, signature, WEBHOOK_SECRET)) {
    req.log.warn("rejected webhook delivery: bad or missing signature");
    reply.code(401).send({ error: "invalid signature" });
    return;
  }

  const event = req.headers["x-github-event"] as string | undefined;
  const payload = JSON.parse(rawBody);

  if (event !== "pull_request" || !["opened", "synchronize", "reopened"].includes(payload.action)) {
    reply.code(202).send({ ignored: true });
    return;
  }

  const [owner, repo] = (SANDBOX_REPO || `${payload.repository.owner.login}/${payload.repository.name}`).split(
    "/",
  );
  const number = payload.pull_request.number as number;
  const label = `${owner}/${repo}#${number}`;

  emitSwarmEvent({ type: "webhook_received", pr: label, at: Date.now() });
  reply.code(202).send({ accepted: true, owner, repo, number });

  // Run after replying -- GitHub expects a fast ack, the real review can
  // take as long as three real LLM calls need.
  reviewPullRequest(owner!, repo!, number).catch((err) => {
    req.log.error({ err }, `review failed for ${label}`);
  });
});

// The dashboard's live feed. Sends the ring buffer first so a page opened
// mid-run isn't starting blank, then streams new events as they happen.
app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of recentSwarmEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = onSwarmEvent((event) => {
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
  app.log.info(`pr-review-swarm listening on ${address}`);
});
