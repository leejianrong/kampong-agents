# ADR-0006: Every demo ships a real-time visual dashboard, not just a chat playground

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

ADR-0002/QUESTIONS.md originally assumed Mastra's own dev playground (or a
plain CLI) was enough of an interaction surface per demo. The user asked for
more: a visual dashboard per demo so what's happening is legible "at a
glance," not by reading logs or a chat transcript. `pr-review-swarm/` was
already built with a real webhook-triggered pipeline that has no natural
chat interface at all -- a dashboard is the only way to see it work.

## Decision

Every `mastra-projects` demo serves its own small dashboard from the same
process that runs it (no separate frontend app/build step), showing that
demo's real activity live via Server-Sent Events -- the same
Fastify + SSE combination kampong-agents' own root product already
standardizes on (ADR-0007 in the main product), not a new mechanism per
demo. `pr-review-swarm/`'s dashboard is the reference implementation: a
`/events` SSE endpoint backed by an in-memory ring-buffer event bus
(`src/events.ts`) that the pipeline emits into, and a static
`public/index.html` + `dashboard.js` consuming it with no framework.

Each dashboard's signature element is specific to what makes that demo's
"at a glance" story real, not a generic log viewer: `pr-review-swarm/`'s is
a live "swarm map" diagram (planner -> specialists -> merge) whose nodes and
connecting lines light up as the real hand-off happens, built with
Material Design 3 tokens per `AGENTS.md`'s house rule for all frontend work
in this repo. The full token set (`public/tokens.css`) is generated from a
real seed color (`#B8752A`, "lantern amber" -- evoking a kampong night
market, not Material's baseline demo purple) via
`@material/material-color-utilities`, covering light and dark automatically.

That token file is meant to be copied into each of the other 4 demos
verbatim as their shared visual identity -- a plain static-asset copy, not a
shared npm package, consistent with ADR-0002's "no shared library code
between demos." Each demo's own dashboard layout and signature element stay
bespoke to what that demo needs to show.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep relying on Mastra's own dev playground | Fine for a chat-style demo, but has nothing to show for a webhook-triggered pipeline with no turn-by-turn conversation, and doesn't visualize multi-agent hand-offs at all |
| A shared dashboard package/library across all 5 demos | Contradicts ADR-0002's decision to keep every demo independently installable with no shared code; a shared visual *identity* (a copied CSS file) gets the consistency without the coupling |
| A generic scrolling log/console view | Doesn't satisfy "understand what's going on at a glance" -- a log is something you read, not something you glance at |

## Consequences

Each demo now has one more real build task (its dashboard), on top of the
agent/pipeline logic itself -- a real, if modest, frontend surface, not
free. In exchange, every demo becomes something that's actually watchable
running against real services, which is the whole point of building these
as real systems rather than scripts. The tokens.css copy strategy means a
future palette change has to be applied to all 5 demos by hand; acceptable
for 5 short-lived demos, would need revisiting if this pattern outlived this
initiative.
