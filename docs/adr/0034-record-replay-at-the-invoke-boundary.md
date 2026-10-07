# ADR-0034: Record and replay a module op at the invoke boundary

Date: 2026-10-07. Status: accepted. Card: KAN-1833. Builds on ADR-0029, ADR-0031 and the V3 mock/record layer.

## Context

`--tools record|replay` wraps `fetch`. That makes a rest component, and a module that only uses
`ctx.fetch`, deterministic. A module that speaks IMAP, SQL or runs a local embedding model makes no fetch
call, so nothing was recorded and a replay ran its code, and needed its credentials, for real. The doctor
had to downgrade a module's missing fixture to a warning for that reason.

## Decision

- **A module op is recorded as an outcome**: `{ ok: true, data }` or `{ ok: false, error }`, keyed on the
  tool name (`id.op`), the op and the canonical JSON of the op's input (key order does not matter), in
  the same `.kampong/fixtures` folder as the HTTP fixtures. Two calls that differ only in one input field
  therefore cannot collide, which is the structural form of the POST-body fix in KAN-1829.
- **Replay does not run the module.** No runner, isolation requirement, secret or network is needed. A
  recorded result is validated against the op's declared output like a live one; a recorded error is
  rethrown as the same `ToolCallError`, keeping its code, status and the module's own error status.
- **A miss is a `MissingFixtureError`**, never a live call.
- **Secrets are redacted** from input and outcome before writing, using the values the module read
  through `ctx.secrets.get` plus the CLI's configured list, so a rotated secret still finds its fixture.
- **What is recorded.** A result, and an error that carries an HTTP-style numeric `status`. Any other
  error says nothing about why it failed (a refused connection, a bad import, a refusal the module caught
  and rethrew as a plain Error all look alike), so it is not recorded and a replay of that input is a
  miss. A refusal by the pipeline (egress, a missing variable, a timeout) is never recorded. Recording
  happens after the module succeeds, so a failure to write is not taken for the module's. A recording run
  returns the JSON that a replay will, so both validate the same value.
- **Where it is filed.** Module fixtures are named `module.<tool>.<hash>.json`, apart from HTTP fixtures,
  and the doctor looks for that prefix. The key is made from the input with only the CLI's configured
  secrets redacted (a replay has no credentials to know the rest); the file's contents are redacted with
  every secret the module read, including declared `permissions.env` values, in keys as well as values.
- **The seam is a plain interface** (`ModuleFixtureSeam`) defined beside `invokeOp`, so the vendored
  `component.ts` carries it without the file store (`module-fixtures.ts` is not vendored). Exports run
  live and never use it; behavioural equivalence holds because a recorded replay and an export's live run
  of a non-HTTP module give the same outcome (covered in `e2e/`).
- The doctor's replay check now **fails** a component tool with no recorded fixture, module or not.

## Compatibility

A module that uses `ctx.fetch` used to replay by running against its HTTP fixtures. It now replays from a
module fixture, so a fixtures folder recorded before this change needs `--tools record` again for those
ops (the doctor reports them). The legacy Slack and Gmail kinds are unaffected.

## Not changed

- The legacy Slack and Gmail kinds, which desugar onto first-party modules and pass their own tool name,
  keep their HTTP-level fixtures, so fixtures recorded before still replay.
- A rest component still records at the HTTP level; it has no module to run.
- A module with a side effect is replayed without the side effect, which is the point, but it also means a
  replay cannot show that the module's code would still work: re-record after changing a component.
- Two calls with the same input write one file: the last recording wins, and re-recording is how a
  fixture is refreshed. A poll that returns different results each time replays one of them.
- A replayed error is rebuilt: its code, status, message and the cause's message and status survive, other
  properties of the original do not. Replay ignores an abort signal, since it is instant.
- `kampong dev`'s run path does not take `--tools` and does not use fixtures.
