# ADR-0025: Component model and the component repository

- Status: Accepted
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

The five `mastra-projects/` demos (pr-review-swarm, incident-responder, support-triage,
research-analyst, market-etl) were built directly on Mastra to find out what a Kampong user could
not yet author on the canvas. `FINDINGS.md` ranked eleven gaps (F1-F11). A follow-up analysis of the
demo code against `main` (2026-10-06) found that most of what blocks authoring is not missing
connectors but missing platform primitives, and that two gaps were understated:

- `http_request` has `method`, `url` and `extract` only. No headers, body or query parameters;
  `${ENV}` resolves in connector token fields but not in URLs; the response is always parsed as
  JSON. GitHub and Alpha Vantage cannot be called at all.
- Record/replay is keyed on `sha256(toolName::method::url)` (`tool-fixtures.ts`), with no request
  body, so two Slack posts to one URL share a fixture. Non-HTTP transports (IMAP, Postgres, local
  embeddings) have no seam.

We want users to author workflows like the demos on the canvas, from a repository of reusable pieces
that the dev team authors now and that could become a contributed marketplace later (ADR-0026).

## Decision

### 1. Three layers, and only the upper two are "components"

- **Platform capabilities** are engine features and are not pluggable: expression language and
  `trigger.*` (ADR-0027), per-step instructions and model, `vars`, secrets in any field, durable
  state (ADR-0028), the unattended runner, error and retry policy, pacing, record-mode approval, sync
  reply, and the connector framework with its fixture seam. They are built first.
- **Components** are the repository's content: **connectors** (operations against an external
  system), **steps** (reusable workflow step kinds such as structured classify, foreach, RAG
  retrieve) and **triggers** (webhook auth presets, filter, schedule, poll).
- **Templates** are whole-workflow specs built from components: parameterised YAML, an
  `.env.example`, and recorded fixtures so the canvas can run one with no credentials.

### 2. Hybrid implementation, one operation contract

A component is implemented as either:

- a **manifest** (declarative, YAML) interpreted by the engine, for REST-shaped integrations
  (GitHub, Slack operations, Supabase PostgREST, Alpha Vantage, embeddings over HTTP). No code, so
  it can be accepted from outsiders. Or
- a **module** (TypeScript) for protocol- or dependency-heavy pieces (IMAP, direct Postgres,
  local embeddings, Slack interaction ingress). Reviewed and signed, run behind a `Runner`
  isolation interface.

Both expose one **operation contract**: JSON Schema input and output; `effect: read | write |
destructive`; secret slots bound to hosts; `failure_when` rules matched on the response body;
pacing and retry; and a fixture hook. The canvas generates forms from the schema, the engine runs the
operation and enforces permissions, the exporter vendors the interpreter (manifest) or copies the
module with its exact-pinned dependencies (ADR-0010), and record/replay is owned by the connector,
not by `fetch`.

`effect` sets the HITL default: a `destructive` operation requires approval unless the spec says
otherwise.

### 3. Location, identity and licence

- Components live in a `components/` directory in this repository first, split into their own
  repository when a second publisher appears. Not npm packages at the start.
- A component is identified as `namespace/name@version` plus a content digest. `kampong/*` is
  reserved for first-party; third-party names are reverse-DNS.
- Specs reference components by `id@version` and are resolved through a digest-pinned
  `kampong.lock`. Exports vendor the exact bytes.
- The repository and components are Apache-2.0. The Pipedream registry (source-available, bars
  competing products) and n8n (Sustainable Use License) are not safe to borrow from if hosted resale
  stays open (ADR-0003).
- Components depend only on a thin interface that maps to Mastra, never on platform primitives that
  break standalone export (the Pipedream `$.service.db` failure mode).

### 4. Auth is separate from operations; templates carry slot names only

Each component declares named secret slots (`env: GITHUB_TOKEN`, `hosts: [api.github.com]`).
Specs and templates reference slot names. Values live in the environment (self-host) or the
workspace vault (managed, ADR-0024). Multi-part credentials (IMAP user and password, Supabase URL
and key) are a credentials object with several env references.

### 5. Triggers declare dedupe as data

Poll triggers declare dedupe as a manifest enum (`unique`, `greatest`, `last`, `time_window`) over a
cursor kept in durable state (ADR-0028), not as user code.

### 6. Whole-workflow templates are first-class from day one

Five templates form the acceptance suite for the platform work: `triage`, `etl`, `incident`,
`pr-review`, `rag-qa`. Each must be authorable as a spec only, replayable on recorded fixtures, and
pass exporter behavioural equivalence before its phase is closed. A template's trust tier is the
lowest tier among its components (ADR-0026).

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Connectors only; steps and triggers stay in core | Leaves the poll, schedule and auth gaps unaddressed by the repository and puts the roughly 30-piece catalogue in the engine. |
| TypeScript packages only (Activepieces style) | Maximum power, but untrusted code from outsiders needs heavy sandboxing before any marketplace, and every REST connector pays a packaging cost. |
| Declarative only | Cannot express IMAP, direct Postgres or local embeddings, which the triage and RAG demos need. |
| npm packages for distribution from day one | Adds publishing machinery before there is anyone to publish. Revisit with a second publisher. |
| MCP as the component format | See ADR-0026 section 4. |

## Consequences

- A connector framework (manifest schema, registry, canvas form generation, exporter vendoring,
  module loader with declared dependencies) becomes the first large piece of platform work, started
  alongside Phase 1 with the IMAP module as its first non-HTTP consumer.
- The existing `slack_post_message` and `gmail_send` tool kinds are re-expressed as manifests and
  remain backward compatible.
- The fixture key must include the request body or a declared key-field list. This is fixed first as
  a regression test (repository rule), independently of the connector framework.
- `FINDINGS.md` roadmap items change: F7 splits into F7a (`http_request` completeness, promoted
  ahead of F1) and F7b (failure detection and pacing); F1 and F4 are built together; F2 is staged
  (`mode: inject` before `mode: retrieve`); F5 widens to trigger filtering and sync reply. New
  epics: expression language, structured output, foreach with error policy, per-step overrides,
  `vars`, connector framework, `kampong doctor`.
- Sequencing and phase scope are in `SLICES.md` (V11).
- Supersedes nothing. Builds on ADR-0010, ADR-0021, ADR-0022 and ADR-0024.
