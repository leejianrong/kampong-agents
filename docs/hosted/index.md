# Hosted deployment and enterprise readiness

This section is the plan for taking a workflow live on the hosted server at `kampong.abangai.dev` and for
making that server something an IT lead can adopt for a whole company. It is a plan, not a description of
shipped behaviour: where a page says "planned" the code does not do it yet. The code wins where they disagree.

Written 2026-11-24 from the code on `main`. Governing ADRs: 0022, 0023, 0056, 0057, 0058. Board epics: KAM-E10
(managed deployments) and KAM-E45 (enterprise-ready hosted cloud). Estimates are the author's own, not the
board's.

## The goal

A person presses Deploy, gets a webhook address and a secret, watches runs and approves what pauses. An
enterprise buyer, with hundreds of staff building agents, can answer yes to the questions their security
reviewer asks: who can do what, who did what, where the data lives, what it costs, and what happens when it
breaks. The bar is the readiness of LangSmith and Langfuse Cloud.

There is no landing page in this plan. The server is the product surface at `kampong.abangai.dev`.

## Where we are

**Built and merged**

- Deploy, check, pause, resume, delete and rotate-secret API, one deployment per spec.
- Public ingress `/hooks/w/<workspace>/<deployment>`, using the same auth code as `kampong serve`.
- A webhook secret per deployment, shown once and stored encrypted (ADR-0057).
- A scheduler for `schedule` triggers, tied to live or paused.
- Per-workspace connector secrets and model keys, encrypted (KAM-81, BYOK).
- An egress guard: hosted tools reach public addresses only (ADR-0058). It covers tool HTTP; see
  [the trust page](data-and-trust.md#egress-coverage-is-unverified) for the open question about model and
  connector calls.
- Postgres with row-level security, durable runs, an approval route and a run trace.
- Helm charts for the server and for Postgres with scheduled backups.

**Missing for go-live**

- A Deploy panel and dashboard in the canvas (KAM-82, replaced by KAM-326).
- Endpoints that list a spec's recent runs and the runs waiting for approval, and a record of how each run
  started.
- Rate and size limits on the public ingress.
- Anywhere to run it: the server is not running anywhere yet.

**Missing for enterprise** (found by the buyer review, see [enterprise readiness](enterprise-readiness.md))

- Single sign-on, SCIM provisioning, roles enforced on routes, and an audit log.
- Quotas, spend caps and a usage view.
- A trust package, SOC 2 readiness, a status page and a proven backup restore.
- Key rotation and a KMS option, network policy, per-workspace egress allowlists, member management and trace
  retention.

## How to read the diagrams

All pages use Mermaid. The same encoding holds throughout:

- Solid boxes and arrows are parts that exist.
- Dashed boxes and arrows are new, planned or optional.
- Arrow labels say what moves.

## Pages

| Page                                            | What it holds                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| [Architecture](architecture.md)                 | Context, containers, components, infrastructure                              |
| [Flows](flows.md)                               | Deploy, webhook run, approval, identity, limits, scheduler, user journeys    |
| [Data and trust](data-and-trust.md)             | Data model, state diagrams, trust boundaries, API shapes                     |
| [Enterprise readiness](enterprise-readiness.md) | The buyer review, the competitor matrix, and every gap with its gate         |
| [Build plan](build-plan.md)                     | Slices, dependency graph, points, risks and open decisions                   |
