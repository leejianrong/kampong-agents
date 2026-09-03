# ADR-0001: Scope v1 to a single agent, not a multi-agent org chart

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The ideation doc's builder-design section (§3.3.C) proposes multi-agent teams wired as an interactive org chart: a manager agent delegating to specialized worker agents, with users drawing reporting/reassignment arrows. This is a compelling feature, but it is a second, largely independent hard problem on top of canvas-code duality (ADR-0002) — it needs its own data model (agent-to-agent references, delegation semantics, shared vs. per-agent state), its own execution semantics (who owns the loop, how failures/timeouts propagate between agents), and its own canvas metaphor (org chart, distinct from the single-agent block canvas).

Building both the duality engine and multi-agent orchestration before shipping anything risks the exact "88% of pilots never reach production" failure mode the market research surfaced: unclear, overbroad scope. The wedge decision (dev-first canvas-code duality) is provable with a single agent.

## Decision

v1 supports exactly one agent per spec file: one system prompt/role, one tool belt, one workflow step sequence, one guardrail set. The `AgentSpec` schema (ADR-0002) is designed so a `sub_agents` or `delegates_to` field can be added later without breaking existing specs, but no such field exists in v1 and the canvas has no org-chart view in v1.

## Alternatives considered

| Option                                                                                            | Why not                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build multi-agent org-chart orchestration in v1                                                   | Doubles the data model and execution semantics before the core duality mechanism is even proven; directly repeats the "unclear success criteria / overbroad scope" pilot-failure pattern.                   |
| Support multi-agent only via manual composition of multiple single-agent specs (no orchestration) | Considered as a stopgap, but no clean way to express one agent calling another as a "tool" without designing the interface now — deferred entirely instead, revisited once the single-agent spec is stable. |

## Consequences

- Slice 1 (SLICES.md V1) can focus entirely on proving the canvas ↔ YAML duality loop for one agent, which is the riskiest, most differentiated mechanism.
- The product story for v1 is honestly narrower than the ideation doc's full vision — multi-agent "hire a team" framing is not available at launch and should not be marketed as such.
- Adding multi-agent later is additive (new field, new canvas view, new execution layer) rather than a rewrite, provided the `AgentSpec` schema is versioned (Q16) and the execution engine (ADR-0003) is not hard-coded to assume exactly one agent instance per run.
