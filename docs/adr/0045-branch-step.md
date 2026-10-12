# ADR-0045: The `branch` step (if/else and switch) and the `stop` step

Status: accepted (KAN-1859)

## Context

Until now a workflow was a flat list. The one conditional, the `condition` step, picks between two strings
(`execute_tool(name)` or `request_human_approval`), so "answer if confident, otherwise escalate" and "ignore a
duplicate, otherwise open a ticket" needed a trick or could not be written. ADR-0043 left `on_error: goto` and ADR-0041
left `validate on_fail: branch` waiting for this card. The `condition` step stays as it is for 1.0 specs; it is not
removed or deprecated in 1.1.

## Decision

- **Version 1.1 only.** A step with a `branch` key (no `type`, as `foreach` is written), in either of two forms:

  ```yaml
  - step: route
    branch:
      if: "triage.confidence > 0.8" # a whole JSONata expression that gives true or false
      then: # a list of steps
        - step: answer
          type: tool
          tool: reply
      else: # optional; leave it out for "nothing to do"
        - step: hand_off
          type: tool
          tool: escalate

  - step: route
    branch:
      switch: "classify.label" # a string, number or boolean, compared as text
      cases:
        duplicate:
          - step: ignore
            stop: { reason: "duplicate {{ trigger.id }}" }
        urgent:
          - step: page
            type: tool
            tool: escalate
      default: # optional
        - step: answer
          type: tool
          tool: reply
  ```

  `if` and `switch` are checked as every expression is (syntax, denied built-ins, every root name exists), at their
  own line. In a 1.0 spec the validator says `branch needs version "1.1"`. An arm is a list of **any** steps:
  actions, tools, approvals, conditions, data steps, a `foreach`, another `branch`, a `stop`.

- **`stop`** `stop: { reason?, status? }` ends the run successfully. `reason` is text with `{{ }}`; with none it says
  `stopped at step "<name>"`. `status` is `skipped` (the default) or `completed`:
  - `skipped`: the run completes with `skipped: { step, reason }`, the same field ADR-0041's `validate`/`dedupe` set
    (run state, the `completed` event, `--json`). It means "there was nothing to do".
  - `completed`: the run completes with no `skipped`; the reason is only in the step's own output.

  Either way the step's output is `{ stopped: true, status, reason }` and nothing after it runs. **Inside a foreach
  body a stop ends only that item** (as `validate` skip does there, ADR-0043): `skipped` puts the item in the loop's
  `skipped` list with the reason, `completed` keeps it in `results` with the outputs so far.

- **Data model.** Step outputs are one flat namespace, so a step in a **taken** arm leaves its output where the steps
  after the branch read it (`answer.status`). The outputs of an **untaken** arm are absent: a later step that reads
  them evaluates to nothing, which a `transform` reports and an `if` treats as false (ADR-0027). The branch step's own
  output says which arm ran: `{ taken: "then" | "else" | "none" }` for `if`; `{ taken: "<case value>" | "default" |
"none", value: "<the switch value as text>" }` for `switch`. `none` is a branch with no matching arm and no
  `else`/`default`; it is not an error. (A case literally named `default` or `none` is ambiguous in `taken`; read
  `value`.) The branch step completes, and its output exists, before the arm's steps run.

- **Switch matching.** The value must be a string, number or boolean (nothing, a list or an object fails the step), and
  is compared as text to the case keys, so `1` selects the case written `1`, and `true` selects `true`.

- **Validation, each with the YAML line:**
  - An empty `then`, `else`, case or `default` is rejected (leave `else`/`default` out to do nothing); so is a switch
    with no cases.
  - A duplicate case value is rejected. Two identical keys are already a YAML syntax error; this also catches `1` and
    `"1"`, which YAML treats as different keys and a switch as one.
  - A step name used twice in a workflow is rejected when a branch is involved (a step in two arms, or in an arm and
    outside it). The names in all arms share the one flat namespace above. (A repeated name among top-level steps
    alone is not checked, as before.)
  - A step after a `stop` in the same list is "unreachable". So is a step after a branch whose **every** arm always
    ends the run, which needs a final `else`/`default` that also ends it.
  - An expression in one arm that reads a step defined in a **sibling** arm of the same branch is rejected ("is a step
    in another arm of branch ..."); so is the branch's own `if`/`switch` reading a step of its arms. Reading an arm's
    step after the branch is allowed (it is present only if that arm ran).
  - Reserved names (`trigger`, `input`, `vars`) are rejected for steps at any depth.
  - A malformed step in an arm is reported at its own line, not at the branch.

- **Nesting with `foreach`.** A `foreach` in an arm is fine. A `branch` in a foreach body is fine: it runs per item
  with the loop variable and the body steps before it in scope, and its arms' step names are body-scoped (they may not
  repeat the loop variable, a workflow step name or each other). A `foreach` in an arm in a body is still "a foreach
  inside a foreach". The restrictions on a body (no approvals, ADR-0043) apply to its branch arms as well, and the
  `on_error` retry policy applies to the leaf steps of arms in a body as it does to the body's own.

- **Approvals inside a branch work.** The pause record of ADR-0042 gains `stepPath`, where the paused step is:
  `[2, "then", 0]` is the first step of the `then` arm of the third workflow step; the arm name is `then`, `else`,
  `case:<value>` or `default`, and it nests (`[1, "default", 0, "then", 0]`). `stepIndex` is kept (the first element)
  and a record without `stepPath` (written before this card) resumes from `[stepIndex]`. Resuming goes straight back
  into the arm that was taken at the pause **without evaluating the condition again** (so a clock or an external change
  cannot send a resumed run down the other arm), runs the rest of the arm and the steps after the branch, and does not
  re-run the arm's earlier steps. The stored outputs include the branch step's own. If a spec edit removed the arm the
  spec hash already refuses the resume (ADR-0042); the engine also fails visibly if the arm is gone. Both the
  persisted and the in-memory path use the same path matching.

- **Events and tracing.** `step_started`/`step_completed` carry the plain step name for steps in an arm of the
  workflow (the namespace is flat), and `<loop>[<index>].<step>` for those in a loop body, as ADR-0043 names them.

- **`validate ... on_fail: branch` stays rejected**, with the message "on_fail: branch is not supported (use a branch
  step with the negated assertion and a stop instead)". The natural `on_fail: { branch: [steps] }` is not small: it
  leaves open whether the run carries on after the steps (a failed assertion that carries on is not "failed"), and it
  needs the data step to run nested steps. The same thing is already written as
  `branch: { if: "not(<assertion>)", then: [..., { stop }] }`. The enum value stays in the schema so the message is
  specific.
- **`on_error: goto` stays rejected** for the same reason (a `branch` inside the body decides what to do per item); its
  message now says so instead of waiting for this card.

- **Export.** `workflow.ts` and `pending-approval.ts` are vendored as before (parity-tested); `spec-types.ts` gains
  `BranchStep` and `StopStep`; the README's dedupe and pending-approval notes also look inside arms and loop bodies.
  The e2e equivalence test runs a branch, a switch, a stop and a per-item stop in an exported project.
- **Canvas.** A branch node shows `Branch: <step>`, its `if`/`switch` expression and each arm under a heading
  (`then`, `else`, `case <value>`, `default`) with its steps listed, read-only, like a foreach; a stop node says how it
  ends and why. The Add Workflow Step form creates an if/else branch whose arms are lists of tool steps, and a stop.
  Switch branches, nested non-tool steps and editing an arm in place are written in the YAML (follow-up).
- **The JSON Schema** is now recursive: the workflow step is a `$ref` into `definitions` (zod emits it for a
  self-referencing schema), so the checked-in artifact changed shape, not only content.

## Not in this card

- Arms as their own canvas nodes with edges and in-place editing, and a form for switch branches and arms of
  non-tool steps.
- `on_fail: { branch }` and `goto`, as above; a loop `continue`/`break`.
- Approvals inside a `foreach` body (ADR-0043), including in a branch within one.
- A dead-code check for a `switch` whose cases cannot all be reached, and exhaustiveness checks.
- The hosted server still refuses 1.1 specs (ADR-0027), so branches run locally and in exports only.
