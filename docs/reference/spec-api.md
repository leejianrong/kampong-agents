# Spec editing API

The canvas changes a spec through one endpoint per mode. The request is a list of operations. They
are applied in order to one in-memory copy of the spec and validated once at the end; if any
operation fails, nothing is written. Design and reasons: [ADR-0055](../adr/0055-step-addressing-and-mutation-api.md).

| Mode                      | Endpoint                                          |
| ------------------------- | ------------------------------------------------- |
| Local (`kampong dev`)     | `PUT /api/spec`                                   |
| Hosted (`packages/server`) | `PUT /api/specs/:id` (session cookie, workspace) |

```jsonc
// request
{
  "ops": [ /* operations, below */ ],
  "baseRevision": "a1b2c3d4"   // optional: refuse the write if the spec has changed since
}
```

## Operations

`set`, `add` and `remove` edit a field at an index path (`["agent", "workflow", 2, "action"]`) and
are the way to change a step's own fields. The step and tool operations address by **name**, so
they keep working when something above them changes, and they keep references valid.

| Operation                                    | Effect                                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| `{ op: "step.insert", place, step }`         | Insert a step object at a place.                                |
| `{ op: "step.remove", step }`                | Remove a step and everything inside it.                         |
| `{ op: "step.move", step, to: place }`       | Move a step (with its body or arms) to another place.           |
| `{ op: "step.rename", step, to }`            | Rename a step and rewrite every read of it.                     |
| `{ op: "tool.remove", tool }`                | Remove a tool.                                                  |
| `{ op: "tool.rename", tool, to }`            | Rename a tool and rewrite every use of it.                      |

A **place** is a list and an index in it (the index defaults to the end; for a move it is the
final position):

```jsonc
{ "in": "workflow", "index": 0 }
{ "in": { "step": "each_alert", "slot": "steps" } }                  // a foreach body
{ "in": { "step": "route", "slot": "then" } }                        // a branch: then | else
{ "in": { "step": "route", "slot": "cases", "key": "urgent" } }      // a switch case
{ "in": { "step": "route", "slot": "default" } }
```

Inserting into a branch `else` or a switch `default` that does not exist yet creates it.

Rules that apply to every operation:

- A step name is used once per workflow, branches and foreach bodies included. In a `"1.1"` spec a
  name cannot be `trigger`, `input` or `vars`, or a foreach's `as`. In a `"1.0"` spec a new name
  can use only letters, digits and `_`.
- A foreach body cannot hold an approval step, a tool that requires approval, or another foreach.
- A `"1.1"` step kind (`transform`, `validate`, `dedupe`, `foreach`, `branch`, `stop`) cannot go
  into a `"1.0"` spec: upgrade it first.
- **Rename** rewrites each read of the step: `{{ name.field }}` and JSONata expressions in `"1.1"`,
  `{name.field}` and the condition `name.field > 3` in `"1.0"`, and `{name.field}` in a tool's
  `url`, `body` and the like. A name inside a string literal or another object's field is not a
  read and is left alone. The layout entry moves with it.
- **Remove** is refused while anything outside the removed steps still reads it (`has_references`).
  Remove the readers in the same request and it goes through.
- **Move** is refused when it would put a step before one it reads, or out of the branch arm or
  loop that can see it (`breaks_references`).

## Responses

```jsonc
// 200
{
  "success": true,
  "spec": { /* the validated spec */ },
  "revision": "a1b2c3d5",
  "changes": {
    "renamed": [{ "kind": "step", "from": "fetch", "to": "get_price" }],
    "removed": [],
    "rewrote": 3                     // reads rewritten
  }
}

// 422: refused, nothing written
{
  "success": false,
  "revision": "a1b2c3d4",
  "errors": [{
    "code": "has_references",
    "opIndex": 0,
    "message": "step \"fetch\" is read in 3 places: edit or remove them first",
    "path": ["agent", "workflow", 1, "assert"], "line": 8,
    "references": [{ "path": ["agent", "workflow", 1, "assert"], "kind": "expression",
                     "text": "fetch.price > 0", "line": 8 }]
  }]
}

// 409: baseRevision is out of date, nothing written
{ "success": false, "revision": "a1b2c3d5", "errors": [{ "code": "stale", "message": "..." }] }
```

`errors` is the same list as for a plain patch (`path`, `message`, `line`, `column`), with optional
`code`, `opIndex` (which operation of the request) and `references`. An error without a `code` is
the validator's, about the spec as it would be after all the operations. Line numbers refer to the
file as it is now, not as it would be after the change.

Codes: `step_not_found`, `tool_not_found`, `slot_not_found`, `ambiguous_step`, `name_taken`,
`invalid_name`, `invalid_step`, `bad_index`, `move_into_self`, `nested_foreach`,
`approval_in_foreach`, `needs_version_1_1`, `has_references`, `breaks_references`, `unrewritable`,
`stale`.

`revision` is a token for the spec's current state. Locally it is a hash of the file text, so an edit
made outside the canvas changes it too. Hosted, it is the spec's version. Send it back as
`baseRevision` to make a write conditional.

## From TypeScript

`@kampong/spec` exports `applyOpsToSource(source, ops)` (pure, no I/O), `findReferences(source,
{ step } | { tool })`, and `SpecRepository.applyOpsAndSave(ops, { baseRevision })`. The canvas's
`ApiClient.applyOps(ops, { baseRevision })` resolves with `success: false` and the errors for a
422 or 409, and throws only for a transport or server error. `applyPatch(ops)` is kept and throws on a
refusal.
