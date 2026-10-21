# ADR-0056: The hosted server runs spec 1.1

- Status: Proposed (KAM-203, PR A). The isolation stance in "Decision 3" needs the product owner's sign-off.
- Date: 2026-10-21
- Deciders: Jian (product owner)

## Context

ADR-0027 left the hosted server refusing version 1.1 specs because expressions on a shared server needed
time, memory and host-access bounds. ADR-0053 makes hosted the business and says it must run the full spec.
Reading the code for KAM-203 found the bounds are mostly in place and one gap is not an expression problem.

## Decision

1. **Lift the 422.** `HostedRunManager` runs a 1.1 spec through the same engine as `kampong run`, with
   the engine's default expression limits (1 s, depth 400, 2M nodes, 1 MB strings, 200k-item lists, no
   regular expressions, no clock or randomness). `POST /api/specs/:id/runs` takes an optional `vars` object
   (typed values, like `--var`); the engine checks them and fails the run visibly.
2. **A hosted run reads an empty environment.** Until now the engine defaulted `env` to the server's
   `process.env`, so a tenant spec could write `${DATABASE_URL}` or `${BETTER_AUTH_SECRET}` in a tool header
   or a var default and read the server's own secrets. The manager now passes `{}`. Model keys are unaffected
   (BYOK vault, ADR-0016). Consequence: a tool or component that needs a credential fails visibly on hosted
   until a workspace-scoped secret store exists (separate decision, not built here).
3. **Memory isolation: soft bounds for now (needs sign-off).** ADR-0027's spike found a hard memory cap needs a
   child process. The in-process hooks, the `$pad`/`$sort` caps and the regex ban stop the measured bombs,
   but a determined tenant can still build one large value inside a single native call. Options: (a) accept
   and rely on the per-run limits plus container memory limits and restart (this ADR's default for a
   private beta), (b) run each hosted run's expression evaluation in a child process with
   `--max-old-space-size`, before opening signup to untrusted tenants. Recommended: (a) now, (b) before
   public signup.
4. **Components.** Hosted resolves only the first-party `kampong/*` components. A workspace cannot add a module
   component, which would run tenant code in the server process.

## Not done here

Until then they are refused up front with a 422 naming the feature (`UnsupportedOnHostedError`), never started and left to fail or do nothing. `dedupe`, `poll`, `schedule` and webhook auth presets need persistent state and trigger wiring (KAM-203 PR B and
C). Outbound HTTP from tools has no private-address (SSRF) guard; a hosted tool can reach addresses inside the
server's network. This predates 1.1 and is flagged for its own card.

## Consequences

- A parity test (`packages/server/test/integration/routes/spec-1-1-parity.test.ts`) runs market-etl locally
  and through the hosted routes against the same offline fakes and compares status, output, trace and every
  request.
- ADR-0027's "not yet" is superseded for everything above.
