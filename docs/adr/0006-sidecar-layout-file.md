# ADR-0006: Canvas node layout lives in a sidecar file, not in the YAML spec

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The canvas needs to remember where each node sits visually (x/y position, maybe zoom/pan state) to avoid re-laying-out the diagram every time it reloads. But the `AgentSpec` YAML (ADR-0002) is meant to be hand-authorable and git-diffable by a developer who may never open the canvas at all — visual coordinates have no meaning to someone editing the spec directly, and embedding them would clutter every diff with noise unrelated to actual behavior changes.

## Decision

Node layout is stored in a sidecar file, `.kampong/layout.json` (or equivalent, one per spec), keyed by the same step/tool IDs used in the `AgentSpec`. The YAML spec contains zero layout information. If the canvas opens a spec with no matching layout entry for a node (e.g., a developer hand-added a new step), the canvas auto-lays-out that node rather than erroring.

## Alternatives considered

| Option                                                 | Why not                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embed layout as a `_layout` block inside the YAML spec | Pollutes the spec that a developer is meant to be able to hand-edit and diff cleanly; a pure logic change would show a noisy diff if the canvas re-serializes coordinates on every save. |
| No persisted layout at all; always auto-layout         | Loses a real usability feature (a developer's intentional arrangement of a complex workflow) for no benefit.                                                                             |

## Consequences

- Two files travel together per agent (`agent.yaml` + `.kampong/layout.json`); tooling (git, the exporter, the CLI) must know to treat them as a pair, and documentation must be clear that deleting the sidecar file is safe (just loses layout, not behavior).
- The spec parser/validator (PLAN §Shape S1) and the layout store are separate, independently testable components — the round-trip correctness test for duality (Q18) only needs to cover the YAML spec; layout fidelity is a separate, lower-stakes test.
- If a developer's team doesn't commit `.kampong/` to git, they lose shared layout but nothing behavioral — an acceptable trade-off explicitly called out in docs.
