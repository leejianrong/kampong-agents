# ADR-0009: Where the guardrail's confidence value comes from, and why the workflow executor isn't Mastra Workflows

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

`AgentSpec.guardrails.confidence_threshold` (V1) was schema-only: nothing produced a confidence
value for it to compare against. SLICES.md V2 (KAN-1105) requires the guardrail to actually
trigger the same blocking-approval mechanism as `requires_approval` (KAN-1104) when a real run
crosses the threshold, which means V2 has to decide, concretely, where that number comes from.

Separately, `@mastra/core` (ADR-0003) ships its own workflow/tool-approval machinery
(`workflows`, `Agent#generate({ requireToolApproval })`, suspend/resume snapshots via workflow
storage). Using it directly for the AgentSpec's own step sequencer was considered and rejected
for this slice.

## Decision

**Confidence signal.** A workflow action-step opts in with a new schema field,
`confidence_gate: true` (`packages/spec/src/schema.ts`). When the engine executes a
`confidence_gate` step, it asks the model for structured output shaped as
`{ result: <object>, confidence: <number 0-1> }` instead of plain text, via
`ModelClient.generateStructured` (`packages/engine/src/model.ts`, backed by a real Mastra
`Agent`'s `structuredOutput` option). After the step completes, if the spec declares
`guardrails.confidence_threshold` and this step's `confidence` is below it, the engine pauses
for approval through the exact same mechanism a `requires_approval` tool uses
(`packages/engine/src/workflow.ts`). A step that doesn't declare `confidence_gate` never asks
for or checks a confidence value at all -- the guardrail is opt-in per step, not global,
because forcing every step into structured output would be a real behavior change (a plain
text step becoming a JSON-constrained one) for specs that never asked for it.

Condition-step `if` expressions read a prior step's structured `result` fields directly (e.g.
`evaluate_policy.eligible == true`) -- `stepOutputs[step_id]` for a `confidence_gate` step _is_
`result`, so this is the same "prior step outputs" the condition grammar already needed to
support (see the design-decision note in `condition.ts` for the grammar itself, which is its
own small, intentionally minimal scope call for this slice).

**Workflow executor.** `packages/engine/src/workflow.ts` is a purpose-built async-generator
step-sequencer for the AgentSpec's own small DSL (sequential steps; one condition-step type with
string `if/then/else`), not an adapter onto Mastra's `workflows` module or its
`requireToolApproval`/suspend-resume flow. Mastra's approval/suspend system is designed around
their durable snapshot storage and resume tokens -- built for surviving a process restart across
a fleet, not for gating a single local synchronous test run -- and adopting it now would mean
depending on in-flux internals this slice has no way to exercise against a real deployment.
Mastra is still the execution runtime for the one thing that actually needs a model call: the
`Agent` instance in `model.ts` is real, constructed from the spec's role/goal/model exactly as
ADR-0003 calls for. The step sequencer's own pause/resume contract (`AgentRun.start`/`resume` in
`run.ts`) is what KAN-1104 asks for explicitly: "front-end-agnostic... a pending-approval state
plus a resume(approved) hook" -- simple enough to unit/integration-test deterministically with a
fake `ModelClient`, with no dependency on Mastra's exact suspend/resume wire format.

## Alternatives considered

| Option                                                                                     | Why not                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Infer confidence from the model's own token-level logprobs/uncertainty                     | Not exposed uniformly across providers via the Vercel AI SDK; would tie the guardrail to provider-specific capabilities ADR-0004 explicitly wants to abstract away.                                                                                                              |
| A separate, always-on second model call ("self-critique") to score every step's confidence | Doubles the cost/latency of every run, for every spec, whether or not it declares a guardrail -- opt-in per step is cheaper and matches only actual demand.                                                                                                                      |
| Use Mastra's `requireToolApproval`/suspend-resume for HITL directly                        | Couples this slice to Mastra's durable-workflow storage and resume-token format, which is out of scope for a synchronous local run and hard to test deterministically without deeper Mastra-internals knowledge than this slice needs.                                           |
| Use Mastra's `workflows` module for step sequencing                                        | The AgentSpec's step DSL (if/then/else as opaque strings, `execute_tool(name)`/`request_human_approval` branch syntax) predates and doesn't map onto Mastra's workflow primitives; translating it would be a bigger redesign than this slice's scope for no behavioral gain yet. |

## Consequences

- A spec author must explicitly mark the steps where confidence matters (`confidence_gate: true`)
  -- an omission means that step's output is never guardrail-checked, which is the deliberate
  default (opt-in, not silently-on for every step).
- The condition grammar (`<step>.<field> <op> <value>`, documented in `condition.ts`) is
  necessarily part of this same decision: without a `confidence_gate` step's structured
  `result` object, there would be no per-field data for a condition to read at all.
- If a future slice adopts Mastra's own tool-approval/suspend-resume system (e.g. for
  durable/hosted runs in V5), `AgentRun`'s `start`/`resume` contract is the seam to reimplement
  behind, not the workflow-step grammar or the confidence-gate schema field -- both of those stay
  stable across that kind of internal swap.
