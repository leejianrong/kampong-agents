# ADR-0050: The poll trigger: a connector op on an interval, dedupe as a declared enum

Status: accepted (KAM-117)

## Context

support-triage has to start a run for each new email, and an inbox cannot call a webhook. The planning decision
(SLICES.md V11, F1) was a `poll` trigger beside `schedule`: call a connector op on an interval, keep a cursor in
the state store, and start one run per item. The open question was where the "what is new?" logic lives. Free-form
code in the spec would break the rule that a spec holds no code beyond expressions, and would make restart-safety
something every author gets wrong a different way.

## Decision

- **The trigger names a component op**, with the same `use`/`op`/`with`/`config`/`secrets` fields as a component
  tool, so it is pinned in `kampong.lock` and resolved through the same dispatcher. `with` is passed as written:
  there is no run yet for a `{{ }}` reference to read.
- **Two expressions, no code.** `items` selects the list in the op's result and `id` gives one item's key (a
  non-empty string or a number). Both are JSONata, checked for syntax when the spec is parsed. Their names are the
  result's own, so they are not checked against the spec's steps.
- **Dedupe is an enum over persisted state:** `unique` (never seen, one entry per key), `time_window` (the same
  entry with a TTL), `greatest` (a numeric or string high-water mark) and `last` (the previous poll's last item,
  for a list returned oldest first). Cursor kinds start items in a fixed order and move the cursor after each one.
  `greatest` refuses ids of mixed kinds rather than compare a number with a string.
- **A key is remembered only once its run has started.** For `unique` the key is claimed with `putIfAbsent`
  before the run starts and released if starting throws; for the cursor kinds the cursor moves after each start.
  A failed start therefore comes back on the next poll, and the error reaches the runner, which reports it and
  backs off. The cost is that a crash between starting a run and remembering it repeats that one item. The other
  order would drop it silently, and a dropped email is worse than a duplicated one.
- **One run per item** by default, with the item's fields at `trigger.*` and the item as `trigger.body`.
  `one_run_per_item: false` starts one run over all the new items, with `trigger.items`.
- **The poll runs under the unattended runner** (ADR-0028), on `every`, so it gets the overlap lock, jitter,
  backoff and failure limit for free. The lock covers the poll, not the runs it starts: a slow run never delays
  the next poll, and the workflow's own concurrency is not limited here. The first poll runs at startup.
- **Version 1.1 only; `kampong serve` only.** An export refuses a poll trigger rather than write a project that
  never starts a run. The hosted server does not run 1.1 specs (ADR-0027).

## Consequences

- The first poll starts every item the op returns. The IMAP `list_unseen` op returns only unread mail, so the
  workflow marks a message read (`mark_seen`) as its last step; a source with no such filter starts its whole
  backlog once.
- `unique` keeps one small entry per key forever. `time_window` is the bounded form for a long-lived service
  whose ids repeat or whose history does not matter.
- A result with one match is a lone value in JSONata, not a list. With `items` set it is read as a one-item list;
  without `items`, a non-list result is an error, so a typo does not look like an empty source.
- Not exercised against a live inbox: the tests drive a fake connector through the real runner and run manager.
  The poll cadence is the runner's, so a poll interval shorter than the op's own latency just means polls skip
  while the lock is held.
