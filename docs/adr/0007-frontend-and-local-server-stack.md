# ADR-0007: Frontend and local-server stack

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

ADR-0005 already decided the canvas ships as a local web app served by the CLI, but left the
actual UI framework, canvas/graph rendering library, local server framework, and YAML parsing
library undecided. These are real, load-bearing choices — they determine `package.json`
dependencies and package boundaries, and are expensive to reverse once the canvas (SLICES.md
V1) is underway.

The canvas is fundamentally a node-graph editor (blocks, connections, a property inspector),
not a generic web app. That framing narrows the real decision considerably: the question isn't
"React vs. Svelte" in the abstract, it's "which ecosystem has a mature, production-grade
node-graph library."

## Decision

- **UI framework: React + Vite**, for `apps/canvas`.
- **Canvas rendering: `@xyflow/react`** (formerly React Flow), MIT-licensed, free for commercial
  use. It ships MiniMap/Controls/Background out of the box and is the same library Langflow
  (a direct competitor solving the same "visual agent workflow" problem) is built on — a
  well-trodden, de-risked choice rather than a novel bet.
- **Local server (what `kampong dev` starts): Fastify.** Serves the built canvas static assets,
  a REST API for spec CRUD, and a Server-Sent-Events endpoint streaming the step-by-step run
  trace (PLAN.md Shape S3's test-run panel). Approve/reject actions are a plain POST — SSE
  covers the overwhelmingly server→client data flow without the complexity of a full-duplex
  socket.
- **YAML parsing: the `yaml` package (eemeli/yaml), not `js-yaml`.** Its `Document`/CST API
  preserves comments and formatting across a parse→mutate→stringify round trip.
- **Database: none in v1** (files only, per Q17 — restated here since it belongs with the rest
  of the stack answer). For the hosted roadmap slice (V5), Postgres is the working default
  assumption, not a decision made now.

## Alternatives considered

| Option                   | Why not                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Svelte + SvelteFlow      | No comparably mature node-graph library in the Svelte ecosystem for this specific use case; would mean building graph-editing primitives from scratch instead of the editor itself.                                                       |
| WebSocket instead of SSE | Full duplex isn't needed yet — the run-progress stream is one-directional and the one action (approve/reject) is a simple POST. Revisit if hosted mode (V5) needs multi-user presence/awareness, which does need bidirectional messaging. |
| `js-yaml` for parsing    | Strips comments and reformats on stringify, which would silently violate R1's "zero data loss" the first time the canvas saves a hand-annotated spec.                                                                                     |

## Consequences

- `apps/canvas` depends on `react`, `react-dom`, `@xyflow/react`, `vite`; `packages/cli`
  depends on `fastify`; `packages/spec` depends on `yaml`.
- Real-time multi-user collaboration (explicitly deferred, Q24) would likely require revisiting
  SSE for WebSocket once it's actually in scope — flagged here so it isn't a surprise later, not
  a problem to solve now.
- Postgres-for-hosted-mode is a placeholder assumption, not an ADR-grade decision — it should be
  revisited with its own ADR when V5 is actually being built, once real workspace/multi-tenant
  data shape is known.
