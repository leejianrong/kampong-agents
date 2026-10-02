# Mastra demos: Questions

Statuses: `DECIDED` (user answered) · `ASSUMED` (default taken, correct it if
wrong) · `FORK` (waiting on the user) · `DEFERRED` (not needed this
milestone).

## Open forks

None — both grill rounds closed.

## Register

| ID | Question | Status | Answer or default | Landed |
|----|----------|--------|--------------------|--------|
| Q1 | Who is this for? | ASSUMED | The kampong-agents team itself; internal discovery, not an external product | PLAN §Users and actors |
| Q2 | What are the 5 demos? | DECIDED | pr-review-swarm, incident-responder, support-triage, research-analyst, market-etl | PLAN §Scope, SLICES.md |
| Q3 | Mock integrations, or real? | DECIDED | Fully real — no mocks or simulated services anywhere | ADR-0001 |
| Q4 | Workspace package, or standalone? | ASSUMED | Standalone — outside the npm workspace/build/CI entirely | ADR-0002 |
| Q5 | Which specific real service per demo? | ASSUMED (mostly) | Gmail+Slack / Supabase pgvector / self-hosted Prometheus+Alertmanager / Alpha Vantage+Supabase / sandbox GitHub repo | ADR-0003 |
| Q6 | Incident-responder's platform, and remediation blast radius? | DECIDED | Self-hosted real Prometheus/Alertmanager; propose-only remediation, execution deferred as a stretch goal | ADR-0004 |
| Q7 | Support-triage's inbox: personal Gmail, dedicated Gmail, or Outlook? | DECIDED | Dedicated new Gmail account (Gmail MCP already connected; Outlook has no existing connector and would need one built from scratch) | ADR-0003 |
| Q8 | Shared state/DB across demos? | ASSUMED | None — each demo is fully independent | PLAN §Shape |
| Q9 | Concurrent writers? | DEFERRED | Not applicable — single developer, sequential builds | n/a |
| Q10 | UI per demo? | SUPERSEDED by Q17 | Was: Mastra's own dev playground / a plain CLI | — |
| Q11 | Failure behaviour? | ASSUMED | Hard, visible errors — no silent fallback, matching the root product's convention | PLAN §Implementation decisions |
| Q12 | Runtime/deployment? | ASSUMED | Local dev machine; `incident-responder/`'s monitoring stack is the one docker-compose exception | PLAN §Shape |
| Q13 | Measurable success? | ASSUMED | Each demo runs end-to-end against real services + has a gap-analysis; `FINDINGS.md` ranks gaps; concrete backlog items land | PLAN §Requirements |
| Q14 | Secrets handling? | ASSUMED | `.env.example` per demo, real values gitignored, dedicated low-privilege accounts preferred over personal/production ones | PLAN §Implementation decisions |
| Q15 | Versioning/migration story? | DEFERRED | Not applicable — throwaway exploratory code, not a long-lived product | n/a |
| Q16 | Gap-analysis per-demo or batched at the end? | ASSUMED | Per-demo, immediately after building it, so later demos can be reprioritized on early findings | SLICES.md |
| Q17 | Which model provider? | DECIDED | OpenRouter by default (BYOK), never a direct Anthropic key — standing preference across all projects, not just this one | ADR-0005 |
| Q18 | UI per demo, revisited | DECIDED | A real-time visual dashboard per demo (Fastify + SSE, no build step), not just the Mastra dev playground/a CLI | ADR-0006 |

## Coverage

| Category | Covered by |
|----------|-----------|
| Primary user and actors | Q1 |
| Scope boundary | Q2, Q3 |
| Data model and identity | (each demo is its own folder; no shared identity needed) |
| State and storage | Q8 |
| Concurrency and conflict | Q9 |
| Interfaces and contracts | Q18 |
| Failure behaviour | Q11 |
| External dependencies | Q3, Q5, Q6, Q7, Q17 |
| Runtime and deployment | Q12 |
| Measurable success | Q13 |
| Security and secrets | Q14 |
| Versioning and migration | Q15 |
