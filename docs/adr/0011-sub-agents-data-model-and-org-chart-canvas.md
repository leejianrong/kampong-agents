# ADR-0011: Scope the sub_agents data model and org-chart canvas metaphor for V7

- Status: Proposed
- Date: 2026-09-05
- Deciders: Jian (product owner)

## Context

ADR-0001 deferred multi-agent orchestration out of v1 entirely, but committed to two things for
later: the `AgentSpec` schema should "leave room for a `sub_agents` or `delegates_to` field later
without breaking existing specs," and multi-agent org-chart orchestration is tracked as SLICES.md
V7, not a "someday maybe." V7's own text names three open design questions to resolve once V1–V4
are proven (they now are, per AGENTS.md's build-status section): how a delegated call is
represented in the single-agent execution engine, whether sub-agents are separate spec files or
nested in one, and what canvas-YAML "duality" means for an org chart. The original product sketch
(`ideation.md` §3.3.C) is a manager agent delegating to specialized worker agents (Researcher,
Writer, Fact Checker), wired by the user drawing an org chart.

This ADR is a scoping decision, not an implementation plan — it proposes concrete, reasoned
answers to the three questions above, grounded in the execution engine and canvas code as they
actually exist today, and flags which parts are firm recommendations versus open questions V7
implementation work should still expect to revisit.

**What the current code actually looks like**, as of the V1–V4 baseline this ADR builds on:

- `packages/spec/src/schema.ts`'s `agentSpecSchema` is exactly one agent per file: one
  `role`/`goal`/`model`/`guardrails`/`tools`/`workflow`. `tools` is HTTP-only
  (`toolSchema.action` is a hard `z.literal("http_request")`) — there is no existing "call
  another thing" tool shape to extend.
- `packages/engine/src/workflow.ts`'s `runWorkflow` is a single sequential async generator over
  `spec.agent.workflow`. A condition step's `then`/`else` branch is a tiny closed grammar matched
  by regex: `execute_tool(<name>)` or the literal `request_human_approval`. Both branch kinds
  `yield` an `awaiting_approval` event and block on an `ApprovalDecision` from whoever is driving
  the generator (`AgentRun.resume` in `run.ts`) — this yield/resume boundary is also exactly how
  `AgentRun` gives a browser modal (and, per KAN-1185/ADR context, a CLI stdin prompt) a single,
  front-end-agnostic pause point.
- `AgentRun` (`packages/engine/src/run.ts`) owns exactly one `AgentSpec`, one resolved
  `ModelClient`, and one `runWorkflow` generator instance. There is no concept today of a run
  owning more than one spec or more than one model client.
- `packages/spec/src/graph.ts`'s `specToGraph` maps exactly one `AgentSpec` to a `SpecGraph` with
  four fixed node kinds in four fixed columns (`agent`/`tool`/`workflow`/`guardrails`). This is a
  single-agent, single-file graph; `apps/canvas/src/Canvas.tsx` renders it directly via
  `@xyflow/react`, with node position coming from the ADR-0006 sidecar layout keyed by node id.
- `kampong dev [dir]` and `kampong run <spec>.yaml` (`packages/cli/src/cli.ts`,
  `packages/cli/src/spec-store.ts`) both currently operate on exactly **one** named spec file per
  process (`--spec` flag, default `agent.yaml`) plus its one sidecar layout file. ADR-0008
  declared "a folder of valid `*.yaml` specs renders on the canvas with zero import step" as a
  load-bearing principle, but the only implementation of that principle so far is the trivial
  single-spec case — nothing today actually loads or cross-references multiple sibling spec
  files in one session.

## Decision

### 1. A delegated call is a new workflow-branch action, backed by a nested `runWorkflow` invocation the parent generator delegates into — not a new tool kind, and not a wholly separate `AgentRun`.

**Firm recommendation.** Extend the condition-step branch grammar in `workflow.ts` with a third
pattern alongside the existing two, e.g. `delegate_to(<sub_agent_id>)`, resolved against a new
top-level `sub_agents` array on the manager's `AgentSpec` (see Decision 2). This is deliberately
**not** modeled as a new `tools[].action` variant: `toolSchema` is HTTP-request-shaped
(`method`/`url`/`extract`) and a sub-agent call shares none of that shape — forcing delegation
through the `tools` array would mean either loosening `action` into a union that's mostly
irrelevant to one branch or the other, or bolting HTTP-only fields onto a concept that isn't HTTP.
Keeping delegation as its own schema concept (its own array, its own branch-grammar verb) mirrors
how `execute_tool(...)` and `request_human_approval` are already two distinct verbs in the same
small grammar rather than one overloaded shape.

Execution-wise, when the workflow generator hits a `delegate_to(id)` branch, it resolves the
referenced sub-agent's `AgentSpec` and constructs a nested `runWorkflow(subSpec, subDeps, ...)`
generator for it, then **`yield*`-delegates into it** rather than awaiting it to completion
out-of-band. Concretely, this means the exact same `AgentRun` instance and the exact same
`start`/`resume` pause-point contract (`run.ts`) stays the single seam every front end (browser
modal, CLI stdin) already drives — a nested sub-agent's own `awaiting_approval` or
`step_completed` events surface through the identical event stream, just tagged with a composite
step id (e.g. `researcher/draft_summary`) so `AgentRun.state.trace` — already a flat
`StepRecord[]` — stays informative without any interface change to `StepRecord`. This is the
option that keeps HITL and guardrails meaningfully composable across a delegation boundary: each
sub-agent's own `guardrails`/`confidence_threshold`/`requires_approval` gates fire exactly as they
do standalone, inside the nested generator, and bubble up through the same yield chain the parent
is already built to pause on — no second approval UI, no second SSE wiring, no second CLI prompt
path needs to be invented.

The alternative — instantiating a wholly separate `AgentRun` object per sub-agent and having the
parent `await` it to completion as an opaque sub-routine call — was considered and rejected: it
would either swallow the sub-agent's own approval pauses entirely (no way to surface them to the
same top-level caller) or require an entirely separate nested-approval protocol layered on top of
the existing one, duplicating machinery `yield*` composition gets for free.

**Open questions for V7 implementation to revisit:**

- What happens to the parent run when a delegated sub-agent's own run is `rejected` or `failed`.
  The fail-visibly convention (AGENTS.md, ADR-0004) argues for treating that as a failed step in
  the parent by default, but whether V7 wants an explicit `on_delegate_failure` policy (retry,
  re-escalate to a human at the parent level, degrade to a fallback branch) is unresolved here.
- Whether a delegated call needs its own timeout distinct from `model.timeout_ms` (a whole
  sub-agent run, potentially with its own multi-step workflow and its own tool calls, is a very
  different duration profile than one model call).
- Whether recursive/cyclical delegation (A delegates to B delegates to A) needs to be rejected at
  spec-validation time or is simply left as a runtime depth/loop hazard for V7 to guard against.

### 2. Sub-agents are separate spec files, referenced by the manager via a new `sub_agents` field — not nested inline objects in one file.

**Firm recommendation.** Add `agent.sub_agents?: { id: string; spec: string }[]` to
`agentSpecSchema`, where `spec` is a relative file path resolved the same way the CLI already
resolves a spec path against a directory (`packages/cli/src/cli.ts`), not a fully inlined
`AgentSpec`-shaped object. Each referenced file is itself a complete, ordinarily-valid
`AgentSpec` under today's schema, unchanged — a Researcher or Fact-Checker sub-agent has its own
`role`/`goal`/`model`/`guardrails`/`tools`/`workflow`, exactly like any v1 spec, which means zero
schema changes are needed on the sub-agent side, only on the manager side.

Reasoning, grounded in the load-bearing conventions this must stay consistent with:

- **Diff-clean, hand-authorable YAML (ADR-0002).** Inlining full sub-agent bodies into the
  manager's file would mean a one-line edit to the Researcher's prompt shows up as a diff against
  the manager's file too, and the manager file's size grows unboundedly with the org chart —
  directly against "the spec stays hand-authorable and diff-clean for a developer who never
  opens the canvas."
- **Independent testability.** Each sub-agent stays runnable standalone via
  `kampong run researcher.yaml --input "..."` with no org chart wired up at all — consistent with
  the dev-first, single-agent-loop-first ethos this project has followed since ADR-0001, and it
  means the existing round-trip/behavioral-equivalence test shapes (SLICES.md's testing
  approach) apply unchanged to each sub-agent file individually.
- **It is the first real exercise of ADR-0008's stated-but-not-yet-implemented principle** that
  a directory of independent spec files is a first-class thing the canvas understands — V7 is
  where "a folder of specs" stops being a trivial one-file case and starts meaning what ADR-0008
  already said it should mean.
- **Cleaner exporter shape.** The one-way TypeScript exporter (ADR-0002, ADR-0010) can treat each
  sub-agent as its own generated module, composed by a manager module that imports and calls
  them — much closer to how a developer would naturally structure hand-written multi-agent
  TypeScript than unpacking an array of inlined spec objects into synthetic files at export time.

**Open questions for V7 implementation to revisit:**

- Directory convention for sub-agent files relative to the manager (flat sibling files vs. a
  `sub_agents/` subdirectory) — left unresolved here as a naming/layout detail, not a data-model
  question.
- Whether `kampong dev` needs to become multi-spec-aware in one running server process (loading
  the manager plus every referenced sub-agent file, for the org-chart view to render at all), or
  whether the org-chart view is served by a distinct, still-single-directory-rooted server mode.
  This is a real, non-trivial change to `SpecStore`/`kampong dev`'s current one-spec-per-process
  model (`packages/cli/src/spec-store.ts`) that this ADR does not attempt to design.
- Whether a `sub_agents` entry needs its own `requires_approval`-style gate at the reference
  level (pause before delegating at all) in addition to whatever guardrails the sub-agent's own
  spec declares — plausible, parallel to `toolSchema.requires_approval`, but not decided here.

### 3. Org-chart duality is the same YAML-is-truth mechanism applied to a new field, rendered as a new higher-level graph view that sits above (not instead of) the existing per-agent block canvas.

**Firm recommendation.** The org chart is a distinct graph from `SpecGraph`, built from the
manager spec's `sub_agents` field rather than from any single spec's internal
tools/workflow/guardrails. Concretely: a new function alongside `specToGraph` (e.g.
`specToOrgChart`) produces nodes — one per sub-agent reference plus the manager itself — and
edges representing delegation ("manager delegates to Researcher"), read directly from
`sub_agents`. Duality works exactly the way ADR-0002 already established for the block canvas:
drawing or removing an arrow in the org-chart view is a mutation of the manager's `sub_agents`
field, written back to that one YAML file losslessly; a hand-edit to `sub_agents` in a text editor
re-renders the org chart, same as any other spec field today. No new duality mechanism needs
inventing — this is the existing mechanism (canvas mutates YAML; YAML changes re-render canvas)
extended to a field that happens to reference sibling files instead of describing this agent's
own internals.

Layout stays a sidecar concern per ADR-0006, not spec data: org-chart node positions get their own
sidecar file (e.g. `.kampong/orgchart-layout.json`, keyed by sub-agent id) in the directory holding
the manager spec, kept separate from any individual agent's own block-canvas
`.kampong/layout.json` — rearranging the org chart must never touch or invalidate a sub-agent's
internal block-canvas layout, and vice versa.

Drilling in — clicking an org-chart node opens that sub-agent's own existing block canvas
(Trigger → Tools → Workflow → Guardrails, `apps/canvas/src/Canvas.tsx` unchanged) — is the
proposed navigation model: the org chart is a new top-level view, not a replacement for or a
fifth column bolted onto the existing per-agent graph. This keeps `specToGraph`,
`Canvas.tsx`, and the existing four `NodeKind`s completely untouched; V7 adds a sibling view, not
a rewrite of the current one.

**Open questions for V7 implementation to revisit:**

- Whether drawing a brand-new arrow to an agent that doesn't exist yet should offer an "add
  worker" creation flow (scaffolding a new sub-agent YAML file from the org-chart view) or should
  only ever let a user point at an existing sibling file. This ADR leans toward "point at an
  existing file only" for a first cut (parallel to how `tools` reference URLs rather than
  auto-generating external systems), but treats the creation UX as a V7 implementation call, not
  a data-model question.
- Whether the org chart needs its own confidence/guardrail visualization (e.g. surfacing a
  sub-agent's guardrail breach at the org-chart level, not just inside its own block canvas) —
  plausible given the product's guardrail-forward framing, but not scoped here.
- Exact `SpecNode`/`SpecGraph` type reuse vs. a wholly parallel `OrgChartNode`/`OrgChartGraph`
  type — left as an implementation detail; either is consistent with this ADR's decision as long
  as the org chart's data source stays `sub_agents`, not a single spec's internals.

## Alternatives considered

| Option                                                                                                             | Why not                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model delegation as a new `tools[].action` variant (e.g. `"delegate_to_agent"`) instead of a new branch verb       | Forces HTTP-shaped fields (`method`/`url`/`extract`) to coexist with a concept that has neither, and conflates two different failure/approval semantics (one HTTP call vs. an entire nested multi-step run) under one schema shape.                                |
| Give each delegated call its own top-level `AgentRun` instance, awaited to completion by the parent as a black box | Cannot surface the sub-agent's own HITL pauses to the same top-level approval UI without inventing a second, parallel approval protocol — throws away the yield/resume composition the generator design already gives for free.                                    |
| Inline full sub-agent bodies as nested objects inside the manager's `sub_agents` field                             | Breaks the diff-clean/hand-authorable promise (ADR-0002) for the manager file, makes each sub-agent un-runnable/un-testable standalone, and gives the exporter an awkward "unpack inline specs into files" step instead of a natural one-module-per-agent shape.   |
| Treat the org chart as a fifth column/node kind bolted onto the existing single-agent `SpecGraph`                  | Conflates two different levels of structure (which agent delegates to which vs. one agent's own tools/workflow/guardrails) into one graph and one set of columns, when the two are naturally separate views over separate data (`sub_agents` vs. everything else). |
| Store org-chart layout inside the manager's YAML instead of a new sidecar file                                     | Directly contradicts ADR-0006's already-settled reasoning (visual coordinates don't belong in a spec a developer hand-edits) — no new argument here would justify reopening that decision just because the graph in question is a different one.                   |

## Consequences

- `agentSpecSchema` gains one new optional field, `sub_agents`, and `workflow.ts`'s condition
  branch grammar gains one new pattern (`delegate_to(<id>)`) alongside `execute_tool(...)` and
  `request_human_approval` — both additive, so every existing v1 spec keeps validating and
  executing unchanged, honoring ADR-0001's original constraint that this stay a
  non-breaking extension.
- The execution engine's yield/resume contract (`AgentRun.start`/`resume`, `run.ts`) does not need
  to change shape for V7 — it already generalizes to nested delegation via `yield*` composition,
  which is a meaningful validation that ADR-0009's choice of a purpose-built generator (over
  adopting Mastra's own workflow/suspend-resume machinery) was the right call for this kind of
  extension, not just for V1–V4's needs.
- `kampong dev`'s current one-spec-per-process model (`SpecStore`, `packages/cli/src/cli.ts`) is
  the piece most clearly under-built for V7 as it stands today — multi-spec awareness for the
  org-chart view is real, non-trivial server-side work this ADR does not resolve and V7 slicing
  needs to size explicitly.
- The exporter (`packages/exporter`, ADR-0010) needs a follow-on decision of its own for how a
  manager module composes generated sub-agent modules; this ADR only establishes that
  separate-files-per-agent make that composition natural, not what the generated code looks like.
- This ADR supersedes none of ADR-0001, ADR-0002, or ADR-0006 — it extends ADR-0001's explicit
  "leave room for `sub_agents`" instruction into a concrete proposal, and its canvas-duality and
  layout-sidecar proposals are deliberately built to stay consistent with ADR-0002 and ADR-0006
  rather than reopen either. v1's single-agent scope (ADR-0001) remains true today; this document
  scopes the next phase, it does not bring V7 forward.
