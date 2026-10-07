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
- **Not in this card.** Evaluation (KAN-1841, below).
  `{{ … }}` ends at the first `}}` that is not inside a string literal or a brace the expression opened, so nested
  object constructors and strings holding `}}` are read whole. Reads written through `$` (`$.vars.typo`,
  `$lookup(vars, 'typo')`) are not checked, so a typo there still reads as empty; names inside a transform
  (`| pattern | update |`), a filter, a lambda or a `.(…)` step are relative and not checked. A step name
  that is not a plain identifier (`fetch-data`) must be written in backticks in an expression, and the
  error says so. In a multi-line field the error is placed at the start of the field and the message says
  the line within it. The published JSON Schema keeps its file name
  (`agent-spec.v1.0.schema.json`, which existing specs' pragma points at) and now describes both versions;
  the cross-field rules (vars needs 1.1, the var name pattern, default types, expressions) are code, as with
  `model.api_key`.

## Evaluation (KAN-1841)

A version 1.1 spec runs in `kampong run`, `kampong dev` and `kampong serve`.

- **The evaluator** is `packages/engine/src/expressions.ts`, and implements the spike's contract (above): a fresh
  JSONata expression per evaluation with `timeout` (1 s) and `stack` (400) set, the denied built-ins and regular
  expressions refused from the syntax tree and shadowed as a second layer, a step budget and string and list
  size limits in the per-node hook, `$pad` capped, errors as `ExpressionError { code, position, line, column,
  expression }`, and results returned as plain JSON (JSONata's `sequence` marker on lists is removed). It
  imports nothing from `@kampong/spec`, so it is vendored into exports with the rest of the engine (ADR-0010);
  tests keep its denied list and its `{{ }}` scanner in step with the validator's. `resolveVars` moved from
  the spec package to `packages/engine/src/vars.ts` for the same reason.
- **Data model.** An expression's root is `{ ...stepOutputs, trigger, input, vars }`: every earlier step's
  *full* output by step name (no more scalar flattening; the 1.0 `buildToolParams` is unchanged for 1.0 specs),
  the trigger, the raw input, and the resolved vars, with the reserved names winning (a step may not be named
  one of them; the spec says so at load). `trigger` is the webhook body's fields at the top level,
  `trigger.body` the whole body, and `trigger.headers` the request headers (lowercase; any header whose name contains `authorization`, `cookie`,
  `token`, `secret`, `signature`, `api-key`, `apikey`, `password` or `credential` is never passed, so a credential
  cannot be read into a message, a query or a run trace through `{{ trigger.headers }}`). With no explicit trigger the run input is the body: JSON if it parses, text
  if not. A body field named `headers` or `body` is shadowed by those members.
- **Where expressions are evaluated.** A condition's `if`; every string in a tool (`url`, `headers`, `query`,
  `body`, a component's `with`, and the legacy Slack and Gmail fields), except identity, `method`, `token`,
  `config`, `secrets`, `extract` and `requires_approval`; an approval step's `message`; an action step's
  `query`. A tool's templates are resolved before a human is asked to approve it, so a call that cannot be
  built is not offered for approval. A string that is exactly one `{{ }}` keeps the value's type; text around
  spans is built from each value.
- **Failure is visible.** A condition must be `true` or `false`; nothing (a name it reads is missing) or
  any other type fails the step (`$exists` and `$boolean` say what is meant). A `{{ }}` that selects nothing
  fails the step, as does any syntax or run-time error, a refused construct, or a limit; the message names
  the step, the character and the expression. A var with no value, an unset `${ENV}` default, or an
  unparseable value fails the run before step one, naming the var. This is the "undefined is silent"
  mitigation from the spike, completed at run time.
- **Run inputs.** `kampong run` takes `--var name=value` (an undeclared name is a usage error) and
  `--header name=value`; `kampong serve` passes the webhook's headers and JSON body.
- **Not yet.** The hosted server refuses a 1.1 spec (422, by name): expressions on a shared server need the
  process boundary the spike found memory limits require. `kampong export` refuses one too: the exported
  runtime now carries the evaluator (and pins `jsonata`), but its entry points do not yet pass vars or the
  webhook payload to it (KAN-1851). Structured output (`output_schema`, KAN-1843) and the canvas editor
  (KAN-1850) are separate cards.
- **Data is data.** A tool's strings are resolved by the evaluator and then handed to `callHttpTool`, which reads
  `${ENV}` references and `{name}` placeholders in the text it is given. Without care a webhook body containing
  `${SECRET}` would have been expanded there, so in a 1.1 tool every string that comes from data (an evaluated
  value, text built from one, and strings inside a list or object value) has `${` escaped as `$${` before that
  pass (the escape `callHttpTool` already honours), and the legacy `{name}` substitution is given no params, so
  it leaves everything as written. The author's own `${ENV}` still expands. Components are unaffected: their
  `with` values are data from the start.
- **Native built-ins are capped.** `$sort` and `$distinct` run inside one call that no per-node hook or timeout can
  interrupt, and `$sort` uses memory that grows with the square of the list (60 000 numbers exhausted a 2 GB
  heap, which a 1 MB webhook body can carry), so they refuse a list over 10 000 items (`sortItems`). `$pad` is
  capped as before. They are re-registered with JSONata's own signatures, so `$ ~> $sort()` still works. The
  other bounds stay soft, as the spike found: `kampong serve` evaluates expressions in its own process.
- **One time budget per structure.** The expressions in one tool (or `with`) run one at a time and share a
  single budget (the timeout), so many slow spans cannot take many times the limit and the error reported does
  not depend on timing.
- **URLs.** A value from the trigger goes into a `url` exactly as it arrives, as a 1.0 step output did. A spec
  that reads `trigger.*` inside a tool's `url` without `$encodeUrlComponent` (or `$encodeUrl`) gets a note
  (`unencoded_url_value`), never an error.
