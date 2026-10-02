import express from "express";

const app = express();
app.use(express.json());

const VALID_MODES = new Set(["ok", "down", "high_latency", "high_errors"]);
let mode = "ok";
let changedAt = Date.now();

const RING_SIZE = 30;
const recentRequests = [];

function record(entry) {
  recentRequests.push(entry);
  if (recentRequests.length > RING_SIZE) recentRequests.shift();
}

/** Simulates one real unit of work under the current chaos mode -- a real
 * outcome (success/error/latency), not a canned response. */
function doWork() {
  const startedAt = Date.now();
  let latencyMs = 20 + Math.random() * 30;
  let error = false;

  if (mode === "down") {
    error = true;
  } else if (mode === "high_latency") {
    latencyMs = 600 + Math.random() * 400;
  } else if (mode === "high_errors") {
    error = Math.random() < 0.45;
  }

  const entry = { at: startedAt, latencyMs: Math.round(latencyMs), error };
  record(entry);
  return entry;
}

// Real, continuous background traffic -- so metrics reflect genuine ongoing
// activity, not just whatever this demo's own agent happens to poll.
setInterval(doWork, 1000);

app.get("/health", (_req, res) => {
  if (mode === "down") {
    res.status(503).json({ ok: false, mode });
    return;
  }
  res.json({ ok: true, mode });
});

app.get("/work", (_req, res) => {
  const entry = doWork();
  if (entry.error) {
    res.status(500).json({ error: "simulated failure", mode });
    return;
  }
  res.json({ ok: true, latencyMs: entry.latencyMs });
});

app.get("/debug", (_req, res) => {
  res.json({ mode, changedAt, recentRequests });
});

app.post("/chaos/:mode", (req, res) => {
  const requested = req.params.mode;
  if (!VALID_MODES.has(requested)) {
    res.status(400).json({ error: `unknown mode "${requested}"`, validModes: [...VALID_MODES] });
    return;
  }
  mode = requested;
  changedAt = Date.now();
  console.log(`[toy-service] real chaos mode change -> ${mode}`);
  res.json({ ok: true, mode });
});

app.get("/metrics", (_req, res) => {
  const window = recentRequests.slice(-10);
  const errorRate = window.length > 0 ? window.filter((r) => r.error).length / window.length : 0;
  const avgLatencyMs =
    window.length > 0 ? window.reduce((sum, r) => sum + r.latencyMs, 0) / window.length : 0;
  const up = mode === "down" ? 0 : 1;

  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(
    [
      "# HELP toy_up Whether the toy service currently considers itself healthy.",
      "# TYPE toy_up gauge",
      `toy_up ${up}`,
      "# HELP toy_error_rate Fraction of the last 10 simulated requests that errored.",
      "# TYPE toy_error_rate gauge",
      `toy_error_rate ${errorRate.toFixed(3)}`,
      "# HELP toy_latency_ms Average latency (ms) of the last 10 simulated requests.",
      "# TYPE toy_latency_ms gauge",
      `toy_latency_ms ${avgLatencyMs.toFixed(1)}`,
      "",
    ].join("\n"),
  );
});

const port = process.env.PORT ?? 9100;
app.listen(port, () => {
  console.log(`toy-service listening on ${port} (mode: ${mode})`);
});
