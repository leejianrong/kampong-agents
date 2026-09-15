# Design decisions

Every load-bearing choice in Kampong Agents is written down as an architecture decision record
(ADR): what was decided, the alternatives, and the trade-off. They're the memory of why the system
is shaped the way it is. The full set lives in `docs/adr/`; here they are grouped by theme.

## Shape of the product

- [ADR-0001: Single-agent scope for v1](adr/0001-single-agent-scope-for-v1.md)
- [ADR-0002: YAML as source of truth, one-way export](adr/0002-yaml-source-of-truth-oneway-export.md)
- [ADR-0005: A local web app, not a desktop app](adr/0005-local-web-app-not-desktop.md)
- [ADR-0008: External-edit-first workflow](adr/0008-external-edit-first-workflow.md)
- [ADR-0021: Real-world workflows direction (V9)](adr/0021-real-world-workflows-direction.md)

## Runtime and execution

- [ADR-0003: Mastra + TypeScript runtime](adr/0003-mastra-typescript-runtime.md)
- [ADR-0004: No LLM gateway for the MVP](adr/0004-no-llm-gateway-for-mvp.md)
- [ADR-0009: Confidence signal and workflow execution](adr/0009-confidence-signal-and-workflow-execution.md)
- [ADR-0010: Exported runtime is vendored, not re-templated](adr/0010-exported-runtime-is-vendored-not-retemplated.md)

## Canvas, storage, and stack

- [ADR-0006: Sidecar layout file](adr/0006-sidecar-layout-file.md)
- [ADR-0007: Frontend and local-server stack](adr/0007-frontend-and-local-server-stack.md)

## Roadmap decisions (not built yet)

These scope work that's planned but not started: hosted mode, multi-tenancy, auth, governance.

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
