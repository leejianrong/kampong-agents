// No build step: plain DOM, driven by the real /events SSE stream relayed
// straight from the pipeline's own event bus (src/events.ts).

const runsEl = document.getElementById("runs");
const emptyState = document.getElementById("empty-state");
const runTemplate = document.getElementById("run-template");
const symbolTemplate = document.getElementById("symbol-template");
const anomalyTemplate = document.getElementById("anomaly-template");
const anomalyList = document.getElementById("anomaly-list");
const connectionDot = document.getElementById("connection-dot");
const statConnection = document.getElementById("stat-connection");
const statRuns = document.getElementById("stat-runs");
const statAnomalies = document.getElementById("stat-anomalies");
const runButton = document.getElementById("run-button");

const runs = new Map(); // runId -> { el, symbolLanes: Map<symbol, el> }
let runCount = 0;
let anomalyCount = 0;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function setStep(lane, step, state) {
  const el = lane.querySelector(`[data-step="${step}"]`);
  if (el) el.dataset.state = state;
}

function setLine(lane, line, state) {
  const el = lane.querySelector(`[data-line="${line}"]`);
  if (el) el.dataset.state = state;
}

function ensureRun(runId, symbols, at) {
  if (runs.has(runId)) return runs.get(runId);
  if (emptyState) emptyState.hidden = true;

  const fragment = runTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".run-card");
  card.querySelector(".run-card__time").textContent = formatTime(at);

  const strip = card.querySelector(".ingestion-strip");
  const symbolLanes = new Map();
  for (const symbol of symbols) {
    const laneFragment = symbolTemplate.content.cloneNode(true);
    const lane = laneFragment.querySelector(".symbol-lane");
    lane.querySelector(".symbol-lane__symbol").textContent = symbol;
    strip.appendChild(lane);
    symbolLanes.set(symbol, lane);
  }

  runsEl.prepend(card);
  const record = { el: card, symbolLanes };
  runs.set(runId, record);

  runCount += 1;
  statRuns.textContent = String(runCount);
  return record;
}

function addAnomalyCard(symbol, summary, at) {
  const fragment = anomalyTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".anomaly-card");
  card.querySelector(".chip").textContent = symbol;
  card.querySelector(".anomaly-card__time").textContent = formatTime(at);
  card.querySelector("p").textContent = summary;
  anomalyList.prepend(card);

  anomalyCount += 1;
  statAnomalies.textContent = String(anomalyCount);
}

function handleEvent(event) {
  switch (event.type) {
    case "run_started": {
      ensureRun(event.run, event.symbols, event.at);
      break;
    }

    case "symbol_pulled": {
      const record = runs.get(event.run);
      const lane = record?.symbolLanes.get(event.symbol);
      if (!lane) break;
      setStep(lane, "pull", "done");
      lane.querySelector(".symbol-lane__detail").textContent = `close ${event.close}`;
      break;
    }

    case "symbol_validated": {
      const record = runs.get(event.run);
      const lane = record?.symbolLanes.get(event.symbol);
      if (!lane) break;
      setStep(lane, "validate", "done");
      setLine(lane, "pull-validate", "done");
      lane.querySelector(".symbol-lane__detail").textContent = `${event.change >= 0 ? "+" : ""}${event.change.toFixed(2)}%`;
      break;
    }

    case "anomaly_flagged": {
      const record = runs.get(event.run);
      const lane = record?.symbolLanes.get(event.symbol);
      if (lane) {
        setStep(lane, "flag", "flagged");
        setLine(lane, "validate-flag", "done");
      }
      addAnomalyCard(event.symbol, event.summary, event.at);
      break;
    }

    case "symbol_error": {
      const record = runs.get(event.run);
      const lane = record?.symbolLanes.get(event.symbol);
      if (!lane) break;
      setStep(lane, "pull", "error");
      lane.querySelector(".symbol-lane__detail").textContent = `Error: ${escapeHtml(event.message)}`;
      break;
    }

    case "run_completed": {
      const record = runs.get(event.run);
      if (!record) break;
      for (const lane of record.symbolLanes.values()) {
        const flagStep = lane.querySelector('[data-step="flag"]');
        if (!flagStep.dataset.state) {
          setStep(lane, "flag", "done");
          setLine(lane, "validate-flag", "done");
        }
      }
      break;
    }
  }
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  try {
    await fetch("/run", { method: "POST" });
  } finally {
    setTimeout(() => {
      runButton.disabled = false;
    }, 2000);
  }
});

function connect() {
  const source = new EventSource("/events");

  source.onopen = () => {
    connectionDot.dataset.live = "true";
    statConnection.textContent = "Live";
  };

  source.onerror = () => {
    connectionDot.removeAttribute("data-live");
    statConnection.textContent = "Reconnecting…";
  };

  source.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      // A malformed event is a server bug, not something the dashboard
      // should crash over -- drop it and keep listening.
    }
  };
}

connect();
