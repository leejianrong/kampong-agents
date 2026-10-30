# Design decisions

Every load-bearing choice in Kampong Agents is written down as an architecture decision record
(ADR): what was decided, the alternatives, and the trade-off. They're the memory of why the system
is shaped the way it is. The full set lives in `docs/adr/`; here they are grouped by theme.

## Shape of the product

- [ADR-0001: Single-agent scope for v1](adr/0001-single-agent-scope-for-v1.md)
- [ADR-0002: YAML as source of truth, one-way export](adr/0002-yaml-source-of-truth-oneway-export.md) (source-of-truth wording superseded by ADR-0054)
- [ADR-0005: A local web app, not a desktop app](adr/0005-local-web-app-not-desktop.md)
- [ADR-0008: External-edit-first workflow](adr/0008-external-edit-first-workflow.md) (local mode; narrowed by ADR-0054)
- [ADR-0053: First user, business model, and agent count are not positioning](adr/0053-first-user-business-model-and-agent-count.md)
- [ADR-0054: The spec is the truth; YAML is its interchange format](adr/0054-spec-is-internal-yaml-is-interchange.md)
- [ADR-0055: Step addressing and the spec mutation API](adr/0055-step-addressing-and-mutation-api.md)
- [ADR-0021: Real-world workflows direction (V9)](adr/0021-real-world-workflows-direction.md)
- [ADR-0022: Deployment model — two paths, one foundation](adr/0022-deployment-model-two-paths.md)
- [ADR-0023: V10 monetization model](adr/0023-v10-monetization-model.md)
- [ADR-0024: V10 hosting and credential custody](adr/0024-v10-hosting-and-credential-custody.md)

## Runtime and execution

- [ADR-0003: Mastra + TypeScript runtime](adr/0003-mastra-typescript-runtime.md)
- [ADR-0004: No LLM gateway for the MVP](adr/0004-no-llm-gateway-for-mvp.md)
- [ADR-0009: Confidence signal and workflow execution](adr/0009-confidence-signal-and-workflow-execution.md)
- [ADR-0010: Exported runtime is vendored, not re-templated](adr/0010-exported-runtime-is-vendored-not-retemplated.md)

## Canvas, storage, and stack

- [ADR-0006: Sidecar layout file](adr/0006-sidecar-layout-file.md)
- [ADR-0007: Frontend and local-server stack](adr/0007-frontend-and-local-server-stack.md)

## Authorable real-world workflows (V9–V11)

The platform primitives that let a real workflow be authored, run unattended and exported: an expression
language, typed step output, a durable state store, a component repository, and the step kinds built on them.

- [ADR-0025: Component model and repository](adr/0025-component-model-and-repository.md)
- [ADR-0026: Component trust tiers, vetting, and MCP as an import layer](adr/0026-component-trust-tiers-and-mcp.md)
- [ADR-0027: Expression language and data model](adr/0027-expression-language-and-data-model.md)
- [ADR-0028: A durable state store](adr/0028-durable-state-store.md)
- [ADR-0029: Connector manifest schema](adr/0029-connector-manifest-schema.md)
- [ADR-0030: First-party components and legacy desugaring](adr/0030-first-party-components-and-legacy-desugaring.md)
- [ADR-0031: Component permissions: what is enforced](adr/0031-component-permissions-what-is-enforced.md)
- [ADR-0032: Credential probes in `kampong doctor`](adr/0032-credential-probe.md)
- [ADR-0033: An export verifies its components](adr/0033-export-verifies-its-components.md)
- [ADR-0034: Record and replay at the invoke boundary](adr/0034-record-replay-at-the-invoke-boundary.md)
- [ADR-0035: Retry for module ops](adr/0035-module-op-retry.md)
- [ADR-0036: The canvas shows component trust](adr/0036-canvas-component-trust.md)
- [ADR-0037: Revocation and release signing](adr/0037-revocation-and-release-signing.md)
- [ADR-0038: Structured step output](adr/0038-structured-step-output.md)
- [ADR-0039: Local Variables panel](adr/0039-local-variables-panel.md)
- [ADR-0040: Schedule trigger](adr/0040-schedule-trigger.md)
- [ADR-0041: `transform`, `validate` and `dedupe` steps](adr/0041-transform-validate-dedupe-steps.md)
- [ADR-0042: Persisted pending approvals](adr/0042-persisted-pending-approvals.md)
- [ADR-0043: The `foreach` step](adr/0043-foreach-step.md)
- [ADR-0044: Supabase and Alpha Vantage components](adr/0044-supabase-and-alpha-vantage-components.md)
- [ADR-0045: The `branch` and `stop` steps](adr/0045-branch-step.md)
- [ADR-0046: Templates and market-etl](adr/0046-templates-and-market-etl.md)
- [ADR-0047: Webhook auth presets and trigger filter](adr/0047-webhook-auth-presets-and-trigger-filter.md)
- [ADR-0048: Gmail over IMAP as a separate component](adr/0048-gmail-imap-component.md)
- [ADR-0049: Slack approvals on a laptop](adr/0049-slack-approval-local-story.md)
- [ADR-0050: The poll trigger](adr/0050-poll-trigger.md)
- [ADR-0051: Record and replay for model calls](adr/0051-model-fixtures.md)
- [ADR-0052: YAML serialisation keeps the author's style](adr/0052-yaml-serialisation-style.md)
- [ADR-0053: First user, business model and agent count](adr/0053-first-user-business-model-and-agent-count.md)
- [ADR-0054: The spec is internal, YAML is the interchange](adr/0054-spec-is-internal-yaml-is-interchange.md)
- [ADR-0055: Step addressing and the mutation API](adr/0055-step-addressing-and-mutation-api.md)
- [ADR-0056: The hosted server runs spec 1.1](adr/0056-hosted-server-runs-spec-1-1.md)
- [ADR-0057: Hosted webhook secret per deployment](adr/0057-hosted-webhook-secret-per-deployment.md)
- [ADR-0058: Hosted egress guard](adr/0058-hosted-egress-guard.md)
- [ADR-0059: Canvas v2 look and feel](adr/0059-canvas-v2-look-and-feel.md)
- [ADR-0060: Workflow assistant (chat builder)](adr/0060-workflow-assistant-chat-builder.md)

## Hosted mode and the roadmap

The hosted backend and its canvas UI (ADR-0013 to 0020) are built but not yet deployed. Sub-agents and governance
(ADR-0011, 0017) are still planned; the workflow assistant (ADR-0060) is the first part of spec generation (ADR-0012).

- [ADR-0011: Sub-agents data model and org-chart canvas](adr/0011-sub-agents-data-model-and-org-chart-canvas.md)
- [ADR-0012: Spec generation, evaluation, and fallback](adr/0012-spec-generation-evaluation-and-fallback.md)
- [ADR-0013: V5 hosting, deployment, and gateway topology](adr/0013-v5-hosting-deployment-and-gateway-topology.md)
- [ADR-0014: V5 database and multi-tenancy model](adr/0014-v5-database-and-multitenancy-model.md)
- [ADR-0015: V5 auth and account model](adr/0015-v5-auth-and-account-model.md)
- [ADR-0016: V5 BYOK secret custody](adr/0016-v5-byok-secret-custody.md)
- [ADR-0017: V6 enterprise governance model](adr/0017-v6-enterprise-governance-model.md)
- [ADR-0018: Workspace-member bootstrap under RLS](adr/0018-workspace-member-bootstrap-under-rls.md)
- [ADR-0019: Authenticated, workspace-scoped routes](adr/0019-authenticated-workspace-scoped-routes.md)
- [ADR-0020: Canvas hosted mode and spec selection](adr/0020-canvas-hosted-mode-and-spec-selection.md)

## Adding a new one

When a decision turns out to be load-bearing, it gets its own `docs/adr/NNNN-*.md`, numbered
sequentially. Keep them short and immutable-ish: an ADR records what was decided at a point in
time, not the current state of the code.
