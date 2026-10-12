# ADR-0043: The `foreach` step, with an `on_error` policy and `errors[]`

Status: accepted (KAN-1858)

## Context

market-etl has to carry on past a rate-limited symbol. ADR-0027 promised "`foreach` isolates errors per item and
exposes an `errors[]` run output" and named a `foreach` item list as an expression. Until now a failing step ended the
run (ADR-0041's `validate` and `dedupe` end it too, quietly or not), and a workflow was a flat list of steps with no
way to repeat some of them for each element of a list.

## Decision

- **Version 1.1 only.** A workflow step with a `foreach` key (no `type`, as the step is named by what it does, like
  `action` steps):

  ```yaml
  - step: each_symbol
    foreach:
      items: "trigger.symbols" # a whole JSONata expression, as `if` is
      as: symbol # the loop variable, read by expressions as `symbol`
      concurrency: 2 # 1 to 32, default 1
      on_error: continue # fail (default) | continue | retry{...}
      steps: # a nested step list
        - step: fetch
          type: tool
          tool: fetch_price
        - step: write
          type: tool
          tool: store_row
  ```

  In a 1.0 spec the validator says `foreach needs version "1.1"`. Every error carries the YAML line, including those in
  nested steps (a nested step's path is `agent.workflow[i].foreach.steps[j]...`).

- **The body.** Any existing step kind except another `foreach` and approvals (below): `action`, `tool`, `condition`
  (with an `execute_tool(...)` branch), `transform`, `validate`, `dedupe`. Expressions in the body read the loop
  variable and the outputs of the body steps that ran before them, in addition to `trigger`, `input`, `vars` and the
  workflow's own steps. The same names are visible to `{{ }}` in a tool the body calls (a tool is declared once, so
  the validator accepts any loop name there). `as` and the body step names may not be a reserved name (`trigger`,
  `input`, `vars`), the name of a workflow step, each other, or a duplicate.

- **The result.** The step's output (so `each_symbol.results`, `.errors`, `.skipped`, `.count` in later expressions)
  is `{ results, errors, skipped, count }`:
  - `results`: one object of body step outputs (by step name) for each item that completed, in item order. Failed and
    skipped items are not in it, so its length is not `count`. Anyone who needs to match a result to its item reads
    the loop variable in a `transform`.
  - `errors`: `{ index, item, step, message }` for each item that failed and was isolated.
  - `skipped`: `{ index, item, step, reason }` for each item a `validate` with `on_fail: skip` or a `dedupe` duplicate
    ended. Inside a loop these end the _item_, not the run (they end the run at the top level, ADR-0041). The
    natural use is `dedupe` on the item's id.
  - `count`: how many items the list had.

  The loop variable and the body step names are scoped to the loop; they are not left in the run outputs.

- **`items` must be a list.** It is evaluated once, before any item runs. A value that is not a list (a string, an
  object, a number) or nothing at all fails the step with a message that says what it got and how to wrap one value in
  a list. A list with one element is fine.

- **Per-item error isolation.** Body steps run in order for an item; the first one that fails ends that item. The
  steps after it do not run, so an item never leaves a partial result: a `store_row` after a rate-limited `fetch` is
  not called for that item. `on_error` says what happens next:
  - `fail` (default): the run fails, naming the item index and the step. No new item starts; items already in flight
    finish. With concurrency the failure reported is the lowest index among them (deterministic).
  - `continue`: the item goes to `errors` and the loop moves on.
  - `retry: { n, backoff?, base_ms?, max_delay_ms?, then? }`: the _failed step_ is re-run up to `n` times (1 to 10),
    with the delays of the rest of the engine (`backoff` `fixed` or `exponential`, default exponential; `base_ms`
    default 500; capped at `max_delay_ms`, default 30 s), slept on the injectable `clock`. Earlier steps of the item
    are not repeated, so a write that already happened is not done twice. Only a call that leaves the process
    (`action`, `tool`, `condition` calling a tool) is retried; a failed assertion or a missing value would fail again,
    so it goes straight to `then`. When retries run out, `then` decides: `fail` (default) or `continue`; the message
    ends "(after n retries)". A `Retry-After` header is not read here, though a tool's own `retry` policy (ADR-0029)
    still applies inside each attempt.
  - `goto` is **not yet supported** (it needs conditional branching, KAN-1859). `on_error: goto` and
    `on_error: { goto: step }` stay in the shape so the validator can say "on_error: goto is not yet supported" at the
    field's line; the engine refuses it too if a spec reaches it unvalidated.

- **Bounded concurrency.** `concurrency` items are in flight at once, taken from the list in order (a pool of workers,
  not batches). Results are collected by item index, so their order does not depend on timing. The cap is 32.

- **Events.** The loop emits its own `step_started`/`step_completed` (the completed one carries the output above), and
  each nested step emits both under the name `<loop>[<index>].<step>` (`each_symbol[1].fetch`). Events from
  concurrent items interleave; the `index` in the name tells them apart.

- **Rejected at validation, for now.**
  - **A `foreach` inside a `foreach`**: "a foreach inside a foreach is not supported yet", at its line. It is accepted
    by the shape only (`{ step, foreach }`) so that message can be specific, and so the JSON Schema is not recursive.
    The engine refuses it too.
  - **Approvals in a body**: an `approval` step, a `condition` branch `request_human_approval`, a `tool` (or branch
    tool) whose declaration has `requires_approval: true`, and a `confidence_gate` step while
    `guardrails.confidence_threshold` is set. A loop cannot pause for a person: the pause record of ADR-0042 is
    indexed by a top-level step, and N concurrent pauses would each need their own. At run time the validator cannot
    see an approval that a component op's effect implies (ADR-0030); that item fails with "approval is not supported
    inside a foreach body yet", which `on_error` isolates like any failure. Lifting the restriction needs the pause
    record to carry an item index, and a decision on what concurrent pending items mean.

- **Export.** `workflow.ts` is vendored as before (the parity test compares it with the engine's; `spec-types.ts` gains
  `ForEachStep`/`BodyStep`). The generated README's dedupe-state note also fires for a `dedupe` in a loop body.

- **Canvas.** A foreach node shows `Foreach: <step>`, a line with its list, variable, `on_error` and concurrency, and
  its nested steps as a list; the nodes below it in the column are moved down to make room (display only, the sidecar
  layout is untouched). The Add Workflow Step form can create a foreach whose body is a list of tool steps. Nested
  steps are not editable on the canvas yet, nor are they separate nodes with edges (follow-up card).

## Not in this card

- `goto` (not built: a `branch` inside the body covers it, ADR-0045), a foreach in a foreach, and approvals inside a body.
- Nested steps as their own canvas nodes with in-place editing, and a canvas form for non-tool body steps.
- A loop index variable (`<as>_index`); an expression can use `$count` and the position in a list it already has.
- The hosted server still refuses 1.1 specs (ADR-0027), so loops run locally and in exports only.
