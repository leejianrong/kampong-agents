# Mastra demos: Plan

Status: agreed · Milestone: discovery round 1 (5 demos)

## Problem

kampong-agents' `AgentSpec`/canvas/exporter has been designed and built
top-down from a product thesis (dev-first, canvas-code duality, single-agent
v1 — see root `PLAN.md`), not bottom-up from watching real agent workflows get
built and run. That leaves an open question the product roadmap can't answer
from inside the product itself: which agent-workflow use cases are actually
worth building support for, and where does the current spec/execution model
already fall short of what a real, production-shaped workflow needs?

## Solution

Build 5 fully real Mastra applications directly against Mastra (not through
kampong-agents' own spec/canvas/exporter), each wired to genuinely real
external services rather than mocks (ADR-0001). For each one, attempt to
describe the same workflow as a kampong-agents `AgentSpec` and write down
exactly where that description breaks down or falls short. The demo code is
the instrument; the gap-analysis is the deliverable. A consolidated
`FINDINGS.md` ranks what's missing by how many demos needed it, and turns into
concrete additions to kampong-agents' own `SLICES.md`/Pandan backlog.

It feels like: five small, real, working systems — a support inbox that
actually triages real email, an incident responder that actually reacts to
real Prometheus alerts, a RAG analyst that actually answers questions from a
real vector store, an ETL job that actually moves real market data, a
multi-agent pipeline that actually reviews real GitHub PRs — each with a
short, honest "here's what kampong-agents would need to build this" writeup
next to it.

## Users and actors

- **Primary: the kampong-agents team** (currently Jian, plus future agents
  working this repo) — this is an internal discovery exercise, not an
  external-facing product.
- **Secondary: kampong-agents' own roadmap** — the consumer of this
  initiative's output. `FINDINGS.md` and the resulting `SLICES.md`/backlog
  items are written for whoever plans the next kampong-agents milestone.
- No human-vs-human conflict here: single user, sequential work.

## Scope

**In this milestone.**

- 5 demos, each a real, runnable Mastra application (ADR-0001, ADR-0003):
  `pr-review-swarm/`, `incident-responder/`, `support-triage/`,
  `research-analyst/`, `market-etl/`.
- For each demo: a working end-to-end scenario against real external
  services, plus a README gap-analysis section naming which Mastra
  primitives it relied on and which kampong `AgentSpec` fields would (or
  wouldn't) express it today.
- For each demo: a real-time visual dashboard, served from the same process,
  showing that demo's activity at a glance (ADR-0006) — not just a chat
  playground or a log.
- Every model call in every demo goes through OpenRouter (BYOK), never a
  direct Anthropic key (ADR-0005) — a standing preference, not scoped to
  this initiative alone.
- A consolidated `FINDINGS.md` at `mastra-projects/` root ranking discovered
  gaps by how many demos needed them and rough effort-to-close.
- At least a handful of concrete, specific additions/updates to
  kampong-agents' root `SLICES.md` or the Pandan board, as the direct
  output of this initiative.

**Out.**

- Building any demo through kampong's own canvas/spec/exporter — that's the
  "before" side of the comparison and would pre-constrain the demos by what
  the spec already expresses.
- Production hosting, deployment, or load-testing of the demos themselves.
  They run on a dev machine; `incident-responder/`'s monitoring stack is the
  one exception, and that's local docker-compose, not a cloud deploy.
- Automated remediation execution in `incident-responder/` — real diagnosis
  and a real proposed fix only, gated on human approval; actually executing
  it is a named stretch goal, not built here (ADR-0004).
- Exhaustive coverage of every Mastra primitive. Coverage is driven by which
  5 use cases were picked, not a feature checklist.
- Any of this being added to kampong-agents' own CI/pre-push gates
  (ADR-0002) — these demos are manually run, not regression-tested.

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Ship 5 real, runnable Mastra demos against real external services | Core goal |
| R1 | Each demo has a written gap-analysis against kampong-agents' current `AgentSpec` | Must-have |
| R2 | A consolidated `FINDINGS.md` ranks gaps by demo-count and effort | Must-have |
| R3 | Concrete items land in kampong-agents' `SLICES.md`/Pandan backlog from these findings | Must-have |
| R4 | `incident-responder/` proposes remediation via real HITL, never executes it | Must-have |
| R5 | None of the 5 demos join the root npm workspace/build/CI | Must-have |
| R6 | Every demo's model calls go through OpenRouter, never a direct Anthropic key | Must-have |
| R7 | Every demo ships a real-time visual dashboard showing its activity at a glance | Must-have |

## Shape

| Part | Mechanism | ADR |
|------|-----------|-----|
| S1 | Each demo is an independent Mastra app under `mastra-projects/<demo>/`, own `package.json`, run via `npm install && npm run dev` | ADR-0002 |
| S2 | Every tool call in every demo hits a real external service — no seeded/simulated stand-ins | ADR-0001 |
| S3 | Per-demo real service bindings: Gmail (dedicated inbox) + Slack for `support-triage/`; Supabase pgvector for `research-analyst/`; self-hosted Prometheus/Alertmanager + a real toy service for `incident-responder/`; Alpha Vantage → Supabase Postgres for `market-etl/`; a dedicated sandbox GitHub repo for `pr-review-swarm/` | ADR-0003 |
| S4 | `incident-responder/`'s agent stops at a Slack-posted proposed fix; execution is out of scope this milestone | ADR-0004 |
| S5 | Each demo's README carries a gap-analysis section mapping what it used to what kampong's `AgentSpec` can/can't express today | |
| S6 | A root `mastra-projects/FINDINGS.md` aggregates all 5 gap-analyses into a ranked list | |
| S7 | Every demo resolves its model through OpenRouter via `@ai-sdk/openai`'s `createOpenAI(...).chat(name)`, never `@ai-sdk/anthropic` | ADR-0005 |
| S8 | Every demo serves its own dashboard (Fastify + SSE, no build step) from the same process, with a demo-specific signature visualization and a shared M3 token file copied across demos | ADR-0006 |

## Affordances

**UI.** Each demo's dashboard (ADR-0006) — a single Fastify-served page per demo, no build step, Material Design 3 tokens shared across all 5.

| Affordance | Place | Wires to |
|------------|-------|----------|
| Swarm map (planner → specialists → merge) | `pr-review-swarm/` dashboard | `/events` SSE, GitHub API |
| Incident timeline (alert → diagnosis → proposal) | `incident-responder/` dashboard | `/events` SSE, Prometheus/Alertmanager |
| Inbox triage board (ticket → draft/escalate) | `support-triage/` dashboard | `/events` SSE, Gmail, Slack |
| Retrieval trace (question → chunks → answer) | `research-analyst/` dashboard | `/events` SSE, Supabase pgvector |
| Ingestion/anomaly strip (pull → validate → alert) | `market-etl/` dashboard | `/events` SSE, Alpha Vantage, Supabase |

**Non-UI.**

| Affordance | Kind | Wires to |
|------------|------|----------|
| `support-triage/` | Real Gmail polling | Gmail (dedicated inbox), Slack |
| `research-analyst/` | Chat endpoint behind the dashboard | Supabase pgvector, kampong's own docs corpus |
| `incident-responder/` | Real webhook listener (Alertmanager → HTTP) | Prometheus/Alertmanager, toy service, Slack |
| `market-etl/` | Scheduled job | Alpha Vantage API, Supabase Postgres, Slack |
| `pr-review-swarm/` | Real GitHub webhook (PR opened/updated) | GitHub API (sandbox repo) |
| `mastra-projects/FINDINGS.md` | Static doc | Feeds root `SLICES.md`/Pandan board |

## Implementation decisions

Each demo is free to pick its own Mastra version and dependencies (ADR-0002);
no shared library code between demos is assumed necessary, since the value is
in 5 independent real-world attempts, not a shared framework. Failure
behaviour follows the same house style as the root product: a missing API key
or unreachable dependency is a hard, visible error, never a silent fallback.
Secrets follow the same convention as the rest of the repo — `.env.example`
checked in per demo, real values in a gitignored `.env`, and low-privilege
dedicated accounts (the new Gmail inbox, the sandbox GitHub repo) preferred
over reusing primary personal/production accounts (ADR-0003). Every model
call goes through OpenRouter, never a direct Anthropic key (ADR-0005).
Every demo's own Fastify process also serves its dashboard as static files
plus an SSE `/events` stream, sharing one M3 token file across demos as a
copied static asset, not a package dependency (ADR-0006).

## Testing approach

These are exploratory, manually-run demos, not shipped product — there is no
CI layer for them (ADR-0002). Each demo's own "test" is running its real
end-to-end scenario against the real services it's wired to and observing the
real output; where a demo has non-trivial pure logic (anomaly-detection
thresholds, prompt/tool-schema construction), that logic gets ordinary unit
tests with no network involved. Per-demo test plans are in `SLICES.md`.

## Assumed defaults

| ID | Assumed | Cost if wrong |
|----|---------|---------------|
| Q1 | Primary user is the kampong-agents team itself; no external users | Low — internal-only, easy to redirect |
| Q4 | Demos live outside the npm workspace (ADR-0002) | Medium — would need re-tooling if later folded in |
| Q8 | No shared state/DB across demos | Low — demos are independent by design |
| Q16 | Gap-analysis happens per-demo immediately after building it, not batched at the end | Medium — batching would lose the chance to reprioritize later demos on early findings |

Superseded: Q10 (Mastra dev playground/plain CLI as the default interaction
surface) was overridden by the user — see Q17/Q18 in `QUESTIONS.md` and
ADR-0005/ADR-0006.

## Open risks

- **A "real" service turns out to need paid/enterprise tier to exercise the
  interesting behaviour** (e.g. Slack's approval-button interactivity,
  Alertmanager webhook routing). Earliest slice that would reveal this:
  Slice 1 (`pr-review-swarm/`) and Slice 2 (`incident-responder/`), since
  both depend on service behaviour beyond simple read/write API calls.
- **The riskiest demo (multi-agent PR review) reveals kampong's `sub_agents`
  reservation (ADR-0001 in the main product) is the wrong shape**, which
  would be a real roadmap surprise rather than a routine finding. That's
  exactly why it's Slice 1 — see `SLICES.md`.
