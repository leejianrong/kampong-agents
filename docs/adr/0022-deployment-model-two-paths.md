# ADR-0022: Deployment model — two paths, one foundation, on-demand execution

- Status: Accepted
- Date: 2026-09-16
- Deciders: Jian (product owner)

## Context

V9 (ADR-0021) makes a single-agent workflow real: it can be triggered by an event, call real apps
(Slack/Gmail connectors), pause for a human, and act. That raises the obvious next question: once a
user finishes authoring, how do they take it live? A planning discussion (2026-09-16) surfaced that
"deployable" means two different things to the two personas (PLAN.md §Users), and that we should not
conflate either with the V5 multi-tenant hosting stack.

## Decision

### 1. Two deploy paths, one shared foundation

The trigger / execution / connector primitives are **mode-agnostic**. The same `AgentSpec`, engine,
and connectors run in both paths; only two things differ: **who runs the process**, and **where the
credentials live**.

- **Self-host (the developer path).** `kampong serve <spec>` runs the workflow as a live webhook
  service on the developer's own machine, and the exported standalone project (plus a Dockerfile,
  follow-up) is a **container image the developer runs anywhere** — laptop, homelab k3s, a VPS, Fly,
  Cloud Run. Zero dependency on Kampong the platform (ADR-0002's no-lock-in guarantee). Credentials
  (connector tokens, model keys) come from the **process environment** (`${ENV}`), so "deploy" is
  "run the image with those env vars set."
- **Managed "go live" (the low-code path, SaaS).** A Deploy action in the hosted UI provisions a
  **webhook ingress URL** and runs the workflow on the shared hosted server, using the workspace's
  **stored** credentials (the BYOK vault, KAN-1229) and durable runs (KAN-1231). The low-code user
  never touches Docker, ports, or DNS. This is a roadmap epic built on the V5 substrate + the V9
  primitives — see "Consequences".

"Deployable = a container image" is the right answer for the developer; "Deploy button → it's live,
we run it" is the right answer for the low-code user. Both are first-class; neither requires the
other.

### 2. Execution is on-demand, not always-on

A trigger event drives **one run on a shared process/server**; there is no always-on, per-workflow
worker or container. On the laptop that shared process is `kampong serve`; in the managed path it is
the hosted server's run manager (KAN-1231), which already runs a durable run per request and would
simply be initiated by a webhook instead of an API call. Always-on per-workflow workers are heavier
and only needed for long-running/streaming/stateful agents, which single-agent event-driven
workflows are not (ADR-0001). Scheduled triggers, when added, need a scheduler; webhooks do not.

### 3. Trigger is a spec concept; `${ENV}` locally, workspace vault when hosted

`agent.trigger` (`{ type: "webhook" }` today, room for `schedule`/others) is part of the spec, so
both paths and the canvas read the same declaration. Connector/model credentials are always
`${ENV}` placeholders in the spec (never literals); the **resolver** differs by path — `process.env`
for `kampong serve` / the exported app, and a per-workspace secret resolver (an extension of
`resolveWorkspaceModelClient`, KAN-1230, to connector tokens) for the managed path.

### 4. Sequencing: foundation first

The trigger/execution/connector primitives are buildable and testable now with no infrastructure,
and are shared by both paths, so they come first:

- **Now (KAN-1431):** `agent.trigger` schema + `kampong serve` (the laptop/self-host webhook service).
- **Next (follow-up card):** the exporter emits a listening service + a Dockerfile, so the exported
  project is a runnable container image (the developer's "deployable artifact").
- **Later (new epic):** managed "go live" — webhook ingress, a deployment record + lifecycle
  (deploy/pause/redeploy), per-workspace connector secrets, and free/paid tier metering — on top of
  the V5 hosted backend, once that backend is actually deployed somewhere.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Only the self-host/container path | Leaves the low-code user (who won't touch Docker) with no way to go live; that "Deploy → it's live" experience is core product value. |
| Managed go-live first | Also requires actually standing up and operating the hosted server now; the shared primitives are needed either way, so building them first de-risks and reaches a demo faster. Chosen order is foundation-first (user decision). |
| Always-on container per workflow | Operationally heavy; unnecessary for event-driven single-agent workflows. Revisit only if long-running/streaming agents demand it. |
| Hosted connector secrets in `process.env` | Not multi-tenant-safe; the managed path must resolve per-workspace secrets from the encrypted vault, not a shared server env. |

## Consequences

- `kampong serve` and the exported container are the developer story and exist without any hosting.
- The managed path is mostly assembly of things V5 already built (durable runs, BYOK vault, RLS) plus
  a webhook ingress and a deployment/lifecycle concept; it is a new epic, not part of V9's core.
- A per-workspace connector-secret resolver is required before the managed path can run connectors
  (extends KAN-1230). Tracked with the managed-go-live epic.
- Tiering (free vs paid allowances: live-workflow count, runs/month) sits on top of the deployment
  record as metering; deferred, but the deployment record should be shaped to allow counting.
