# ADR-0004: Incident-responder remediation is propose-only this milestone

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

The incident-responder demo (ADR-0003) does real detection against a real
self-hosted Prometheus/Alertmanager stack and real diagnosis via tool calls
against the monitored toy service. Whether the agent should also *execute*
remediation (e.g. actually restart a real container) once a human approves
it is a separate question with a real safety surface — a wrong target or a
wrong command has real consequences, even against a toy service, and that
deserves its own design pass rather than being decided as a side effect of a
discovery demo.

## Decision

This milestone's `incident-responder/` demo stops at: real alert → real
diagnosis → a real proposed remediation posted to Slack for human approval.
The agent never executes the remediation itself. Automated, approved
execution is logged as a named roadmap/stretch-goal item in `FINDINGS.md`,
not built now.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Build execution now with a hardcoded allow-list of safe actions | Expands scope and safety-review burden beyond what's needed to answer "is this use case impactful" — propose-only already exercises the interesting parts: real alerting, real diagnosis, real HITL |
| Skip the remediation-proposal step entirely, just detect and describe | Loses the exact pattern kampong-agents already ships (KAN-1432/KAN-1436's HITL-gated approval), which is the thing worth testing here |

## Consequences

The demo is safe to run against real infrastructure with no risk of an agent
taking a wrong real action. The open question — should kampong-agents support
agent-executed remediation, and with what guardrails/allow-list — stays
explicitly open, tracked as a specific `FINDINGS.md` item and roadmap
candidate for a follow-up milestone, rather than being answered by default.
