# Mastra demos

Five fully real Mastra applications, built directly against Mastra (not
through kampong-agents' own `AgentSpec`/canvas/exporter), used to discover
which agent-workflow use cases are actually impactful and to work backwards
to concrete kampong-agents feature gaps. Full reasoning: `PLAN.md`. Build
sequence: `SLICES.md`. Decision log: `QUESTIONS.md`. Architectural decisions:
`docs/adr/`.

**This folder is intentionally outside the npm workspace** (ADR-0002 in
`docs/adr/`): none of these demos are covered by the root `npm run
build`/`lint`/`typecheck`/`test:*` commands or the pre-push hook. Each demo
has its own `package.json` and is installed/run independently.

## Demos

| Folder | Use case | Real services |
|--------|----------|----------------|
| `pr-review-swarm/` | Multi-agent PR review pipeline | GitHub (sandbox repo) |
| `incident-responder/` | Real-alert-driven incident diagnosis + proposed remediation | Prometheus/Alertmanager (self-hosted), Slack |
| `support-triage/` | Support-inbox triage with HITL escalation | Gmail (dedicated inbox), Slack |
| `research-analyst/` | RAG analyst over kampong-agents' own docs | Supabase (Postgres + pgvector) |
| `market-etl/` | Scheduled market-data ETL with anomaly alerts | Alpha Vantage, Supabase, Slack |

Each demo's own README documents how to run it and carries a gap-analysis
section: what it needed from Mastra, and what kampong-agents' `AgentSpec`
can't express today. `FINDINGS.md` (written once all 5 are built —
`SLICES.md` V6) consolidates those into a ranked list feeding back into the
root `SLICES.md`/Pandan board.
