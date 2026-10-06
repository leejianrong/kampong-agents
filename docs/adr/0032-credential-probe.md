# ADR-0032: Credential probes in `kampong doctor`

- Status: Accepted
- Date: 2026-10-07
- Deciders: Jian (product owner)

## Context

KAN-1836 asks `kampong doctor` to say whether a credential is accepted, not just that its environment
variable is set. The worst setup friction in the demos was a token that was set and wrong. The only way to
know is to ask the service, which sends the secret over the network. Everything else doctor does (ADR-0031's
checks, pins, env names) is local.

## Decision

1. **A slot may declare a probe:** `auth.slots.<name>.probe: { op, with? }`. It names a read-only op of the
   same component that proves the credential, for example Slack `auth.test` or Gmail `users.getProfile`.
2. **The manifest check keeps a probe harmless.** The op must exist and have `effect: read`; for a rest
   component it must actually send that slot; every input it requires must be given under `probe.with`.
3. **Probing is opt-in: `kampong doctor --probe`.** It is separate from `--online` (a bare TCP connect,
   which sends nothing). Without the flag doctor makes no request.
4. **A probe goes through the normal op-call pipeline**, so the egress list and the slot's host binding
   apply exactly as in a run; the credential goes only to the hosts its slot is bound to.
5. **Only code a reviewer has seen is used to send a credential.** A component is probed only if it ships
   with kampong or its files match its `kampong.lock` pin. A project's own `module` component is never run
   by doctor, pinned or not (doctor stays a read-only tool that does not execute project code); its probe
   is reported as skipped. First-party modules (Gmail) are run.
6. **Outcomes.** The service accepts: pass. The service answers and refuses (HTTP 401 or 403, or a
   `failure_when` rule such as Slack's `ok: false`, or a module error carrying `status` 401 or 403): fail,
   with the service's reason (redacted by the pipeline, never the credential). Anything else, such as a
   timeout, a 5xx or a rate limit: warning, because it says nothing about the credential.
7. **First-party probes are additive.** `kampong/slack@1.0.0` gains `auth_test` and `kampong/gmail@1.0.0`
   gains `get_profile`, both read-only. First-party components are not pinned (ADR-0030), so nothing
   recorded changes; once a release is published, a new op ships as a new version.

## Not covered

- Model API keys are not probed. Each provider needs its own call (and some bill for it); a rejected key
  already fails the run's first model call visibly (ADR-0004). It can follow as a separate decision.
- A project module's probe is not run. A sandboxed `ModuleRunner` (ADR-0031 section 5) would allow it.
