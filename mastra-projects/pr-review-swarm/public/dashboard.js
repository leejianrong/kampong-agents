// No build step: plain DOM, driven by the real /events SSE stream the
// server relays straight from the pipeline's own event bus (src/events.ts).

const SPECIALIST_NODE_ID = {
  security: "node-security",
  style: "node-style",
  "test-coverage": "node-test-coverage",
};
const SPECIALIST_BADGE_ID = {
  security: "badge-security",
  style: "badge-style",
  "test-coverage": "badge-test-coverage",
};
const SPECIALIST_LINE_IN = {
  security: "line-planner-security",
  style: "line-planner-style",
  "test-coverage": "line-planner-testcov",
};
const SPECIALIST_LINE_OUT = {
  security: "line-security-merge",
  style: "line-style-merge",
  "test-coverage": "line-testcov-merge",
};
const ALL_SPECIALISTS = Object.keys(SPECIALIST_NODE_ID);

const feedEl = document.getElementById("feed");
const swarmPrEl = document.getElementById("swarm-pr");
const connectionDot = document.getElementById("connection-dot");
const statConnection = document.getElementById("stat-connection");
const statReviewed = document.getElementById("stat-reviewed");
const statAvg = document.getElementById("stat-avg");

const plannerNode = document.getElementById("node-planner");
const mergeNode = document.getElementById("node-merge");

let activePr = null;
let reviewedCount = 0;
let specialistTotal = 0;
let feedHasEntries = false;

function el(id) {
  return document.getElementById(id);
}

function setNodeState(node, state) {
  if (state === null) {
    node.removeAttribute("data-state");
  } else {
    node.dataset.state = state;
  }
}

function setLineFlow(id, flowing) {
  const line = el(id);
  if (!line) return;
  if (flowing) line.dataset.flow = "true";
  else line.removeAttribute("data-flow");
}

function resetSwarm() {
  setNodeState(plannerNode, null);
  setNodeState(mergeNode, null);
  for (const specialist of ALL_SPECIALISTS) {
    setNodeState(el(SPECIALIST_NODE_ID[specialist]), null);
    el(SPECIALIST_BADGE_ID[specialist]).hidden = true;
    setLineFlow(SPECIALIST_LINE_IN[specialist], false);
    setLineFlow(SPECIALIST_LINE_OUT[specialist], false);
  }
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function addFeedEntry(text, { error = false, at = Date.now() } = {}) {
  if (!feedHasEntries) {
    feedEl.replaceChildren();
    feedHasEntries = true;
  }
  const li = document.createElement("li");
  li.className = "feed-entry" + (error ? " feed-entry--error" : "");
  li.innerHTML = `<span class="feed-entry__time">${formatTime(at)}</span><span class="feed-entry__text">${text}</span>`;
  feedEl.appendChild(li);
  while (feedEl.children.length > 60) {
    feedEl.removeChild(feedEl.firstChild);
  }
}

function handleEvent(event) {
  if (event.pr !== activePr) {
    activePr = event.pr;
    resetSwarm();
  }
  swarmPrEl.textContent = activePr;

  switch (event.type) {
    case "webhook_received":
      setNodeState(plannerNode, "active");
      addFeedEntry(`<strong>${escapeHtml(event.pr)}</strong> real webhook received`, event);
      break;

    case "planner_routed": {
      setNodeState(plannerNode, "done");
      for (const specialist of ALL_SPECIALISTS) {
        const routed = event.specialists.includes(specialist);
        setNodeState(el(SPECIALIST_NODE_ID[specialist]), routed ? "active" : "skipped");
        setLineFlow(SPECIALIST_LINE_IN[specialist], routed);
      }
      const list = event.specialists.length > 0 ? event.specialists.join(", ") : "none";
      addFeedEntry(`<strong>${escapeHtml(event.pr)}</strong> planner routed to: ${escapeHtml(list)}`, event);
      break;
    }

    case "specialist_verdict": {
      const node = el(SPECIALIST_NODE_ID[event.specialist]);
      if (node) setNodeState(node, "done");
      setLineFlow(SPECIALIST_LINE_OUT[event.specialist], true);
      const badge = el(SPECIALIST_BADGE_ID[event.specialist]);
      if (badge) {
        badge.hidden = false;
        badge.textContent = event.findings === 1 ? "1 finding" : `${event.findings} findings`;
      }
      specialistTotal += 1;
      addFeedEntry(
        `<strong>${escapeHtml(event.pr)}</strong> ${escapeHtml(event.specialist)} verdict: ${event.findings} finding(s)`,
        event,
      );
      break;
    }

    case "comment_posted":
      setNodeState(mergeNode, "done");
      for (const specialist of ALL_SPECIALISTS) {
        setLineFlow(SPECIALIST_LINE_OUT[specialist], false);
      }
      reviewedCount += 1;
      statReviewed.textContent = String(reviewedCount);
      statAvg.textContent = reviewedCount > 0 ? (specialistTotal / reviewedCount).toFixed(1) : "—";
      addFeedEntry(`<strong>${escapeHtml(event.pr)}</strong> real review comment posted`, event);
      break;

    case "review_error":
      setNodeState(plannerNode, "error");
      setNodeState(mergeNode, "error");
      addFeedEntry(`<strong>${escapeHtml(event.pr)}</strong> failed: ${escapeHtml(event.message)}`, {
        ...event,
        error: true,
      });
      break;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
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

feedEl.innerHTML = '<li class="feed-empty">No real events yet -- open a PR against the sandbox repo.</li>';
connect();
