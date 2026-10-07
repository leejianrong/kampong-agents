# ADR-0038: Structured step output (`output_schema`)

Status: accepted (KAN-1843)

## Context

Before this, an action step's output was `{ text }`, or `{ result, confidence }` behind `confidence_gate`
with `result` an unconstrained object. A downstream condition or template could not rely on a field being
there, or on its type, and the confidence value lived on the event rather than in the data (ADR-0009).

## Decision

- An action step may declare `output_schema`: the JSON Schema subset connector ops already use (type,
  enum, min/max, length, pattern, `items`, `properties`/`required`, per-field `description`, scalar
  `default`). The root must be `type: object`. Version 1.1 only, because the point is that later expressions
  can read the fields, and 1.1 is where expressions read full step outputs. Anything outside the subset is
  a validation error, not an ignored keyword.
- **The engine decides validity, not the provider.** The prompt carries the schema as text; the provider is
  given a loose object schema. A value that breaks a constraint is therefore a located error we own
  (`output.severity must be one of low, high`), not a provider exception we would have to classify.
  Declared defaults are filled in first, then the object is validated.
- **Retry once, on a schema failure only.** The second prompt names the problems and the rejected answer.
  A second failure fails the step visibly (`did not match output_schema after 1 retry: …`). A model call
  that throws (timeout, Ollama unavailable) is not retried here: ADR-0004 stands.
- **The validated object is the step output**, so `triage.severity` is present and typed for every later
  condition and template.
- **Confidence is an ordinary field.** With `confidence_gate` and an `output_schema`, the schema must declare
  a numeric `confidence`; the guardrail reads that field (a value outside 0 to 1 counts as a schema failure,
  so it is retried like one). A gate step without a schema keeps the `{ result, confidence }` request; in a
  1.1 spec its `confidence` is also written into the step output so `step.confidence` reads like any field.
  A 1.0 gate step's output is unchanged.

## Not done

- Reads of `step.field` in expressions are not checked against the schema at load time. It is the obvious next
  lint, and it can reuse the spike's relative-name rules.
- The prompt is the only guidance the model gets about the shape; a provider-native structured mode (a JSON
  Schema sent to the API) would reduce retries but needs a per-provider conversion.

## Found against a real model

The first version gave the provider an open object (`z.record`) and relied on the prompt for the shape. A
run against OpenAI's `gpt-4o-mini` through OpenRouter failed every time: the open object becomes
`propertyNames` in JSON Schema, which OpenAI's strict structured output rejects with a 400. The fake models
in the tests could not show this. The provider is now given the real structure (`output-zod.ts`: types,
enums, descriptions, required and optional properties, no extra keys); constraints a provider may refuse
(`minimum`, `maxLength`, `pattern`, ...) stay out of that shape and are enforced by the engine, with the one
retry. After the fix, `gpt-4o-mini` and a free 2.6B model (`liquid/lfm-2.5-2.6b:free`) both produced valid
output on every run (a `maxLength: 50` summary included), and an unreachable `maxLength: 25` failed visibly
after the retry.

Known, and not fixed here: the older `confidence_gate` request without an `output_schema` has the same
open-object problem (its `result` is a `z.record`) and fails the same way on OpenAI-family models.

### What the review of that fix added

- **Mastra throws when the answer breaks the structure** (its default `errorStrategy` is strict), so with a
  real structural schema a wrong enum value, a wrong type or a missing field would have failed the step on
  the first answer, with no retry. `generateStructured` now turns that error into `StructuredOutputError`
  (the issues as `output.<path>: <problem>`, and the raw answer), and the engine retries once on it like any
  other schema failure. Only that error is retried; a timeout or an unavailable model still fails at once
  (ADR-0004). A test drives this through the real Mastra agent with a canned HTTP response, since a fake
  `ModelClient` cannot reproduce the throw.
- **No open ends.** A strict provider needs every object's properties and every array's items spelled out, so
  an `output_schema` with an object that has no `properties`, or an array with no `items`, is a validation
  error at load rather than a silently closed `{}`.
- **Known limits, not fixed.** On OpenAI-style providers (OpenAI, OpenRouter and Ollama go through the same
  compatibility layer) Mastra advertises every optional property as required-but-nullable, so a model may
  fill an optional field with `[]` or `""` instead of leaving it out. A number, integer or boolean `enum` is
  not in the provider shape (the engine still enforces it, with the retry). A `null` on an optional field is
  accepted by that layer but not by Anthropic's, where it counts as a schema failure and is retried.
