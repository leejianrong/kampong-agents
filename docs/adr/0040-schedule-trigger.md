# ADR-0040: Schedule trigger (`cron` / `every`, timezone, run-now)

Status: accepted (KAN-1856)

## Context

`agent.trigger` was webhook-only. Unattended workflows (a nightly ETL) need a run on a clock, driven by the
unattended runner (ADR-0028, KAN-1855) so they get its overlap lock, backoff and fail-visible behaviour.

## Decision

- **Shape.** `trigger: { type: schedule, cron | every, tz?, overlap? }`, version 1.1 only. Exactly one of
  `cron` (five fields) or `every` (`30s`, `15m`, `6h`, `1d`, at least `1s`). `tz` is an IANA zone, default
  `UTC`, valid only with `cron`. `overlap` is `skip` (default) or `queue`. The trigger object is strict, so a
  typo (`timezone`) is an error. Content errors (bad cron field, unknown zone) carry the line of the field.
- **No cron dependency; hand-rolled, about 300 lines, `schedule.ts`.** The reasons: the exporter vendors
  runtime files and pins every runtime dependency (ADR-0010), the spec validator must apply the exact rules
  the engine runs (a library would be a second runtime dependency of `@kampong/spec`, which has none that
  touch time), and the tricky part (DST) is the part libraries disagree on, so we own and test it. Time zone
  data comes from the platform's `Intl`, not a bundled database. `packages/spec/src/schedule.ts` is a
  byte-identical copy of the engine's, enforced by a test; the exporter's parity test covers the vendored copy.
- **Cron semantics.** `*`, lists, ranges, `a-b/n`, `*/n`, month and weekday names, 7 as Sunday; if both
  day-of-month and day-of-week are restricted either may match. An expression that can never match a real
  date (`0 0 30 2 *`) is rejected.
- **DST.** A wall-clock time that does not exist runs once, at the first instant after the gap (matches inside
  one gap collapse into that run). A wall-clock time that happens twice runs once, at its first occurrence. A
  schedule that must tick on every real hour or N minutes regardless of the calendar should use `every`,
  which counts elapsed time from the moment `kampong serve` started.
- **Overlap.** The runner runs one job at a time. `skip` drops ticks that came due during a run and waits for
  the next one. `queue` keeps at most one: however many ticks passed, one run starts as soon as the current
  one ends. A second process on the same state store is held off by the runner's lock, which the pacing hook
  (`RunnerOptions.nextDelayMs`, new) leaves intact. A run that pauses for approval counts as finished for the
  tick (the approval routes own it); a failed run is a job failure (backoff, then the failure limit).
- **Run-now.** `POST /schedule/run-now` on `kampong serve` starts a run immediately. 404: no schedule trigger.
  409: the lock is held (a scheduled tick or an earlier run-now is in progress); a manual run is refused, never
  queued, whatever `overlap` says. 503: the scheduler is not running. 201 with the run id otherwise.
- **Scheduled run input** is the empty string; there is no payload to read as `trigger.*`.

## Consequences

- An export of a schedule spec vendors the scheduling code. Initially it did not wire a scheduler into its
  generated `src/server.ts`; KAM-158 did: the server starts the same runner (`serve-runner.ts`, hand-vendored from
  the CLI) and serves `POST /schedule/run-now`, and the generated README says `npm run serve` is the scheduled
  entry and `npm start` a single run.
- The lock TTL is `max(5 x interval, 15 minutes)` and is not renewed: a run longer than that can overlap a
  second process's tick.
- The canvas form for the trigger is KAN-1850.
