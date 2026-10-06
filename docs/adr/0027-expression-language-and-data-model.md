# ADR-0027: One expression language and a real data model

- Status: Accepted (language choice gated on a spike, see Decision 3)
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

All five demos trip over the same limits in the workflow data model:

- `buildToolParams` exposes only scalar fields of prior steps as `step.field`. Arrays, nested objects
  and indexes are unreachable (incident-responder needs `alerts[0].labels.alertname`, market-etl
  needs the two newest entries of a map-shaped series, pr-review-swarm needs `files[]`).
- `{{ trigger.field }}`, promised by ADR-0021, was never built. A webhook body reaches the engine as
  a raw string.
- Conditions are `step.field op literal` with `then`/`else` limited to `execute_tool(x)` or
  `request_human_approval`. They cannot express `abs(change) >= vars.threshold` or
  `len(plan.specialists) == 0`.
- Action steps always use `Role + Goal` as the system prompt and have no declared output schema
  (only an untyped `{result, confidence}` under `confidence_gate`), yet every demo relies on
  structured output (enums, severity arrays, `citedPaths[]`).
- Thresholds, ticker lists, repositories and poll intervals come from the environment in every demo,
  but the spec allows literals, and `${ENV}` only for secrets.
- A failure ends the run. market-etl must continue past a rate-limited symbol.

## Decision

### 1. One expression language for references, conditions and transforms

The same language is used wherever the spec computes a value: step parameters, approval messages,
conditions, trigger filters, `foreach` item lists, `assert`, and `transform`. It replaces both the
`{placeholder}` URL syntax and the `step.field op literal` condition grammar over time. Existing
specs keep working; unifying the two reference syntaxes is a migration, not a flag day.

### 2. Data model

- The parsed trigger payload is exposed as `trigger.*` (headers and body), not a raw string.
- Step outputs keep their full structure. Paths and indexes resolve (`trigger.alerts[0].labels.name`).
- A top-level `vars` block declares typed parameters (number, string, list) with an optional
  `${ENV}` default, readable as `vars.threshold`, so a deployed spec can be re-tuned without edits.
- A step may declare `instructions`, `model` and `temperature`, overriding the agent's defaults.
- An action step may declare an `output_schema` (JSON Schema subset: enums, numbers, arrays,
  per-field descriptions), validated and retried once on schema failure. `confidence` becomes an
  ordinary optional field, and `confidence_gate` is expressed in terms of it.
- A step or loop may declare `on_error: fail | continue | retry{n, backoff} | goto`. `foreach`
  isolates errors per item and exposes an `errors[]` run output.
- `trigger.respond: sync` returns the final output to the caller instead of a run id.

### 3. Language: JSONata, after a one-week spike

JSONata is the selected language because it is JavaScript-native (exports with no extra runtime),
supports paths, array operations and arithmetic, and has an existing, maintained implementation. A
one-week spike must confirm four properties before the schema work starts: expressions evaluate
deterministically (no clock or random), evaluation can be bounded in time and memory, the
canvas can present a form editor over a useful subset, and errors are reportable with a location.
If the spike fails any of them, the fallback order is a CEL subset, then a minimal grammar covering
the demos' needs. The choice is reversible until the first public release because specs are version
`"1.0"`-gated (below).

### 4. Compatibility

The spec `version` field gates the new syntax. `1.0` specs continue to load and run with the legacy
reference syntax. The JSON Schema is published (ADR-0008) with the new fields, and the validator
reports legacy constructs as deprecated rather than invalid. The canvas edits both forms.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| CEL subset | Cleaner semantics but needs a runtime in every exported project. Kept as fallback. |
| Minimal homegrown grammar | Cheapest now; every demo outgrows it, and the project owns a language forever. |
| Arbitrary TypeScript snippets in the spec | Not deterministic or safe to accept from outsiders, and not editable on the canvas. A sandboxed TypeScript escape hatch is a possible component later (ADR-0026). |
| Keep the current flat model and add features one by one | Each demo needs a different piece of it, so this reproduces the language piecemeal. |

## Consequences

- Touches the spec schema, validator, engine, canvas forms, and exporter (the vendored engine
  carries the evaluator, ADR-0010). The round-trip fixed-point test (ADR-0007) gains fixtures for
  every new field.
- Structured output is a prerequisite for typed forms and reliable downstream conditions.
- This is Phase 0 of V11: it unblocks the data-dependent part of every template.
- Evaluating user-supplied expressions in a hosted multi-tenant server needs the bounds named in
  Decision 3 (time, memory, no host access) before it is enabled there.
