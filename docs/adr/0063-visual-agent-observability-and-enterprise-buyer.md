# ADR-0063: Visual agent observability is part of the product, and the first buyer is an enterprise team

- Status: Accepted
- Date: 2026-11-19
- Deciders: Jian (product owner)

## Context

ADR-0053 set the first user as a non-technical person who can prompt an LLM, with hosting as the business and an
enterprise self-host licence as a second line. The product owner has since clarified the north star: **enterprise
self-host**, with trustworthy automation (approvals, visible failures, no silent fallbacks) as the core
differentiator. The product should offer what Langfuse and LangSmith offer (tracing, cost and latency dashboards,
evals, datasets, prompt management, human review) directly inside Kampong, and later act as an observability
provider for agents that were not authored in Kampong. The difference from those tools is that it is visual and
easy to use for someone who does not read traces for a living.

Nothing for this exists in the repo today. The engine records per-step traces for Test Run, replay and fixtures
(ADR-0004's visible failures, KAM-13), and the hosted server stores runs and streams progress over SSE
(KAM-60, KAM-73). That is the starting point, not an observability product.

## Decision

1. **North star.** A visual, easy-to-use way to build, run and observe AI agents, sold as hosted plus a paid
   enterprise self-host licence. Trust (human approval, visible failure, an auditable record of what ran) is the
   reason to choose it over n8n, Gumloop, Langfuse or LangSmith.
2. **End user and buyer are different people.** The end user stays the ops/support person from ADR-0053, who builds
   and watches workflows. The first **buyer** is an enterprise team that runs agents (platform, AI, IT or risk
   owners) and needs to see, evaluate and govern them. ADR-0053 decision 1 is narrowed accordingly; decisions 2-6
   stand.
3. **Builder first, observability built in.** Workflows authored in Kampong get the observability features first,
   on the spec and engine we already have. Ingesting traces from agents built elsewhere comes after, as an
   extension of the same trace model. We do not build a standalone observability product ahead of the builder.
4. **First-version feature scope** (all four, sequenced as slices on the board):
   - Visual tracing: a run view (timeline and graph) with token cost and latency, and dashboards over runs.
   - Evals: datasets (including from real runs), experiments that compare spec or prompt versions, and
     LLM-as-judge scorers.
   - Prompt management: versioned prompts and a playground, with each run linked to the version it used.
   - Human review: approval and annotation queues, building on the existing human-in-the-loop step and persisted
     approvals.
5. **One trace model.** A run of a Kampong workflow and a trace ingested from elsewhere are the same stored shape
   (a tree of spans with model, tool and step kinds, token usage, cost, timing and status). Kampong-specific
   fields (step id, spec version, approval decisions) are optional extensions of it.
6. **Outside agents arrive over OpenTelemetry.** The ingest is OTLP using the OpenTelemetry GenAI semantic
   conventions. We do not ship our own SDKs, which keeps the TypeScript-only stance (ADR-0003) intact.
   Compatibility endpoints for the Langfuse or LangSmith APIs are not committed.
7. **Visual and simple is the design bar.** Every observability screen follows Material Design 3 and the canvas
   look (ADR-0059): it must be understandable by the end user, not only by an engineer. A view that needs a query
   language to be useful is a finished feature only if it also has a visual path.

## Not decided here (open)

- **Trace storage.** Postgres under row-level security (as today) versus a columnar store such as ClickHouse for
  volume. Langfuse needs ClickHouse and blob storage at scale, which makes self-host heavier. A spike decides it.
- **Retention, redaction and privacy.** Traces contain prompts and customer data. Redaction, retention and the
  hosted analytics policy (ADR-0053) need a decision before ingest of outside agents.
- **Pricing meter** for traces or runs (ADR-0053, KAM-209) and the **licence of the core** (KAM-208).
- **The judge model's key source** for LLM-as-judge evals. It follows KAM-252 (hosted assistant key source).
- **Whether to add Langfuse/LangSmith API compatibility** after OTel.
- **Multi-agent traces.** Span trees must not assume one agent (ADR-0001), but V7 stays unscheduled.

## Consequences

- **ADR-0053:** the first-user line is narrowed as in decision 2; add a note pointing here.
- **Roadmap:** a new epic (V13, observability) is added to the board with slices for the trace model, run view,
  dashboards, datasets and experiments, LLM-as-judge, prompt registry, review queues and OTel ingest.
  Sprint priorities are re-ordered around it; V6 enterprise features (audit log, RBAC, cost circuit breakers) now
  sit next to it, because they share the trace data.
- **Existing cards:** KAM-82 (Deploy dashboard) and the run history views should reuse the trace model rather than
  invent their own. KAM-66 (audit log) and KAM-67 (cost circuit breakers) read from it.
- **Docs and positioning** (`AGENTS.md`, README, `PLAN.md`, `SLICES.md`) say observability is the direction and not
  built yet, until slices ship.
