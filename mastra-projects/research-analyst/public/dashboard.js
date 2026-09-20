// No build step: plain DOM, driven by the real /events SSE stream relayed
// straight from the pipeline's own event bus (src/events.ts), plus a direct
// fetch() for the asker's own request/response turn.

const form = document.getElementById("ask-form");
const input = document.getElementById("question-input");
const button = document.getElementById("ask-button");
const answerPanel = document.getElementById("answer-panel");
const answerText = document.getElementById("answer-text");
const answerCitations = document.getElementById("answer-citations");
const emptyState = document.getElementById("empty-state");
const traceList = document.getElementById("trace-list");
const traceTemplate = document.getElementById("trace-template");
const chunkTemplate = document.getElementById("chunk-template");
const connectionDot = document.getElementById("connection-dot");

const traces = new Map(); // queryId -> element

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

function renderCitationChips(container, paths) {
  container.innerHTML = "";
  for (const path of paths) {
    const chip = document.createElement("span");
    chip.className = "citation-chip";
    chip.textContent = path;
    container.appendChild(chip);
  }
}

function setStep(card, step, state) {
  const el = card.querySelector(`[data-step="${step}"]`);
  if (el) el.dataset.state = state;
}

function setLine(card, line, state) {
  const el = card.querySelector(`[data-line="${line}"]`);
  if (el) el.dataset.state = state;
}

function ensureTraceCard(queryId, question, at) {
  if (traces.has(queryId)) return traces.get(queryId);

  if (emptyState) emptyState.hidden = true;

  const fragment = traceTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".trace-card");
  card.querySelector(".trace-card__question").textContent = question;
  card.querySelector(".trace-card__time").textContent = formatTime(at);
  setStep(card, "embed", "done");

  traceList.prepend(card);
  traces.set(queryId, card);
  return card;
}

function handleEvent(event) {
  switch (event.type) {
    case "query_received": {
      ensureTraceCard(event.query, event.question, event.at);
      break;
    }

    case "chunks_retrieved": {
      const card = traces.get(event.query);
      if (!card) break;
      setStep(card, "retrieve", "done");
      setLine(card, "embed-retrieve", "done");
      const chunkList = card.querySelector(".chunk-list");
      for (const chunk of event.chunks) {
        const chip = chunkTemplate.content.cloneNode(true);
        chip.querySelector(".chunk-chip__path").textContent = chunk.document_path;
        chip.querySelector(".chunk-chip__similarity").textContent = chunk.similarity.toFixed(2);
        chunkList.appendChild(chip);
      }
      break;
    }

    case "answer_ready": {
      const card = traces.get(event.query);
      if (!card) break;
      setStep(card, "answer", "done");
      setLine(card, "retrieve-answer", "done");
      const answerEl = card.querySelector(".trace-card__answer");
      answerEl.textContent = event.answer;
      answerEl.hidden = false;
      renderCitationChips(card.querySelector(".citation-row"), event.citedPaths);
      break;
    }

    case "query_error": {
      const card = traces.get(event.query);
      if (!card) break;
      setStep(card, "retrieve", "error");
      const answerEl = card.querySelector(".trace-card__answer");
      answerEl.textContent = `Error: ${escapeHtml(event.message)}`;
      answerEl.hidden = false;
      break;
    }
  }
}

form.addEventListener("submit", async (submitEvent) => {
  submitEvent.preventDefault();
  const question = input.value.trim();
  if (!question) return;

  button.disabled = true;
  answerPanel.hidden = true;
  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);

    answerText.textContent = body.answer;
    renderCitationChips(answerCitations, body.citedPaths ?? []);
    answerPanel.hidden = false;
    input.value = "";
  } catch (err) {
    answerText.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    renderCitationChips(answerCitations, []);
    answerPanel.hidden = false;
  } finally {
    button.disabled = false;
  }
});

function connect() {
  const source = new EventSource("/events");

  source.onopen = () => {
    connectionDot.dataset.live = "true";
  };

  source.onerror = () => {
    connectionDot.removeAttribute("data-live");
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
