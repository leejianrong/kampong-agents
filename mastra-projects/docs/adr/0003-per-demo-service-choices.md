# ADR-0003: Per-demo real-service choices

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

ADR-0001 commits every demo to real external services. "Real" doesn't pick a
vendor by itself, and the choice matters for setup cost: this working
environment already has live, authenticated connections to Gmail, Supabase,
and Alpha Vantage (via MCP), and a working Slack app/workspace from shipping
KAN-1432 (Slack-button HITL approval). Reusing those beats provisioning new
paid accounts with no discovery benefit over what's already available.

## Decision

| Demo | Real services |
|------|----------------|
| `support-triage/` | A dedicated, newly-created inbox on Gmail (an existing Gmail MCP integration is already connected; Outlook would require building a Microsoft Graph integration from scratch with no existing connector) as the ticket source, and the existing real Slack app/workspace from KAN-1432 for HITL escalation. |
| `research-analyst/` | Supabase Postgres + pgvector as the real vector store (Supabase already connected via MCP); corpus = kampong-agents' own `docs/`/ADRs, so the demo doubles as a real "ask questions about our own product" tool. |
| `incident-responder/` | A self-hosted, real Prometheus + Alertmanager stack (docker-compose, same pattern already used at the repo root) monitoring a small real toy service, with real injected failures (killed dependency, induced latency/error spikes) so alerts are genuine. |
| `market-etl/` | Real source: the Alpha Vantage market-data API (already connected via MCP). Real destination: a Supabase Postgres table. |
| `pr-review-swarm/` | A dedicated sandbox GitHub repository (not `kampong-agents` itself) with real PRs opened against it, reviewed via the real GitHub API. |

## Alternatives considered

| Option | Why not |
|--------|---------|
| Paid third-party SaaS per demo (e.g. Zendesk, PagerDuty, Pinecone) | Real, but adds account/billing setup with no discovery benefit over the free/self-hosted/already-connected options chosen above |
| The user's personal Gmail for `support-triage/` | Commingles test scenarios with real personal mail |
| `kampong-agents` itself as the repo for `pr-review-swarm/` | Pollutes real product PRs with AI review noise |

## Consequences

Four of five demos need close to zero new account setup, since the
integrations already exist in this working environment. `incident-responder/`
is the only demo requiring new local infrastructure (a docker-compose
monitoring stack), and it stays free and self-hosted rather than a paid SaaS
signup. If any already-connected MCP integration becomes unavailable in a
future session (token expiry, revoked access), that one demo needs
re-authentication, not a redesign — the service choice itself doesn't change.
