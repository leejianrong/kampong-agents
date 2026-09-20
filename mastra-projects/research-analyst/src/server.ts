import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import FastifyStatic from "@fastify/static";
import { z } from "zod";
import { ask } from "./pipeline.js";
import { onResearchEvent, recentResearchEvents } from "./events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8790);

const app = Fastify({ logger: true });

await app.register(FastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

const askBodySchema = z.object({ question: z.string().min(1) });

app.post("/ask", async (req, reply) => {
  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400).send({ error: "question is required" });
    return;
  }

  try {
    const result = await ask(parsed.data.question);
    reply.send(result);
  } catch (err) {
    req.log.error({ err }, "query failed");
    reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const event of recentResearchEvents()) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = onResearchEvent((event) => {
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
  app.log.info(`research-analyst listening on ${address}`);
});
