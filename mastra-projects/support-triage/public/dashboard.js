// No build step: plain DOM, driven by the real /events SSE stream relayed
// straight from the pipeline's own event bus (src/events.ts).

const template = document.getElementById("ticket-template");
const emptyState = document.getElementById("empty-state");
const connectionDot = document.getElementById("connection-dot");
const statConnection = document.getElementById("stat-connection");
const statReceived = document.getElementById("stat-received");
const statDrafted = document.getElementById("stat-drafted");
const statEscalated = document.getElementById("stat-escalated");

const columns = {
  inbox: document.getElementById("column-inbox"),
  classifying: document.getElementById("column-classifying"),
  escalated: document.getElementById("column-escalated"),
  done: document.getElementById("column-done"),
};

const tickets = new Map(); // ticketId -> { el, column }
let receivedCount = 0;
let draftedCount = 0;
let escalatedCount = 0;

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

function moveToColumn(record, column) {
  record.column = column;
  record.el.dataset.moving = "true";
  columns[column].prepend(record.el);
  setTimeout(() => delete record.el.dataset.moving, 250);
}

function ensureTicketCard(ticketId, from, subject, at) {
  if (tickets.has(ticketId)) return tickets.get(ticketId);

  if (emptyState) emptyState.hidden = true;

  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".ticket-card");
  card.querySelector(".ticket-card__time").textContent = formatTime(at);
  card.querySelector(".ticket-card__subject").textContent = subject;
  card.querySelector(".ticket-card__from").textContent = from;

  columns.inbox.prepend(card);
  const record = { el: card, column: "inbox" };
  tickets.set(ticketId, record);

  receivedCount += 1;
  statReceived.textContent = String(receivedCount);
  return record;
}

function setNote(card, text, tone) {
  const note = card.querySelector(".ticket-card__note");
  note.textContent = text;
  note.hidden = false;
  if (tone) note.dataset.tone = tone;
}

function handleEvent(event) {
  switch (event.type) {
    case "ticket_received": {
      ensureTicketCard(event.ticket, event.from, event.subject, event.at);
      break;
    }

    case "classification_started": {
      const record = tickets.get(event.ticket);
      if (record) moveToColumn(record, "classifying");
      break;
    }

    case "classification_ready": {
      const record = tickets.get(event.ticket);
      if (!record) break;
      const chip = record.el.querySelector(".chip");
      chip.hidden = false;
      chip.textContent = `${event.category} · ${event.confidence.toFixed(2)}`;
      chip.dataset.confidence = event.confidence >= 0.7 ? "high" : "low";
      break;
    }

    case "draft_created": {
      const record = tickets.get(event.ticket);
      if (!record) break;
      moveToColumn(record, "done");
      setNote(record.el, "Real Gmail draft created.", "draft");
      draftedCount += 1;
      statDrafted.textContent = String(draftedCount);
      break;
    }

    case "escalation_posted": {
      const record = tickets.get(event.ticket);
      if (!record) break;
      moveToColumn(record, "escalated");
      setNote(record.el, `Escalated: ${event.reason}`, "escalated");
      escalatedCount += 1;
      statEscalated.textContent = String(escalatedCount);
      break;
    }

    case "human_decision": {
      const record = tickets.get(event.ticket);
      if (!record) break;
      const who = event.by ? ` by @${escapeHtml(event.by)}` : "";
      if (event.decision === "rejected") {
        moveToColumn(record, "done");
        setNote(record.el, `Rejected${who} — no draft created.`, "rejected");
      } else {
        setNote(record.el, `Approved${who} — creating real Gmail draft…`, "draft");
      }
      break;
    }

    case "ticket_error": {
      const record = tickets.get(event.ticket);
      if (!record) break;
      setNote(record.el, `Error: ${escapeHtml(event.message)}`, "error");
      break;
    }
  }
}

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
