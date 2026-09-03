# ADR-0002: YAML is the single lossless source of truth; code export is one-way

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The ideation doc's "canvas-code duality" section (§4) describes bidirectional sync between the visual canvas and _code_ generally, giving both a YAML example and a generated-Python example, and implies (via the "AST / code transpiler" row of its technical-approaches table) that hand-edited code could sync back to the canvas.

True bidirectional sync between a visual canvas and arbitrary hand-written TypeScript is an AST-level transpiler problem: it requires parsing arbitrary code back into the canvas's node/edge model, handling code the canvas can't represent (loops, custom logic, arbitrary imports), and keeping that round-trip lossless as the language evolves. That is a much larger and riskier build than the canvas itself, and it is not needed to deliver the core trust signal enterprise buyers care about ("no lock-in") — a one-way, always-current code export already gives a developer a real, runnable, git-committable artifact with zero platform dependency.

## Decision

The `AgentSpec` YAML file is the single lossless source of truth. The canvas reads and writes this YAML bidirectionally: every canvas action updates the YAML, and every valid YAML edit (including hand-edits in a text editor) re-renders the canvas, with zero data loss for all supported node types (R1).

TypeScript export ("eject") is a one-way code-generation step: `AgentSpec → standalone Mastra TypeScript project`. The generated project is never re-parsed back into the canvas. Editing the exported code does not affect the spec or the canvas; from that point, the exported project is the developer's own code to maintain independently, which is precisely the "no lock-in" guarantee.

## Alternatives considered

| Option                                                                              | Why not                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full bidirectional sync between canvas and hand-written TypeScript (AST transpiler) | Substantially larger build (a real transpiler, not a codegen template), with correctness risk (canvas can't represent everything expressible in TS) that would delay proving the core value proposition. |
| JSON as the source of truth instead of YAML                                         | YAML was chosen in the ideation doc's own example and is more readable/diff-friendly for hand-editing with comments; no material reason to diverge.                                                      |

## Consequences

- The canvas-code duality story is precise and honest: "your workflow is always expressible as clean, readable YAML, and you can eject to a real TypeScript project with zero lock-in" — not "edit generated code and see it flow back to canvas," which is not supported.
- The spec parser/validator (PLAN §Shape S1) is the single component every other part depends on: canvas, execution engine, and exporter all read the same validated `AgentSpec` object, never each other's output directly.
- If a future customer genuinely needs code-first round-tripping (e.g. "I hand-wrote custom TypeScript logic, sync it back to canvas"), that is a new, separately-scoped effort, not an incremental extension of this design.
