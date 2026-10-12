# ADR-0041: `transform`, `validate` and `dedupe` steps

Status: accepted (KAN-1860)

## Context

An unattended workflow (ADR-0028, the schedule trigger of ADR-0040) spends most of its steps on plain data work: turn
two prices into a percent change, refuse a record that is malformed, skip an alert already handled. Without
dedicated steps that work goes through a model call (slow, costly, not deterministic) or an HTTP tool pointed at
nowhere. The expression language (ADR-0027) and the durable store (ADR-0028) already exist; these steps are the
thin layer that uses them.

## Decision

- **Version 1.1 only.** Each is a `type:` of a workflow step. In a 1.0 spec the validator says `transform needs
version "1.1"`, at the line of `type`. Every field that holds an expression is a whole JSONata expression, as
  `if` is (not `{{ }}` text), and goes through the same load-time checks: syntax, denied built-ins, and that every
  root name it reads exists. The error carries the YAML line of the field.
- **`transform`** `set: { name: expression, ... }`. The step's output is the object of the values, so a later step
  reads `shape.change`. Every expression reads the data as it was before the step (trigger, vars, input, earlier
  steps), never another value of the same step. A value that selects nothing fails the step, naming the field,
  rather than silently dropping a key (the spike's "undefined is silent" finding). Names are plain identifiers.
- **`validate`** `assert: expression`, `on_fail: fail | skip` (default `fail`), optional `message` (text with
  `{{ }}`). The assertion must be `true` or `false`, as a condition must. On failure `fail` ends the run as failed
  with the message; `skip` ends it as completed with the output so far and `skipped: { step, reason }` (on the run
  state, the `completed` event, and `--json` output), and nothing after it runs. The step's output is
  `{ passed: true }` or `{ passed: false, skipped: true }`.
- **`on_fail: branch` is rejected** with "on_fail: branch is not yet supported (it needs conditional branching,
  KAN-1859)" at the field's line. It stays in the Zod enum so that message can be specific; the published JSON Schema
  therefore still lists it, and the validator is what refuses it. The engine refuses it too, if a spec reaches it
  unvalidated.
- **`dedupe`** `once: { key: expression, ttl: "24h" }`. The first run to claim a key within its ttl continues; any other
  one ends as completed with `skipped` set (reason `duplicate key ...`) and the step's output
  `{ duplicate: true, key }`. `ttl` is required, `30s`/`15m`/`6h`/`7d` (the schedule's `every` grammar, at least one
  second; `parseEvery`). The key must evaluate to a string, number or boolean; nothing, a list or an object fails the
  step. The claim is `StateStore.putIfAbsent` on `dedupe:<agent.id>:<step>:<key>` with the ttl, so it is atomic
  across processes and survives a restart. Renaming the step or the agent id starts a fresh set of keys.
- **The store is an injection seam.** `EngineDeps.state` (a store the caller owns) or `EngineDeps.openState` (a
  lazy opener; the run closes a store it opened). `createAgentRun` supplies, only when the spec has a `dedupe` step
  and no `state` was passed, an opener for the SQLite store at `statePath` (default `.kampong/state.db` in the working
  directory) through a **dynamic import**, so a spec without one never loads `node:sqlite` or creates the file, and
  nothing on the barrel path imports it statically. `kampong run` puts the file in `<spec dir>/.kampong/`.
  `kampong dev` and `kampong serve` use the working directory's, as the runner of ADR-0040 already does.
- **Export.** `workflow.ts` and `run.ts` are vendored as before (parity-tested); `sqlite-state-store.ts` joins them,
  loaded lazily, with no dependency to pin (`node:sqlite`, Node 22). The generated README says where the file is and
  that a container needs `/app/.kampong` as a volume. The entry point prints `skipped` like `kampong run` does.
- **Canvas.** The Add Workflow Step form gains Transform, Validate (fail or skip only) and Dedupe, built by the same
  `buildWorkflowStepFromForm` the other kinds use. Editing a step in place and expression editing remain KAN-1850.

## Not in this card

- **The open/close lifecycle** (mark a key as in progress on open, make it permanent on close, release it if the run
  fails, so a failed run can be retried). The step claims the key when it runs. Consequence: if a later step fails,
  the key stays claimed until its ttl and a retry is skipped as a duplicate. Choose a ttl with that in mind, or put
  the dedupe step last. The lifecycle needs a run-end hook to release on failure; it is follow-up work.
- **`on_fail: branch`**: still rejected after KAN-1859; a `branch` step with a `stop` does the same job (ADR-0045).
- The hosted server still refuses 1.1 specs (ADR-0027), so these steps run locally and in exports only.
