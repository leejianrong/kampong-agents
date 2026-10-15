# ADR-0051: Record and replay for model calls, keyed on the call

Status: accepted (KAM-156)

## Context

Tool calls (ADR-0034's HTTP and module fixtures) replay from files, so a spec runs offline with no credentials.
A model call did not: a spec with a model step ran offline only with a local Ollama or a client injected by a
test. `market-etl` and `support-triage` each have one model step, so `kampong run --tools replay` on a shipped
template still needed Ollama, and their tests carried a hand-written stand-in model instead of running the
shipped spec as it is.

## Decision

- **A `ModelClient` decorator**, `createModelFixtures` in `@kampong/engine`. In `record` it makes the real call
  and files the answer; in `replay` it answers from the file and has no inner client, so it cannot reach a
  provider, a key or the network. A call with no recorded answer is a `MissingModelFixtureError` naming the
  call, never a live call (ADR-0004: a failed model call fails visibly).
- **Keyed on the call, not the step.** The key is the kind of call (text or structured), the instructions, the
  prompt, the step's model override and its temperature. The step name is not visible at the client, and the
  prompt already carries everything that should make two answers differ (the structured prompt includes the
  JSON Schema). A changed prompt is a miss rather than a stale reply. Files are `@model.<kind>.<hash>.json`
  beside the tool fixtures; `@` cannot occur in a tool's file prefix, so the names cannot collide.
- **`--tools` covers model calls, `--model` overrides.** `--tools replay` replays model calls and `--tools
  record` records them, so one flag still means "offline". `--model live|record|replay` sets it separately, and
  `--model live` keeps a real model under `--tools replay` for iterating on a prompt against recorded tools.
  This changes what `--tools replay` does for a spec that used a live Ollama with replayed tools: it now needs a
  recorded answer or `--model live`. An injected test model is still used as it is.
- **What is recorded.** An answer, and one failure that is the model's own: a structured answer that broke its
  schema (`StructuredOutputError`), because the workflow shows the problems to the model and asks again and a
  replay must retrace that. A timeout, an unreachable Ollama or a missing key is the environment's, so it is
  never recorded.
- **A structured answer is parsed against the step's schema on replay**, so a schema that changed under a
  recorded answer fails by name ("re-record it") instead of returning the wrong shape.
- **Secrets.** The request and answer are redacted before keying and before writing, as the tool layers do. The
  run now collects the value of every secret slot a component tool reads, not only the model key
  (`collectRunSecrets`), because a tool result can carry such a value into a prompt: the tool fixture says
  `[REDACTED]` on replay, so a prompt recorded with the live value would never match.
- **`kampong doctor --tools replay`** checks that a workflow with model steps has at least one recorded model
  answer. Keys depend on prompts that exist only at run time, so doctor cannot say each call has one.
- **The template fixtures** come from the existing recorders, which now file the scripted stand-in's answers as
  model fixtures. The template tests run the shipped spec with no injected model and no placeholder credentials.

## Consequences

- The shipped templates run with no network, no key and no Ollama. Their model answers are scripted, not from a
  real model, and the READMEs say so.
- Every prompt change needs re-recording. That is the point (a stale answer is worse), but a prompt that embeds
  something volatile (a timestamp, a random id) would never hit; keep volatile values out of prompts, or use
  `--model live`.
- The hosted server and an exported project do not use fixtures; this is the CLI's `run` only, as the tool
  fixtures are.
