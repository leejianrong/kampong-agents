# ADR-0055: Step addressing and the spec mutation API

- Status: Accepted
- Date: 2026-10-19
- Deciders: Jian (product owner)
- Card: KAM-169 (the design). KAM-170 builds it end to end.

## Context

The canvas can add a step at the end of a list and edit a field in place. It cannot delete, rename, move or insert
into a foreach body or a branch arm. The reason is in `packages/spec/src/mutate.ts` (checked 2026-10-19): the only
write primitive is `PatchOp = set | add | remove` at an index path such as `["agent","workflow",2,"foreach","steps",0]`.
An index path goes stale the moment anything above it changes, and a patch knows nothing about references. Removing
step `fetch` with `remove` leaves every `{{ fetch.price }}` pointing at nothing.

What exists today:

- **One write path, two repositories.** `SpecRepository.applyPatchAndSave(ops)` (`packages/spec/src/repository.ts`)
  calls `applyPatchToSource(source, ops)`: parse the YAML into a `yaml` `Document`, `applyPatch`, `toString`,
  re-parse and validate with `parseSpec`, return `{ success, source, spec }` or `{ success: false, errors }`.
  `SpecStore` (filesystem) and `PgSpecRepository` (`specs.yaml_source`, bumping `specs.version`) both call it, so the
  semantics cannot drift. Nothing is written when validation fails.
- **Two routes.** Local `PUT /api/spec` (`packages/cli/src/server.ts`, wrapped in `watcher.beginMutation/endMutation`
  so the file watcher ignores our own write). Hosted `PUT /api/specs/:id` (`packages/server/src/routes/specs.ts`,
  workspace-scoped, ADR-0019). Both take `{ ops: PatchOp[] }` and answer `{ success: true, spec }` or 422
  `{ success: false, errors: SpecError[] }`. The canvas reaches both through `ApiClient.applyPatch(ops)`
  (`apps/canvas/src/api.ts`, ADR-0020).
- **Step lookup exists, addressing does not.** `listSteps(spec)` (`step-edit.ts`) returns every step, including branch
  arms and foreach bodies, with its index path, kind and the names of the steps it sits in. `specToGraph` (`graph.ts`)
  names nodes `workflow:<step>` and `tool:<name>`, and `.kampong/layout.json` is keyed by those ids (ADR-0006), so a
  rename also has to move a layout key.
- **A shared parity contract already exists.** `packages/spec/test/integration/repository-contract.ts` is run by
  `packages/cli/test/integration/spec-repository-contract.test.ts` (filesystem) and
  `packages/server/test/integration/db/spec-repository.test.ts` (Postgres, the `integration-db` vitest project).
  ADR-0054 item 5 asks for a parity suite; this one is the base to extend, not something new.
- **Step names are already near-unique.** `schema.ts` rejects a duplicate name anywhere in the workflow when a branch
  is involved, and rejects a foreach body step named like a workflow step, the loop variable (`as`) or a reserved
  name (`trigger`, `input`, `vars` in 1.1). One gap: version `"1.0"` tolerates a repeated top-level name ("left to
  the run"). Tool names are unique by schema.
- **References are of two kinds, and only one is validated at load.** In 1.1, `spec-expressions.ts` parses every
  expression with JSONata (`parseExpression`, `expressionPaths`, `templateExpressions`) and checks the leading names
  against the steps, `vars`, and the foreach scope. In 1.0 there is no validation: the engine resolves `{step.field}`
  and `{{ step.field }}` (`http-tool.ts`, regex `\{\{\s*([A-Za-z0-9_.]+)\s*\}\}|\{([A-Za-z0-9_.]+)\}`) and the
  condition grammar `step.field <op> literal` (`condition.ts`) at run time, and fails there with "has not produced
  output yet".

ADR-0054 says local and hosted share one mutation layer and leaves the internal representation open (item 6).

## Decision

### 1. Addressing

A **step is addressed by its name**: `{ "step": "fetch" }`. Names are the identity a reader already uses in
`{{ fetch.price }}`, and the schema already makes them unique, so a name survives every edit above it, including
inserts and moves. Index paths remain only for the raw `set`/`add`/`remove` ops, which keep their meaning.

A **place** (where a step goes) is a list slot plus an index:

```jsonc
{ "in": "workflow" }                                       // agent.workflow
{ "in": { "step": "each_alert", "slot": "steps" } }        // foreach body
{ "in": { "step": "route", "slot": "then" } }              // branch if: then | else
{ "in": { "step": "route", "slot": "cases", "key": "p1" } }// branch switch case
{ "in": { "step": "route", "slot": "default" } }           // branch switch default
// every place takes an optional "index" (0..length, default: append)
```

The place is structural JSON, not a string. A step name may contain any character (`.`, `:`, `/`, spaces), so a joined
path string would be ambiguous. Error messages render a place as `each_alert.steps[1]` for people only.

Other things:

- **Tool:** `{ "tool": "alerts_api" }`, by name (unique by schema).
- **Var (1.1):** `{ "var": "threshold" }`, by key under `vars`.
- **Duplicate names (a 1.0 spec only).** A name that matches more than one step is `ambiguous_step`. The caller falls
  back to the raw index-path ops, or fixes the names first. This is rare and the rule is stricter than guessing.
- **Stability.** A name is stable under insert, move and every edit elsewhere. Under rename it changes by design, and
  the response says so (`changes.renamed`), so the client updates its selection and layout.

### 2. The operations

A new type `SpecOp` in `packages/spec` is `PatchOp` plus the semantic ops below. The three patch ops are unchanged
and remain the way to edit a field (a step's `if`, `message`, `output_schema`, a tool's `url`).

| Op | New? | Meaning |
| --- | --- | --- |
| `set`, `add`, `remove` | existing | Raw index-path edit. Unchanged. |
| `step.insert` `{ place, step }` | new | Insert a full step object (already built by the form helpers, such as `buildWorkflowStepFromForm`) at a place. |
| `step.remove` `{ step }` | new | Remove the step and everything inside it. |
| `step.move` `{ step, to: place }` | new | Move the step, with its body, to another place. |
| `step.rename` `{ step, to }` | new | Rename and rewrite references (rule 3). |
| `tool.remove` `{ tool }` | new | Remove a tool. |
| `tool.rename` `{ tool, to }` | new | Rename and rewrite references. |
| `var.remove`, `var.rename` | new, last priority | Same machinery for `vars.<name>`; cut from KAM-170 if it runs long. |

Adding a tool or a var stays a `add`/`set` (nothing can refer to a name that does not exist yet). Reordering inside a
list is `step.move` with the same list as the place.

**Errors.** Each failed op returns a code and message, plus the op's position in the request (`opIndex`):

| Code | When |
| --- | --- |
| `step_not_found`, `tool_not_found`, `var_not_found`, `slot_not_found` | The name or slot does not exist. A branch `else` or `default` that was never written is not an error for `step.insert`, which creates it (see below); a `cases` key that does not exist is `slot_not_found`. |
| `ambiguous_step` | 1.0 duplicate name. |
| `name_taken` | Rename or insert collides with a step name anywhere in the workflow (arms and foreach bodies included, which is the schema's rule). Tools and vars check their own namespace. |
| `invalid_name` | Empty; in 1.1 equal to `trigger`, `input` or `vars`, or to the enclosing foreach `as`; in 1.0 not matching `[A-Za-z0-9_]+`, since the 1.0 grammar cannot spell it. A 1.1 name that is not a plain identifier is allowed and rewritten with backticks. |
| `bad_index` | Index out of range. |
| `move_into_self` | Moving a foreach or branch into its own body or arm. |
| `nested_foreach` | A foreach placed in a foreach body (schema: not supported yet, ADR-0043). |
| `approval_in_foreach` | A placed step is, or contains, one that pauses for a person, in a foreach body (ADR-0043). Rule below. |
| `needs_version_1_1` | A `transform`, `validate`, `dedupe`, `foreach`, `branch` or `stop` step into a `"1.0"` spec (ADR-0027). The canvas upgrades the spec first (KAM-199). |
| `has_references` | `step.remove` or `tool.remove` while something still reads it. Carries `references`. |
| `breaks_references` | `step.move` would put a reader before the step it reads, or move a step out of the scope that a reader can see. Carries `references`. |
| `unrewritable` | A rename found a reference it cannot rewrite with certainty. Rejected, never guessed. |
| `invalid` | The whole spec fails `parseSpec` after the ops. These are the existing `SpecError`s with line numbers. |
| `stale` | `baseRevision` no longer matches (rule 6). |

**Foreach and branch bodies.**

- A foreach body is the list at `foreach.steps`; a branch arm is `then`, `else`, a `cases` entry or `default`.
  `step.insert` into a branch `else` or `default` that does not exist yet creates the arm in the same op. `step.remove`
  of the last step in an arm leaves an empty arm only if the schema allows one; otherwise the result is an `invalid`
  error from the validator (it is the single judge of what a legal arm is).
- **No approval in a foreach body.** The pre-check `placementProblem(spec, step, place)` walks the placed step and
  everything inside it and returns `approval_in_foreach` for any of: a `type: approval` step; a `tool` step whose tool
  has `requires_approval: true`; a 1.0 `condition` step whose `then`/`else` is `request_human_approval` or
  `execute_tool(<tool needing approval>)`. Switching a tool's `requires_approval` on while a foreach body already
  uses it is a raw `set` op, so the pre-check does not see it; the validator does, and `schema.ts` reports it at the
  tool step's line. The validator is the backstop for all of it, so the structured code is a courtesy for the
  canvas, never the only guard.
- `nested_foreach` is checked the same way.

Operations apply in order to one in-memory document and **the whole request is validated once at the end**, so a
request can pass through an intermediate state that would not validate (rename a step, then edit the field that now
reads it). Any failure writes nothing.

### 3. Reference rewriting

**Every place a name can be read** (checked in `schema.ts`, `spec-expressions.ts`, `workflow.ts`, `http-tool.ts`):

| Where | Names | 1.0 | 1.1 |
| --- | --- | --- | --- |
| `if`, `transform.set.*`, `validate.assert` and `message`, `dedupe.once.key`, `branch.if` / `branch.switch`, `foreach.items`, `stop.reason` | step | Condition grammar `step.field op literal` (`if` of a `condition` step) | JSONata expression or `{{ ... }}` template |
| `{{ step.field }}` / `{step.field}` in any string of a step (`query`, `instructions`, `message`, ...) | step | `{step.field}` and `{{ step.field }}` | `{{ expr }}` |
| `url`, `body`, `headers`, and other templated fields of a tool | step | `{step.field}` / `{{ step.field }}` (simple dotted path) | the same (the engine's tool template is a simple dotted path in both versions) |
| tool step `tool:` | tool | yes | yes |
| 1.0 `condition` step `then` / `else`: `execute_tool(<name>)` | tool | yes | yes |
| `vars.<name>` in an expression | var | n/a | yes |
| `.kampong/layout.json` keys `workflow:<step>`, `tool:<name>` | both | yes | yes |
| `foreach.as` | loop variable, not a step | not a reference to a step; not rewritten | not rewritten |
| webhook `when`, `map`; `output_schema` | none | none: they read only `trigger` or define a shape | none |
| action `inputs: string[]` | none | field names, not step names | same |

The implementing card must re-grep for any further place that names a tool or a step (guardrails, component tools)
and add it to this table; the table is the contract, and a place missing from it is a bug.

**Finding references is parse-based.** `findReferences(spec, doc, { step | tool | var })` in `packages/spec`:

- 1.1 expression fields: `parseExpression` and `expressionPaths` (the same walker the loader uses, so "what reads
  `fetch`" and "what the loader checks" cannot disagree). Only the leading name of a root path is a read of a step;
  names inside a filter, lambda or `.(...)` are relative and left alone. `templateExpressions` finds the `{{ }}`
  spans in strings, honouring quotes and nested braces.
- 1.0 and tool templates: the engine's own template regex and condition pattern, exported from one place and shared
  by the engine and `@kampong/spec` so the rewriter cannot match something the engine would not. A prompt that
  merely contains `{fetch.x}` as literal text is indistinguishable from a reference in 1.0 and is treated as one;
  this is a known limit of the 1.0 syntax and a reason to upgrade.
- A **regex alone is never used on a 1.1 expression**: `fetch` inside a string literal, a field name (`order.fetch`),
  or a lambda parameter is not a reference.

Each reference is `{ path, kind, text }`: the YAML path of the field, the field kind (`expression`, `template`,
`tool`, `condition`, `tool_template`), and the matched text.

**Rename rewrites.** For each reference, the new text is spliced into the field's source string at the token's span.
In 1.1 the JSONata AST gives the position of the name token (its end offset; the span is recovered by scanning back
over the old name, with or without backticks) and the rewriter **verifies the text at that span equals the old
name** before splicing. A mismatch is `unrewritable`, never a guess. A new name that is not a plain identifier is
written in backticks in 1.1 and rejected in 1.0. The field is written back as a scalar with `Document.setIn`,
preserving its quoting style. The step's own `step:` key, the layout key and every tool/condition reference change
in the same op.

**Remove.** If any reference exists outside the removed subtree, the op fails `has_references` with the complete list
(path, text and line number), so the canvas shows "3 places read this step" with jump links. There is no force flag:
the author edits or removes the readers first, then retries. A removal that also removes the readers (a foreach and
its body) is allowed. The layout entry is dropped.

**Move.** A move does not change names, so nothing is rewritten. It is checked for ordering and scope. Execution
order is document order with arms and bodies in place. After the move, any reader that now precedes the step it
reads, or that is outside the scope that can see it (a step in one branch arm is hidden from its sibling arm; a
foreach body step is hidden outside the loop; the loop variable only exists inside the body), is a
`breaks_references` entry. Only **newly** broken reads are reported, so a spec that already has an odd read is
not blocked by an unrelated move. The 1.1 scoping comes from the validator's own scope model
(`spec-expressions.ts`), run before and after, and 1.0 uses document order, which is what the engine checks.

**1.0 vs 1.1.** 1.0 is a strict subset: no `vars`, no new kinds, simple templates and the condition grammar. The
rules are the same; 1.0 has fewer reference kinds, a stricter name pattern, and no load-time reference validation, so
`findReferences` is the only thing that protects a 1.0 delete or move.

### 4. Comments and formatting

Local mode stays on the `yaml` `Document` (ADR-0007, ADR-0052). Each semantic op is implemented as a small number of
`Document` calls (`insertIn`/splice on the target sequence, `deleteIn`, node moves that keep the node and its
comment, and `setIn` on a scalar), never "rebuild and re-stringify". Specific rules:

- A moved or inserted step keeps its own leading comment; a comment attached to a removed step goes with it. A comment
  above a list's first item that belongs to the list moves with the item that follows it.
- Rewriting a reference replaces the scalar's value but keeps its style (plain, quoted, `|` block), and the flow-style
  padding rules of ADR-0052 apply on save exactly as today (`toYamlString`, `lineWidth: 0`, majority padding).
  A `>-` folded block is still the one thing refolded.
- A pure no-op request (rename to the same name) writes nothing.
- A **round-trip fixture per op** is required: the source before and after is checked byte for byte against
  a hand-written expectation, for the fixtures in `packages/spec/test/integration/round-trip.test.ts`.

Hosted mode stores the same text (item 5), so it keeps comments in whatever it was given. ADR-0054's warning about
comments only applies if storage later becomes structured.

### 5. Internal representation: keep YAML text, patched through the `yaml` Document

ADR-0054 item 6 asks for a comparison. **Chosen: today's YAML text, mutated with the `yaml` `Document`, now through
semantic ops.** Operations are defined on the spec model (names, places, references), not on text, so the
storage can change under them later.

| | A. YAML text + `Document` patches (chosen) | B. Structured document (JSON) with YAML as serialiser |
| --- | --- | --- |
| **Undo and version history** | Version is a text snapshot. Undo is "restore a previous source". Needs an added `spec_revisions` table (hosted) or git (local); an addition, not a migration. Inverse of an op is its before/after text. | Natural: store op log or JSON snapshots, diff structurally. Same effort as A for snapshots; better for an op log. |
| **Diffing** | Line diff of YAML, which is what an author reading "For developers" expects. A semantic diff is derived by parsing both sides. | Structural diff is easy, but a text diff for the developer view is derived, and formatting is whatever the serialiser gives. |
| **LLM-generated edits** | LLMs read and write YAML well; a whole-file proposal can be validated and applied. A semantic op list is the better target (V8) and works on either. | Same. JSON is slightly easier to generate than YAML. |
| **Concurrent edits** | Whole-text optimistic concurrency (`baseRevision`). Two users editing different steps still conflict. A text merge is risky. | Op-level merge (or CRDT) is feasible later because ops are semantic. |
| **Comments and formatting** | Preserved in local and hosted. The product's strength for developers (ADR-0008). | Lost on import unless the comment is modelled; ADR-0054 accepts that for hosted, but local mode cannot. A second store for local would break item 5 of ADR-0054. |
| **Cost for KAM-170** | No migration. `specs.yaml_source` and `agent.yaml` stay. Work is ops, rewriting and routes. | A migration of `specs`, a second code path for local (comments), the import/export round trip becomes a separate feature, plus every existing test fixture. Roughly doubles the card. |
| **Drift risk** | One text and one parser. The `applyPatchToSource` seam already shared by both repositories. | A new serialiser to keep byte-stable, and the YAML view must be generated. |

Why A for now: the card constraint is that KAM-170 ships without a storage migration; the local mode must keep
comments; and none of B's wins are needed by the first release (history and concurrent editing are not in the
shipped scope). A's two weaknesses are addressed in the API rather than in storage: optimistic concurrency by
revision (rule 6) now, and a revisions table when history is built.

**Migration path to B.** Because the ops are semantic (`step.rename`, not "replace text"), a later move to a
structured store changes only what `applyOps` does: `SpecRepository.applyOpsAndSave` loads the document, applies the
ops, validates and saves. Hosted can switch first (`specs.spec_json` plus an export to YAML), local keeps A for
`agent.yaml`. The parity suite (rule 7) is the safety net: it compares specs, not text, so it holds through the
change. A trigger to revisit: undo/history or multi-user concurrent editing is committed for the hosted product.

### 6. API shape

**No new endpoints.** The mutation endpoint in each mode already exists and takes `{ ops }`; `PatchOp` is a subset of
`SpecOp`, so every existing caller keeps working. One endpoint per mode:

- local: `PUT /api/spec`
- hosted: `PUT /api/specs/:id`

```jsonc
// request
{
  "ops": [ /* SpecOp[] */ ],
  "baseRevision": "a1b2c3d4"      // optional
}
// 200
{
  "success": true,
  "spec": { /* validated spec */ },
  "revision": "a1b2c3d5",
  "changes": {
    "renamed": [ { "kind": "step", "from": "fetch", "to": "get_price" } ],
    "removed": [ { "kind": "step", "name": "old" } ],
    "rewrote": 3                    // references updated
  }
}
// 422 : the ops are invalid; nothing was written
{
  "success": false,
  "errors": [
    {
      "code": "has_references",
      "opIndex": 0,
      "message": "step \"fetch\" is read in 3 places",
      "path": ["agent","workflow",0,"step"], "line": 12, "column": 11,
      "references": [ { "path": ["agent","workflow",1,"if"], "kind": "expression", "text": "fetch.price > 10", "line": 18 } ]
    }
  ]
}
// 409 : baseRevision is stale
{ "success": false, "errors": [ { "code": "stale", "message": "..." } ], "revision": "a1b2c3d5" }
```

- `errors` stays an array of the existing `SpecError` (`path`, `message`, `line`, `column`) with **optional** `code`,
  `opIndex` and `references`. A caller that reads only `message` and `line` (the canvas does today) is unaffected.
  Validator errors from the final parse have no `code` or have `invalid`.
- **Revision.** Hosted: `String(specs.version)`, which `applyPatchAndSave` already increments. Local: a short hash of
  the file text. It is an optimistic-concurrency token, not part of the spec. `baseRevision` is optional; when given
  and stale the answer is 409 with the current `revision`. Hosted applies the write as
  `UPDATE ... WHERE version = $base` (and reads `FOR UPDATE` inside the existing `withWorkspaceScope` transaction).
  The present code reads then updates without a lock, so two concurrent saves can lose one; this ADR flags that and
  KAM-170 closes it.
- **Layout.** The repository applies a rename or removal to the layout (`workflow:<old>` to `workflow:<new>`, `tool:`
  likewise, drop on removal) in the same call as the spec write, and returns the new layout. Hosted does this in one
  transaction. Local writes two files, spec first; a crash between them leaves a stale layout, which
  `loadWithLayout` already repairs by auto-placing a node with no entry (ADR-0006).
- **Local file watcher.** The local route keeps `watcher.beginMutation()` / `endMutation(source)` exactly as
  `PUT /api/spec` does now (ADR-0008).
- **Repository seam.** `SpecRepository.applyPatchAndSave(ops: PatchOp[])` becomes `applyOpsAndSave(ops: SpecOp[],
  opts?: { baseRevision?: string })`, with `applyPatchAndSave` kept as a thin alias until callers move. The pure
  function `applyOpsToSource(source, ops)` in `packages/spec` replaces `applyPatchToSource` as the one implementation,
  and it also returns `{ layoutMoves, changes }`. Both repositories are thin: read, call it, write, bump revision.
- **ApiClient.** `applyOps(ops: SpecOp[], opts?: { baseRevision?: string }): Promise<ApplyOpsResponse>` is added next
  to `applyPatch(ops: PatchOp[])`, which stays and calls it. `ApplyOpsResponse` is
  `{ success, spec?, revision?, changes?, errors?: OpErrorDto[] }`. A 409 or 422 resolves to a response with
  `success: false` (it does not throw), because a rejected delete is an expected outcome the UI renders. Network and
  5xx errors still throw `ApiError`, as now. The in-memory wrapper that backs the canvas tests implements the same
  method by calling `applyOpsToSource`.

### 7. Parity tests

The seam is `packages/spec/test/integration/repository-contract.ts`, already run by both repositories. Extend it with
a table of **operation sequences**, each a list of `SpecOp[]` batches against a named fixture, with the expected
resulting spec (and, for rejections, the expected `code` and reference list). The same table runs against:

1. `applyOpsToSource` directly (unit speed, `packages/spec/test/unit` for the rewriting cases and error codes).
2. `SpecStore`, in `packages/cli/test/integration/spec-repository-contract.test.ts` (filesystem, temp dir).
3. `PgSpecRepository`, in `packages/server/test/integration/db/spec-repository.test.ts` (the `integration-db`
   vitest project, a real Postgres with a non-superuser role and RLS on).

The assertion is **equality of the parsed spec and the layout map**, plus identical error codes, not equality of
text. Text equality is asserted only in the `@kampong/spec` round-trip fixtures (rule 4), where the formatting
guarantee lives. Both repository runs also check that a rejected request leaves storage untouched, and that a stale
`baseRevision` returns `stale`.

Route-level parity: the existing `packages/cli/test/integration/server.test.ts` and
`packages/server/test/integration/routes/specs.test.ts` each gain one case per response shape (200, 422 with a
`references` list, 409), so the HTTP body matches the shape in rule 6 in both modes.

CI: `npm run test:integration` runs `--project integration --project integration-db`; the CI `integration` job
(`.github/workflows/ci.yml`) already starts Postgres 18 and provisions the `app_test` role, so the Postgres half runs
there with no workflow change. Locally the DB half self-skips without `DATABASE_URL`, so the pre-push hook
(`test:unit`) still runs the spec-level table. The skip must stay loud: KAM-170 must not add a way for the Postgres
half to be silently excluded in CI.

## Worked examples

All examples are version `"1.1"`.

### A. Insert into a foreach body

Before:

```yaml
version: "1.1"
agent:
  id: alerts
  workflow:
    - step: each_alert
      foreach:
        items: trigger.alerts
        as: alert
        steps:
          # look the symbol up
          - step: lookup
            action: fetch the latest price for {{ alert.symbol }}
```

Operation:

```json
{ "op": "step.insert",
  "place": { "in": { "step": "each_alert", "slot": "steps" }, "index": 1 },
  "step": { "step": "check", "type": "validate", "assert": "lookup.price > 0" } }
```

After (the comment and the rest of the file are untouched):

```yaml
        steps:
          # look the symbol up
          - step: lookup
            action: fetch the latest price for {{ alert.symbol }}
          - step: check
            type: validate
            assert: lookup.price > 0
```

`check` reads `lookup`, which sits earlier in the same body, so it is allowed. Inserting `{ "step": "ask",
"type": "approval" }` at the same place fails with `approval_in_foreach`, naming `each_alert.steps[1]`.

### B. Rename with reference rewrite

Before:

```yaml
agent:
  workflow:
    - step: fetch
      action: get the price of {{ trigger.symbol }}
    - step: gate
      type: validate
      assert: fetch.price > 0 and $exists(fetch.price)
      message: "No price for {{ fetch.symbol }}"
    - step: report
      action: write it up
      query: "{{ `fetch`.price }} and the word fetch.py"
```

Operation: `{ "op": "step.rename", "step": "fetch", "to": "get_price" }`

After:

```yaml
    - step: get_price
      action: get the price of {{ trigger.symbol }}
    - step: gate
      type: validate
      assert: get_price.price > 0 and $exists(get_price.price)
      message: "No price for {{ get_price.symbol }}"
    - step: report
      action: write it up
      query: "{{ get_price.price }} and the word fetch.py"
```

`changes`: `{ renamed: [{ kind: "step", from: "fetch", to: "get_price" }], rewrote: 4 }`. The literal `fetch.py` in
plain text outside `{{ }}` is not a reference in 1.1 and is left alone. The backticked form is rewritten and the
backticks dropped because the new name is an identifier. The layout key `workflow:fetch` becomes
`workflow:get_price`.

### C. A rejected delete

Operation (same `Before` as B): `{ "op": "step.remove", "step": "fetch" }`

Response, HTTP 422, nothing written:

```json
{ "success": false,
  "errors": [ {
    "code": "has_references", "opIndex": 0,
    "message": "step \"fetch\" is read in 3 places; edit or remove them first",
    "path": ["agent", "workflow", 0, "step"], "line": 4, "column": 14,
    "references": [
      { "path": ["agent","workflow",1,"assert"],  "kind": "expression", "text": "fetch.price > 0 and $exists(fetch.price)", "line": 8 },
      { "path": ["agent","workflow",1,"message"], "kind": "template",   "text": "{{ fetch.symbol }}", "line": 9 },
      { "path": ["agent","workflow",2,"query"],   "kind": "template",   "text": "{{ `fetch`.price }}", "line": 12 }
    ] } ] }
```

The request `[ step.remove fetch, step.remove gate, step.remove report ]` succeeds, because every reader goes in the same
request and the check is made against the final document.

## Consequences

- KAM-170 has a defined scope: `SpecOp` and `applyOpsToSource` in `packages/spec` (with `findReferences`,
  `placementProblem`, the shared template regex), `applyOpsAndSave` on both repositories, the two existing routes widened,
  `ApiClient.applyOps`, the revision token and layout moves, and the contract table. No storage migration.
- Existing callers and the 422 body are backward compatible; `errors[].code` and `references` are additions.
- A step name is now an API. Renaming through the canvas is safe; renaming by hand in YAML is still a text edit, and
  the loader's existing "not something an expression can read" error is what finds a miss.
- 1.0 specs get delete/rename/move protection from `findReferences` alone, and a literal `{x.y}` in a 1.0 prompt
  is treated as a reference. Both are reasons to offer the 1.0 to 1.1 upgrade first.
- History and undo are not delivered here. They need a `spec_revisions` table (hosted) and have a defined place to
  attach: the revision token returned by every successful write.
- Open for the build card: the exact set of fields a tool's `{...}` templates cover (the table in rule 3 is
  the minimum), whether `var.*` ops ship in the same card, and whether a literal `fetch` in plain 1.1 prose outside
  `{{ }}` should ever be flagged (this ADR says no).
- `AGENTS.md` and `docs/reference/` change when KAM-170 lands, in that PR, not this one.

## Implementation notes (KAM-170)

What the build settled, where it differs from the text above, and what it left out.

- **Reference places.** A re-grep of `schema.ts` found no further place that names a step or a tool: guardrails,
  `approval_notifier`, `knowledge_base`, triggers (`when`, `map`, `respond`) and `foreach.on_error` (`goto` is rejected by
  the schema) do not. A tool is scanned as a whole: every string under it except `name`, `use` and `action`, which
  covers a component tool's `with`, `config` and `secrets` as well as `url`, `body` and `headers`. A `${ENV}` is not
  read as a placeholder.
- **Shared patterns.** The engine's placeholder, condition and `execute_tool` patterns are copied into
  `packages/spec/src/references.ts`, not imported by the engine, because `http-tool.ts`, `condition.ts` and
  `workflow.ts` are vendored into exported projects (ADR-0010) and must not depend on `@kampong/spec`. A unit test
  reads the engine files and fails if the copies drift.
- **One loop-variable rule.** A step name may not equal the `as` of any foreach in the workflow (that is what
  `schema.ts` enforces), not only the enclosing one, so `invalid_name` fires before the validator does.
- **Refusal lines are in the file as it is.** `has_references` and `breaks_references` report each read at the
  path and line it has in the saved file, not in the edited copy the check ran on.
- **The save path now uses `toYamlString`.** `applyPatchToSource` still serialised with `doc.toString`, which refolds
  long scalars at 80 columns, so ADR-0052 did not hold for a canvas save. All writes go through `toYamlString`
  now. A source that does not parse is returned as errors instead of throwing.
- **A request that changes nothing writes nothing** and keeps its revision, in both repositories.
- **`var.remove` and `var.rename` are not built.** They are a follow-up on the same machinery.
- **Hosted concurrency.** `PgSpecRepository.applyOpsAndSave` reads the row `FOR UPDATE` and writes
  `WHERE version = <read>`, so two concurrent saves serialise instead of one being lost.
