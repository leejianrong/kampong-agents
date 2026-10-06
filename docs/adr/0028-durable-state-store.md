# ADR-0028: A durable state store (amends ADR-0007's "no database in v1")

- Status: Accepted
- Date: 2026-10-06
- Deciders: Jian (product owner)

## Context

ADR-0007 chose no database in v1: files only. That held for interactive, single-run use. The demos
show it does not hold for workflows that outlive a request:

- incident-responder keeps an `openIncidents` map keyed by alert fingerprint. A restart orphans the
  Slack message a human is about to click, and a later `resolved` alert cannot find its `firing`
  incident.
- support-triage keeps a pending-ticket map while a human decides, and relies on the IMAP `\Seen`
  flag as its only dedupe.
- market-etl needs an overlap lock and idempotent writes.
- A poll trigger (F1) needs a persisted cursor or seen-set.

These are one need (a small durable keyed store), wider than F4's "durable run state". In the
hosted server, `runs` rows persist a trace, but a pending approval can be resumed only by an
in-memory `owned.run`, and `kampong serve` uses an in-memory `RunManager` map.

## Decision

### 1. A `StateStore` interface

A small keyed store with: `get`, `put` (with optional TTL), `exists`, `delete`, `putIfAbsent` (for
dedupe and locks), and a list-by-prefix. Used by: run resume and pending-approval correlation,
poll cursors and dedupe, the `once(key, ttl)` and open/close incident steps, and the runner's
overlap lock.

### 2. Two implementations

- **Local and self-host:** a SQLite file under `.kampong/` (alongside `layout.json`, ADR-0006). It
  is never a source of truth for the spec. The spec YAML remains the single source of truth
  (ADR-0002); the store holds runtime state only.
- **Hosted:** Postgres, in the existing server schema, workspace-scoped under RLS like the other
  tables (ADR-0018, ADR-0019).

### 3. Pending approvals become resumable from persisted state

A paused run records enough to resume (step index, accumulated outputs, correlation key) in the
store. Approval resolves by key, so a restart or a different process can complete a pending run.
This also closes the hosted gap where only an in-memory run object can resume.

### 4. Boundaries

- No telemetry or network use (local-first). The SQLite file stays on the user's machine.
- Secrets are never written to the store; only references.
- State is scoped by workflow and, hosted, by workspace. The exporter vendors the store with the
  engine (ADR-0010) and the exported container mounts its volume.
- Record-mode approval (a decision recorded on already-finished work) and `on_decision` continuations
  are expressed on top of the store, not as a separate mechanism.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Stay in memory, document the limit | Loses pending approvals on every restart; unattended workflows are not credible. |
| Files (JSON) | Concurrent writers and atomic `putIfAbsent` are exactly what breaks; a poller and a webhook share state. |
| Postgres everywhere | Forces infrastructure on the local-first developer path. |
| Rely on external systems for state (the IMAP `\Seen` flag, Alertmanager repeats) | Source-specific, not general, and gone for sources without a flag. |

## Consequences

- Amends ADR-0007's "Database: none in v1" for runtime state only. Spec and layout remain files.
- Adds a native dependency or WASM build for SQLite to the engine and exporter; the choice of binding
  is made in the slice and must work in the exported Dockerfile (ADR-0010, ADR-0022).
- Unblocks the unattended runner, poll and schedule triggers, and the incident and triage templates
  (V11 Phases 1 and 2).
- Revisit retention, TTL defaults and a vacuum policy when the first long-running deployment exists.
