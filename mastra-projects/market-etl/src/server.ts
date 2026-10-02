import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import FastifyStatic from "@fastify/static";
import { runEtl } from "./pipeline.js";
import { onEtlEvent, recentEtlEvents } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8791);
const RUN_INTERVAL_MS = Number(process.env.RUN_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

const app = Fastify({ logger: true });

await app.register(FastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

let running = false;

async function triggerRun(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runEtl();
  } catch (err) {
    app.log.error({ err }, "ETL run failed");
  } finally {
    running = false;
  }
}

app.post("/run", async (_req, reply) => {
  if (running) {
    reply.code(409).send({ error: "a run is already in progress" });
    return;
  }
  reply.code(202).send({ accepted: true });
  triggerRun();
});

app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of recentEtlEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = onEtlEvent((event) => {
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
  app.log.info(`market-etl listening on ${address}`);
});

// Real scheduled job, not just a manually-triggered script -- Alpha
// Vantage's free tier (25 requests/day) is the real reason this defaults
// to every 6 hours rather than something tighter: 3 symbols x 4 runs/day
// stays comfortably under the daily cap. `POST /run` (wired to the
// dashboard's "Run now" button) exists for on-demand real runs without
// waiting for the schedule.
setInterval(() => {
  triggerRun().catch((err) => app.log.error({ err }, "scheduled ETL run failed"));
}, RUN_INTERVAL_MS);
