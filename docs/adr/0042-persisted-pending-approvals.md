# ADR-0042: Persisted pending approvals, resumable by key

Status: accepted (KAN-1854)

## Context

ADR-0028 decided that a paused run records enough in the StateStore to resume, and that approval resolves by key. Until
now a run that paused for a human lived only in an `AgentRun` generator in memory: `kampong serve` and the exported
server held it in a `RunManager` map, so a restart orphaned the Slack message a person was about to click, and the
hosted server could resume only an in-memory `owned.run`. This card builds the local half; the Postgres store is
KAN-1853 and the hosted server still refuses 1.1 specs, so it is untouched.

## Decision

- **A record per pause.** When `EngineDeps.persistApprovals` is on, every pause writes
  `approval:<key>` (`key` is a random UUID, the correlation key) with the step index and name, the phase, the outputs so
  far, the run input, the trigger, the agent id, a SHA-256 of the spec (`specHash`), and timestamps. The key is on the
  `awaiting_approval` event and `RunState.pendingApproval.key`. Off by default: `kampong dev`'s canvas, `kampong run`
  (which prompts on stdin) and the library keep the in-memory path. `kampong serve`, the scheduler's runs inside it, and
  the exported webhook server turn it on.
- **Resume by key.** `AgentRun.resumeByKey(key, approved, reason)` on a fresh `AgentRun` (`runWorkflow(..., resume)`)
  loads the record, checks the spec hash, claims it, then re-enters the workflow at the paused step with the stored
  outputs and input. Earlier steps are replayed to listeners as `step_completed` events (output only) so a watcher sees
  the whole trace; they are not run again.
- **Two phases.** `before`: the pause is ahead of the step's work (a tool needing approval, an `approval` step, a
  `request_human_approval` branch). Resuming re-enters the step, re-evaluates its inputs (no side effects happen before
  the gate), and the gate takes the stored decision. `after`: a confidence guardrail pauses after the step ran, so its
  output is already in `outputs`; resuming continues with the next step and never calls the model again.
- **Atomic claim.** The claim is `StateStore.delete`, which reports true for exactly one caller, in any process (SQLite
  serialises writers). A second approve sees no record (404) or loses the delete (409, `already_resolved`) and does not
  run anything. The in-memory path claims the same way after its decision arrives, so an in-process `resume()` of a run
  someone else already resolved by key stops with a visible failure instead of acting twice. The delete is the commit
  point: once claimed, a crash before the next step finishes is not retried from the store (at most once, matching how
  ADR-0041's dedupe claims behave). Unlike the dedupe caveat this one is deliberate: re-running a tool the human just
  approved is the worse failure.
- **A changed spec does not resume.** The hash covers the parsed spec (key order and YAML comments do not matter). An
  approve under a different hash fails visibly (`spec_changed`, 409) with both short hashes, and leaves the record
  in place so restoring the spec (or `git checkout`) lets it be approved. A reject never runs anything, so it is allowed
  under any spec and clears the record.
- **TTL and expiry.** Records are written with `ttlMs` (default 7 days, `approvalTtlMs`; no spec field yet). The store
  treats an expired record as absent: it is not listed and resolving it reports "No pending approval ... it was already
  resolved, or it expired" (404, `approval_not_found`). There is no notification and no sweeper; expired rows are removed
  lazily by SQLite on the next delete of that key. A run that is never resolved simply ends.
- **No secrets.** Trigger headers that look like credentials (the same pattern `kampong serve` applies before they reach
  an expression) are dropped from the record. Step outputs are stored as they are, so a step that outputs a secret is
  stored with it; tool secrets remain `${ENV}` references and never enter outputs.
- **Store lifecycle.** The pause writes through a store opened for that call and closed after (`openState`), unless the
  run already holds one (`state`, or one a dedupe step opened), so a run paused for days holds no database handle.
  `createAgentRun` now always supplies the lazy default opener; the file is still only created when something opens it.
- **Surfaces.** `kampong serve` and the exported server add `GET /approvals` (what is waiting) and
  `POST /approvals/:key/approve`; `POST /runs/:id/approve` accepts a key as well as a run id. Slack Approve/Reject buttons
  carry the key as their `runId` when one exists, so a click after a restart works. A run resumed from a key is registered
  under a fresh run id (in the response) for polling and SSE; the pre-restart run id is gone. The serve store is
  `.kampong/state.db` next to the spec, as `kampong run` uses; the scheduler's lock store in the working directory
  remains separate.
- **Export.** `pending-approval.ts` is vendored with `workflow.ts` and `run.ts` (parity-tested); the hand-owned
  `run-manager.ts` and the server entry point gain the same routes; the README gains a Pending approvals section when the
  spec has an approval gate.

## Not in this card

- The Postgres store and the hosted server's own resume path (KAN-1853).
- Approving through the canvas after a restart; `kampong dev` stays in-memory.
- Re-running a resumed run after a crash past the claim, and the dedupe key release on failure (ADR-0041).
- A per-spec TTL field and an expiry notification.
