# incident-responder

Slice 2 of the `mastra-projects/` discovery initiative (see the root
`PLAN.md`/`SLICES.md`/`docs/adr/`). A real alert fires against a real,
self-hosted Prometheus + Alertmanager stack monitoring a small real toy
service; a Mastra agent diagnoses it against the toy service's real live
state and posts a real, specific proposed fix to Slack for a real human
decision. The agent never executes anything itself (ADR-0004) — automated
execution is a named stretch goal, not built here.

## Architecture

```
toy-service (real, breakable) --scraped by--> Prometheus --alert fires--> Alertmanager
                                                                                |
                                                                     real webhook (bearer auth)
                                                                                |
                                                                     POST /alertmanager-webhook
                                                                                |
                                                                   fetch toy-service's real /debug
                                                                                |
                                                                        diagnostician agent
                                                                                |
                                                              real Slack message, Approve/Reject buttons
                                                                                |
                                                        human clicks --(real interaction callback)--> /slack/interactions
                                                                                |
                                                                 recorded as a real decision -- nothing executes
```

## Setup

1. `npm install`
2. `npm run stack:up` — builds and starts the real toy-service + Prometheus
   + Alertmanager via docker-compose. `docker compose logs -f` to watch it.
3. `cp .env.example .env` and fill in:
   - `OPENROUTER_API_KEY` — real BYOK OpenRouter key.
   - `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` — a real Slack app with
     `chat:write`, and the real channel to post to. Reusing the same app
     from `pr-review-swarm`/kampong-agents' own KAN-1432 testing is fine for
     posting messages, but its **Interactivity Request URL is a single
     shared setting on that app** — pointing it at this demo's smee channel
     means it's not simultaneously available for kampong-agents' own
     product testing. Use a second Slack app if you need both at once.
   - `SLACK_SIGNING_SECRET` — from that Slack app's Basic Information page.
   - `ALERTMANAGER_WEBHOOK_TOKEN` — a real value is already pre-filled,
     matching `alertmanager/alertmanager.yml`; only change both together.
4. In your Slack app's settings, turn on Interactivity and set its Request
   URL to `SMEE_SLACK_URL`'s value (a real channel is already pre-filled).
5. In one terminal: `npm run forward:slack` (relays Slack's real
   interaction callbacks to your local `/slack/interactions`).
6. In another terminal: `npm run dev`.
7. Open `http://localhost:8788` for the dashboard, then trigger a real
   incident: `npm run chaos -- down` (or `high_latency` / `high_errors`,
   and `ok` to clear it). Within ~15–20s (Prometheus's real `for: 10s`
   plus its scrape interval) a real alert fires.

## Dashboard

Each real incident gets its own live card at `http://localhost:8788`: a
4-step tracker (alert fired → diagnosed → proposed → human decision) that
lights up as the real chain progresses, plus the actual diagnosis, likely
cause, proposed fix, and who approved/rejected it — all driven by a real
`/events` SSE stream (ADR-0006), sharing `pr-review-swarm/`'s
`public/tokens.css` visual identity verbatim.

## Gap-analysis (kampong-agents `AgentSpec` fit)

- **Confirmed real friction:** Alertmanager's webhook receiver has no
  built-in request-signing scheme the way GitHub's and Slack's do — there's
  no HMAC signature to verify. The realistic equivalent is a bearer token in
  `http_config.authorization` (which Alertmanager does support), which is
  what this demo does — weaker than HMAC (a leaked token is directly
  reusable, no per-request signing), but still a real auth check, not
  nothing. Worth a note if kampong-agents' own webhook ingress (KAN-1436)
  ever documents "how to secure your inbound webhook" per source system —
  not every real system offers the same signing guarantees.
- **Confirmed real friction:** reusing one Slack app's bot token across two
  `mastra-projects` demos (and potentially kampong-agents' own product
  testing) works fine for posting messages, but its single Interactivity
  Request URL can only point at one place at a time. A real product
  supporting multiple concurrent Slack-HITL workflows would need either
  per-workflow Slack apps or a router in front of one shared Interactivity
  endpoint that dispatches by payload contents — kampong-agents' own
  hosted mode (V5) will hit this for real with multiple tenants sharing
  infrastructure.
- **Open, the real question this slice exists to answer:** kampong's
  `AgentSpec` guardrail/HITL model (from KAN-1432) is built around *pausing
  a run* for approval. This demo's HITL is different in shape: there's no
  "run" to pause — diagnosis and proposal already completed by the time a
  human sees anything, and the approval is a record of a decision, not a
  gate the pipeline blocks on. Whether kampong's existing HITL primitive
  actually covers "notify and record a decision after the fact" or only
  "pause and wait" is a real schema question, not just a wording one.
- **Also open:** `src/pipeline.ts`'s `openIncidents` map is in-memory only —
  a real restart during an open incident loses the Slack correlation. Fine
  for a discovery demo; a real product would need this persisted, which is
  itself a data point about what kampong's execution model needs for any
  workflow that spans more than one process lifetime.
- **TODO once a few real chaos scenarios have run through this:** does the
  diagnostician's proposed fix stay concrete and actionable across all three
  chaos modes, or does it get vague under `high_latency` specifically (no
  hard failure to point at, just a real drifting number).
