# ADR-0027: One expression language and a real data model

- Status: Accepted. The spike (KAN-1839) passed on 2026-10-07: JSONata is confirmed, with the conditions
  in "Spike result" below.
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

## Spike result (KAN-1839, 2026-10-07): GO, with conditions

Tested against `jsonata@2.2.2` (MIT, no dependencies, 80 KB minified, 299 KB source; `evaluate` is async).
The scripts and how to run them are in `docs/adr/0027-spike/`. All numbers are from this machine (Node 24).

| Property | Result | Evidence |
| -------- | ------ | -------- |
| Deterministic | **Pass, with guards** | Out of the box four built-ins are not: `$now`, `$millis`, `$random`, `$shuffle`; `$eval` runs a string as code. A walk of the parsed AST finds each one, including through aliasing (`$f := $now; $f()`) and passing as a value (`$map(a, $random)`). Shadowing them with throwing bindings is a second layer. With them removed, 11 expressions covering paths, arithmetic, sorting, dates, number formatting and object functions gave byte-identical results over 200 runs each (0 drift). `$.constructor`, `__proto__` and similar reach nothing: no host object or global is reachable. |
| Bounded in time | **Pass, with a limit** | `jsonata(src, { timeout, stack })` is built in. An infinite recursion, a million-step `$reduce` and a 16-million-step nested `$map` all stopped at the 200 ms limit (`D1012`) instead of running for 1 s, 10 s or forever; a non-tail recursion 5 000 deep stopped with `D1011` at `stack: 400` (a tail call is optimised and does not grow the stack). **Not interruptible: a regular expression with catastrophic backtracking** (`/^(a+)+$/`) blocks the thread and was still running after 25 s; `timeout` is only checked between nodes. |
| Bounded in memory | **Pass in the process, not as a hard limit** | Unguarded: `$pad("x", 400000000)` took 827 MB RSS, `[1..10000000]` 217 MB, a 2-million-item `$join` 384 MB. A symbol-keyed `__evaluate_exit` hook (`Symbol.for("jsonata.__evaluate_entry" / "__evaluate_exit")`; a string name does nothing) sees each node's result, and refusing a string over 1 MB or a list over 200 000 items stopped the range and the join at 46 ms and 11 ms (peak 138 MB and 79 MB). `$pad` allocates before any hook sees it, so it is wrapped to cap its width. **A hard cap needs a separate process:** a worker with `resourceLimits` did not contain the range bomb, the whole process aborted; a child process with `--max-old-space-size=64` died alone (SIGABRT) and the parent carried on. The parser overflows the stack (a `RangeError` with no position) at about 5 000 nested parentheses, so source length is capped. |
| Canvas-editable subset | **Pass** | A subset of the AST (references with indexes, literals, `+ - * / % = != < > <= >= and or &`, unary minus, `?:`, and a short list of pure functions such as `$abs`, `$count`, `$exists`, `$lowercase`, `$max`) maps to a form model and back to text. Of 28 expressions drawn from the demos and the V11 templates, 16 fit, including every condition and reference the demos need, and all 16 re-parse to an identical AST. The 12 that do not (lambdas, predicates, `~>`, blocks, `**`, regular expressions, object constructors) are shown as text and still validate. A printer that adds parentheses changes the author's text, so the form must only rewrite an expression the author edited through it. |
| Located errors | **Pass** | Every syntax error (`S0xxx`) and every runtime error (`T1006`, `T2001`, `T0410`, `T2009`, `D1011`, `D1012`) carries `code`, a message and `position`, a character offset that maps to a line and column, including in a multi-line expression and inside a nested call. Two caveats: errors are plain objects, not `Error` instances, so they must be normalised; and a mistyped path (`alerts[0].labl.alertname`) or a wrong index is **not an error**, it evaluates to `undefined`. |

### What the evaluator must do (the contract KAN-1840 and KAN-1841 build on)

1. **One entry point** that parses once, rejects at parse time (source over about 4 000 characters; a
   variable named `now`, `millis`, `random`, `shuffle` or `eval`; a regular expression literal, until a
   safe `RegexEngine` exists, since the option is a hook that takes a constructor), and evaluates with
   `timeout` and `stack` set, the denied built-ins shadowed, `$pad` capped, and result-size and step limits in
   the `__evaluate_exit` hook.
2. **Pure**: the result depends only on the expression and the JSON input (`trigger`, `vars`, step outputs).
   No clock, no randomness, no environment, no I/O.
3. **Normalised errors**: `{ code, message, position, line, column }`, never a raw thrown object.
4. **`undefined` is a value the engine must handle on purpose.** A reference that finds nothing yields
   `undefined`, which is falsy in a condition and silently drops a key in an object. KAN-1840 should lint
   references against what is known (`vars`, `output_schema`, declared outputs) and say so at validation
   time, not at run time.
5. **Pin the version exactly** and keep a conformance corpus (the one in the spike, extended) in the repo's
   tests, so an upgrade that changes a result is caught. JSONata collapses a one-element list to its element
   and has its own truthiness rules for `$boolean`; both need explicit tests where a condition depends on them.
6. **Hosted mode needs a process boundary** (a child process with a heap limit, or a container) before user
   expressions run on a shared server. A worker thread and the in-process guards are not enough for memory,
   and `timeout` cannot interrupt a native regular expression.
7. **Exports carry `jsonata` as a pinned dependency** (zero transitive dependencies) next to the vendored
   engine files; evaluating a condition becomes `await` in the vendored workflow, which is already async.

### Decision

Go. JSONata passes all four properties, so the fallbacks (a CEL subset, a minimal grammar) are not needed.
The conditions above are part of the decision, not follow-ups. The one property that holds only with
guards is determinism, and the guards are cheap, testable, and fail visibly.

## Syntax, versions and `vars` (KAN-1840)

- **Versions.** `version` is `"1.0"` or `"1.1"`; any other value is a validation error naming the two. `"1.1"`
  makes a condition's `if` an expression and every `{{ … }}` in a tool or step an expression (the legacy
  `{{ step.field }}` is already a valid JSONata path, so it needs no migration), and enables `vars`. In a
  1.0 spec `vars` is an error. A 1.0 spec keeps loading and running, and gets a note (never an error) for
  a condition step and for each `{step.field}` placeholder (`legacy_condition_syntax`,
  `legacy_placeholder_syntax`); `{{ step.field }}` is not noted, because it is valid in both.
- **Checked at load.** In a 1.1 spec each expression goes through the spike's parse-time rules (length, the
  denied built-ins, no regular expressions) and each name it reads from the root must exist: `trigger`,
  `input`, `vars` (and the var must be declared), or a step name. The error carries the YAML line and the
  character in the expression. Names inside a filter, a lambda or a `.(…)` step are relative and not
  checked. This is the "lint references" condition from the spike: a mistyped path would otherwise read as
  `undefined` and make a condition silently false.
- **`vars`.** A top-level map of `{ type: number | string | list, items?, default?, description? }`.
  `default` is a literal of the declared type or `"${ENV_VAR}"`. `resolveVars(vars, env, overrides)` is the one
  place that turns a declaration into values: an override wins, then the default; an environment value is
  parsed as the declared type (a list is a JSON array or comma-separated); an unset or empty variable, an
  unparseable value, or a var with nothing to give it is an error naming the var, never a guess.
- **Not in this card.** Evaluation (KAN-1841) and the exporter's evaluator (KAN-1851): until they land,
  `AgentRun` and `exportProject` refuse a 1.1 spec by name rather than misread it with the 1.0 grammar.
  `{{ … }}` ends at the first `}}`, so an expression that itself contains `}}` (a nested object
  constructor) cannot be written inline yet. The published JSON Schema keeps its file name
  (`agent-spec.v1.0.schema.json`, which existing specs' pragma points at) and now describes both versions;
  the cross-field rules (vars needs 1.1, the var name pattern, default types, expressions) are code, as with
  `model.api_key`.
