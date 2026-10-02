// No build step: plain DOM, driven by the real /events SSE stream relayed
// straight from the pipeline's own event bus (src/events.ts).

const incidentsEl = document.getElementById("incidents");
const emptyState = document.getElementById("empty-state");
const template = document.getElementById("incident-template");
const connectionDot = document.getElementById("connection-dot");
const statConnection = document.getElementById("stat-connection");
const statOpen = document.getElementById("stat-open");
const statResolved = document.getElementById("stat-resolved");

const incidents = new Map(); // incidentId -> { el, status }
let openCount = 0;
let resolvedCount = 0;

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

function setStep(card, step, state) {
  const el = card.querySelector(`[data-step="${step}"]`);
  if (el) el.dataset.state = state;
}

function setLine(card, line, state) {
  const el = card.querySelector(`[data-line="${line}"]`);
  if (el) el.dataset.state = state;
}

function addDetail(card, label, value, className) {
  const dl = card.querySelector(".incident-card__details");
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (className) dd.className = className;
  dd.innerHTML = value;
  row.append(dt, dd);
  dl.appendChild(row);
}

function ensureIncidentCard(incidentId, alertname, severity, at) {
  if (incidents.has(incidentId)) return incidents.get(incidentId);

  if (emptyState) emptyState.hidden = true;

  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".incident-card");
  card.dataset.status = "open";
  card.querySelector(".chip").textContent = severity;
  card.querySelector(".chip").dataset.severity = severity;
  card.querySelector(".incident-card__title").textContent = alertname;
  card.querySelector(".incident-card__time").textContent = formatTime(at);
  setStep(card, "alert", "done");

  incidentsEl.prepend(card);
  const record = { el: card, status: "open" };
  incidents.set(incidentId, record);

  openCount += 1;
  statOpen.textContent = String(openCount);
  return record;
}

function handleEvent(event) {
  switch (event.type) {
    case "alert_firing": {
      ensureIncidentCard(event.incident, event.alertname, event.severity, event.at);
      break;
    }

    case "alert_resolved": {
      const record = incidents.get(event.incident);
      if (record && record.status === "open") {
        record.status = "resolved";
        record.el.dataset.status = "resolved";
        openCount = Math.max(0, openCount - 1);
        resolvedCount += 1;
        statOpen.textContent = String(openCount);
        statResolved.textContent = String(resolvedCount);
      }
      break;
    }

    case "diagnosis_started": {
      const record = incidents.get(event.incident);
      if (record) setStep(record.el, "diagnosis", "active");
      break;
    }

    case "diagnosis_ready": {
      const record = incidents.get(event.incident);
      if (!record) break;
      setStep(record.el, "diagnosis", "done");
      setLine(record.el, "alert-diagnosis", "done");
      addDetail(record.el, "Diagnosis", escapeHtml(event.summary));
      addDetail(record.el, "Likely cause", escapeHtml(event.likelyCause));
      break;
    }

    case "proposal_posted": {
      const record = incidents.get(event.incident);
      if (!record) break;
      setStep(record.el, "proposal", "done");
      setLine(record.el, "diagnosis-proposal", "done");
      setStep(record.el, "decision", "active");
      addDetail(record.el, "Proposed fix", escapeHtml(event.proposedFix));
      break;
    }

    case "human_decision": {
      const record = incidents.get(event.incident);
      if (!record) break;
      setLine(record.el, "proposal-decision", "done");
      setStep(record.el, "decision", event.decision === "approved" ? "done" : "error");
      const who = event.by ? ` by @${escapeHtml(event.by)}` : "";
      addDetail(
        record.el,
        "Human decision",
        `${escapeHtml(event.decision)}${who} -- not auto-executed`,
        event.decision === "approved" ? "decision-approved" : "decision-rejected",
      );
      break;
    }

    case "incident_error": {
      const record = incidents.get(event.incident);
      if (!record) break;
      setStep(record.el, "diagnosis", "error");
      addDetail(record.el, "Error", escapeHtml(event.message));
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
