# ADR-0001: Every demo uses real integrations, never mocked or simulated ones

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

This initiative's whole purpose is to discover which agent-workflow use cases
are actually impactful and, by trying to reproduce each one through
kampong-agents' own `AgentSpec`, exactly what's missing to ship them for real.
kampong-agents' own test suite deliberately uses recorded mock tool responses
for determinism (see root `AGENTS.md` §Testing approach) — that's the right
call for a regression suite, but wrong here: mocking a service hides precisely
the integration friction (auth flows, rate limits, real error shapes, latency,
partial failures) this initiative exists to surface.

## Decision

Every one of the 5 demos hits genuinely real external services: a real Slack
workspace, a real Supabase project, the real Alpha Vantage API, a real
(self-hosted) Prometheus/Alertmanager stack monitoring a real toy service, a
real GitHub repository, and a real (dedicated) email inbox. No demo stands a
simulated/seeded fake service in for a real one, and no demo replays recorded
fixtures in place of a live call.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Simulated/seeded fake services behind the same tool interface | Hides the exact integration friction (auth, rate limits, real error modes) this initiative exists to find |
| Recorded-mock replay, as kampong's own test suite does | Same reason, plus these demos aren't meant to be deterministic CI regression tests |

## Consequences

Setup cost is real per demo — accounts, API keys, and for one demo, actual
local infrastructure. Demos are not fully offline or deterministic, and can
flake because the services they hit are real. In exchange, every finding about
credential handling, rate limits, webhook delivery, and error recovery is
trustworthy in a way mocked demos can't provide — which is the entire point of
building these instead of just reading Mastra's docs. This also forecloses
treating these demos as part of any CI pipeline: they are manually-run
exploration artifacts, not regression tests.
