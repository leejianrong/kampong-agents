# ADR-0035: Retry for module ops

Date: 2026-10-07. Status: accepted. Builds on ADR-0029 (retry for rest ops) and ADR-0034.

## Context

A rest op can declare `retry` and the engine re-attempts a retryable failure. A module op could not: its
errors were always wrapped as a non-retryable `http` error, so a 502 or a 429 from GitHub failed the step.

## Decision

- A module op may declare the same `retry` policy as a rest op (`max`, `backoff`, `base_ms`,
  `max_delay_ms`). Without it nothing is retried.
- The engine decides what is safe to repeat from what the module's error says. An error with a numeric
  `status` of **429** may be retried for any op (the server refused it before acting). **408 and 5xx** are
  retried for a `read` op only, since a write may already have been processed. A module that knows better
  sets `retryable: true` on the error (a refusal that arrives as a 403 with `Retry-After`); that holds for
  any op, as `retryable: true` on a rest `failure_when` rule does. An error with no status (a refused
  connection, a bug) is not retried, because nothing says it is safe.
- `retryAfterMs` on the error is honoured as a minimum wait; one longer than `max_delay_ms` is not waited
  for and the error says so. Retries sit inside the op's overall timeout and abort, so cancelling ends them.
- The error a step finally sees now carries the module error's `status`, is a `rate_limit` for 429, and is
  marked retryable for 429, 408 and 5xx, as a rest op's is. After the last attempt the message ends
  "(after N attempts)". Record and replay (ADR-0034) see only the final outcome.
- `kampong/github` declares a policy on every op and reports `Retry-After` and spent rate limits this way.

## Not covered

- Pacing (`pace`) for module ops. A module that needs to hold itself to a rate does so itself.
