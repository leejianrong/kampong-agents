# ADR-0010: The exported project vendors the real engine source, not a re-templated reimplementation

- Status: Accepted
- Date: 2026-09-04
- Deciders: Jian (product owner)

## Context

SLICES.md V4 (KAN-1114) requires `AgentSpec -> standalone Mastra TypeScript project` codegen
whose acceptance bar is _behavioral equivalence_: "produces output behaviorally identical to the
canvas/CLI-run version on the same fixed input" (PLAN.md's Testing approach, SLICES.md V4's e2e
test). ADR-0002 separately requires the exported project to have "zero dependency on Kampong
Agents tool itself -- only on Mastra and its own declared dependencies," which rules out the
straightforward option of having the generated project `import` `@kampong/engine` as an npm
package: that package isn't published anywhere the exported project (installed standalone, with
no access to this repo or a private registry) could resolve it from.

That leaves two ways to give the exported project the real guardrail/condition/HTTP-tool/
workflow-sequencing/model-provider-resolution behavior that `packages/engine` already implements
and tests:

1. Re-derive equivalent logic by hand in the exporter's own code-generation templates (a second,
   parallel implementation of condition evaluation, guardrail thresholding, tool-param
   substitution, provider resolution, etc., written to produce TypeScript source rather than to
   run directly).
2. Copy the actual `packages/engine` source files that implement this behavior into the exported
   project as plain files it now owns, and generate only a small entry point that wires the
   specific spec's concrete values into calls against that copied code.

## Decision

**Vendor, don't re-template.** The exporter copies `packages/engine/src/condition.ts`,
`guardrail.ts`, `http-tool.ts`, `workflow.ts`, and `model.ts` (lightly adapted -- see below) into
the exported project's own `src/runtime/` directory as ordinary TypeScript files with no
generation-time templating inside them: they are the same code that
`packages/engine/test/unit` and `test/integration` already exercise, not a parallel
reimplementation that has to be kept in sync by hand. The exporter's actual code-generation work
is then narrow: (1) copy this small runtime verbatim/lightly-adapted, and (2) generate a clean
`src/index.ts` entry point that imports it and wires in the spec's static values (role/goal/
tools/workflow/guardrails/model config) plus a stdin-driven approval loop mirroring
`packages/cli/src/cli.ts`'s `run` command, a `package.json` declaring only real resolvable
dependencies, and a `README.md` documenting the one-way-export contract.

**What "lightly adapted" means, concretely:**

- `condition.ts` and `guardrail.ts` copy verbatim -- pure functions with no CLI/dev-server
  dependency.
- `http-tool.ts` and `workflow.ts` copy with their imports rewritten to relative paths within the
  vendored `runtime/` directory (they already have no dependency on anything CLI- or
  dev-server-specific).
- `model.ts` copies as-is, including the full `anthropic`/`openai`/`ollama` provider map: the
  `AgentSpec` schema doesn't distinguish "dev-only" providers, so an exported project must support
  whatever provider the source spec configured, including a live Ollama server.
- `tool-fixtures.ts` (the mock/record layer) and anything CLI/dev-server-specific are explicitly
  **not** vendored -- that's dev-tooling for iterating on a spec inside this tool, not part of
  what a live standalone run needs. An exported project always makes live HTTP tool calls.
- `run.ts`'s `AgentRun` class is vendored too (it has no CLI dependency itself), since the
  generated entry point's approval loop is built the same way `packages/cli/src/cli.ts`'s `run`
  command drives it (`start()` / loop on `status === "awaiting_approval"` / `resume()`).
- Every vendored file's _type-only_ imports from `@kampong/spec` (`AgentSpec`, `Tool`,
  `WorkflowStep`, `Model`, `ModelProvider`, `Guardrails`) are rewritten to a small, hand-vendored
  `runtime/spec-types.ts` carrying the equivalent plain TypeScript interfaces, rather than
  importing types from a package that can't be installed standalone. This is safe specifically
  because the exported project never re-validates a spec at runtime -- the spec is baked in as an
  already-validated literal at export time, so only the _shape_ (for compile-time checking), not
  `@kampong/spec`'s Zod schema/validator itself, needs to travel with the export.

## Alternatives considered

| Option                                                                                                          | Why not                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-derive equivalent logic via hand-written codegen templates                                                   | A second, parallel implementation of condition/guardrail/tool/workflow/provider logic that isn't the same code `packages/engine`'s test suite already covers -- real risk of silent behavioral drift between "what the engine does" and "what the exported code does," which directly undermines the R4 behavioral-equivalence bar this slice exists to satisfy.                                                      |
| Publish `@kampong/engine` to a real registry and have the exported project depend on it                         | Contradicts ADR-0002's explicit "zero dependency on Kampong Agents tool itself" -- publishing this package would recreate exactly the lock-in the export feature exists to avoid, and ties every exported project's future behavior to this tool's own release cadence rather than letting the developer own their code outright.                                                                                     |
| Bundle `@kampong/engine` into a single minified/inlined file at export time (a real bundler step, e.g. esbuild) | Produces the opaque, hard-to-read generated code PLAN.md's Open risks section explicitly warns against ("no lock-in is only credible if the exported code is actually good, idiomatic TypeScript a developer would want to maintain, not obviously-generated boilerplate") -- a minified bundle is worse to read and edit than the plain source files it started from, for no correctness benefit over plain-copying. |

## Consequences

- **Accepted cost: this is now the same logic living in two places.** `packages/engine/src/*`
  (the tested, evolving source) and every export's `src/runtime/*` (a frozen copy taken at export
  time) will not auto-stay in sync if `packages/engine` changes later -- a future engine bugfix or
  behavior change does not retroactively apply to a project someone already exported. This is a
  deliberate consequence of ADR-0002's one-way-export design (exported code is the developer's own
  from that point forward, including its bugs), not an oversight; re-exporting is the only way to
  pick up an engine change, and that is expected to be rare relative to how often someone exports.
- Because the vendored files are exact copies of already-unit/integration-tested source, KAN-1114's
  own unit test plan ("codegen correctly translates each spec construct into its TypeScript
  equivalent") only needs to prove the _entry point_ wiring is correct (the spec's concrete values
  land in the right places) -- it does not need to re-prove condition/guardrail/tool-call
  correctness, which `packages/engine`'s existing suite already covers and which the vendored files
  inherit unchanged.
- If `packages/engine`'s public shape (function signatures, `EngineDeps`, `RunEvent`, etc.) changes
  in a way that isn't source-compatible with how the generated entry point calls it, the exporter's
  entry-point template has to change in lockstep -- this is a normal internal-consumer coupling
  between `packages/exporter` and `packages/engine` inside this repo, not a runtime dependency the
  exported project carries.
- The generated project's `package.json` never lists `@kampong/spec`, `@kampong/engine`, or any
  other `@kampong/*` package, and never references this repo via `file:`/`link:` -- KAN-1116 is
  the automated check that this stays true.
