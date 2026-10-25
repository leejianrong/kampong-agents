# Kampong Agents — agent brief

An agent-workflow builder for people who can prompt an LLM but may not write code, with a hosted product as
the business and a developer-friendly local mode (TypeScript on Mastra). ADR-0053 sets the first user and the
business model.
Deep context lives in `PLAN.md` (problem/scope/requirements), `SLICES.md` (build sequence and a
status table), and `docs/adr/*.md` (decisions and why). This file is the fast start, not a
replacement for reading those before you implement a slice.

**Trust the code over any doc, including this one, and fix the doc when they disagree.**

## Build status

- **Done and merged:** V1–V4 (the MVP: `AgentSpec` YAML + canvas, engine with guardrails/HITL,
  `kampong dev|run|export`, TypeScript exporter) and V9 (webhook triggers, connectors, Slack approvals).
- **Built but parked until deployed:** V5 hosted/BYOK server (`packages/server`: Postgres + RLS,
  Better Auth, BYOK vault, Helm in `deploy/`). V10 managed go-live is partly built.
- **In progress: V11**, authorable real-world workflows. Shipped: spec version `"1.1"` (JSONata
  expressions, `vars`), `output_schema`, component repository (`kampong/*` first-party components),
  SQLite state store, unattended runner, `schedule` and `poll` triggers, model record/replay, `transform`/`validate`/`dedupe`, `foreach`,
  `branch`/`stop`, persisted approvals, webhook auth presets with `when`/`map`, and the `market-etl`
  template. Open work is on the board (canvas forms for the new steps, Slack interactivity,
  RAG, more templates).
- **Roadmap, not started:** V6 governance, V7 multi-agent, V8 NL generation, V12 registry.

Work is tracked on the Pandan board "Kampong Agents" (board id 26, key `KAM`), one epic per slice.
Older commits and ADRs cite `KAN-`/`EPIC-` ids for the same cards. Pick up a card from the board,
claim it, and keep it in the active cycle (see KAM-150).

## Load-bearing conventions (don't re-litigate; see the ADR for the why)

- **The validated `AgentSpec` is the single truth; YAML is its canonical text form and the interchange format.**
  Local mode edits `agent.yaml` on disk. Hosted mode keeps the spec as an internal document and offers
  import/export of YAML; users are not asked to see a file. Local and hosted share one mutation layer and one
  `SpecRepository` interface and must not drift (parity-tested). Code export is one-way, and the canvas never
  reads generated TypeScript. (ADR-0054; the one-way export half of ADR-0002)
- **TypeScript end to end, on Mastra.** No Python component. Mastra core is Apache 2.0; its `ee/`
  features are separately licensed, so build governance ourselves. (ADR-0003)
- **One agent per spec today is a v1 scope limit, not positioning.** The schema leaves room for `sub_agents`;
  multi-agent is open and unscheduled. Do not describe the product as single-agent. (ADR-0001, ADR-0053)
- **No separate LLM gateway until hosted (V5).** A failed model call fails visibly; it is never silently
  retried on another provider. (ADR-0004)
- **The canvas is a local web app served by the CLI, not a desktop app**, so the same UI serves hosted
  mode. (ADR-0005)
- **Canvas layout lives in `.kampong/layout.json`, never in the spec YAML.** (ADR-0006)
- **Stack:** React + Vite + `@xyflow/react`; Fastify + SSE; the `yaml` package (not `js-yaml`) for
  comment-preserving parsing. No database for specs. The one local exception is the SQLite state store
  (`.kampong/state.db`, ADR-0028); the hosted server uses Postgres. (ADR-0007, ADR-0028)
- **Hand-editing specs in Cursor or Claude Code is supported in local mode**, for developers (the secondary
  audience), and is not the primary story or guaranteed in hosted mode. External changes auto-reload with
  no prompt; the canvas prompts only on a genuine in-flight-mutation conflict. The published JSON Schema
  plus the `yaml-language-server` pragma is how external tools validate. The in-app YAML view stays a
  light viewer. (ADR-0008, narrowed by ADR-0054)
- **Spec versions:** `"1.0"` keeps the original `{step.field}` syntax and string conditions and must keep
  validating. New step kinds (`transform`, `validate`, `dedupe`, `foreach`, `branch`, `stop`), `vars`,
  schedule/webhook auth and `output_schema` are `"1.1"` only. Each carries its own YAML line in errors.
  The hosted server runs 1.1 specs (ADR-0056) except `poll`/`schedule` triggers (KAM-203).
  Webhook auth presets, `when` and `map` work (a per-deployment secret, ADR-0057). `dedupe` works there, on a Postgres state store scoped per workspace under RLS. (ADR-0027)
- **Exported projects vendor the engine files** (parity-tested copies, e.g. `workflow.ts`, `run.ts`,
  `schedule.ts`), so a change to a vendored file must keep the parity tests passing. (ADR-0010)
- **Local-first, no telemetry by default.** Secrets never go in a spec: only `${ENV_VAR}` placeholders
  (and `secret_env` names), with values in `.env` or the environment.
- **An unavailable local model (Ollama) is a hard, visible error**, never a silent fallback to a paid API.
- **Model calls: prefer OpenRouter, then any OpenAI-compatible endpoint, over a direct Anthropic key.**
  `mastra-projects/` goes through OpenRouter only (its ADR-0005).
- **Canvas v2:** small category-coloured cards flowing left to right, detail in one docked inspector, results on the
  nodes; mockups in `docs/design/canvas-v2`. The assistant (chat builder) proposes validated edits over an
  OpenAI-compatible endpoint and applies nothing until the user does. (ADR-0059, ADR-0060)
- **Frontend/UI work uses Material Design 3** (color roles, type scale, shape/elevation, state layers);
  see the `material-design-3` skill.
- **First user: a non-technical person who can prompt an LLM.** Hosted is the business; a paid enterprise licence
  to self-host (GitLab-style) is planned. Prompt-to-workflow is core to the main path, and hosted must run the
  full spec. Pricing and the core's licence are not decided. (ADR-0053)
- **Enterprise features (V6) are a planned revenue line (the self-host licence), not cut.** Sequence them after
  hosted can run spec 1.1; don't assume they never come.

## Repo layout

```
packages/spec/        AgentSpec schema + validator, published JSON Schema, expression checks
packages/engine/      Mastra-backed engine: workflow, guardrails/HITL, runner, schedule, state store
packages/engine/components/   first-party `kampong/*` connectors (slack, gmail, github, supabase, alpha-vantage)
packages/exporter/    AgentSpec -> standalone TypeScript project, one-way
packages/cli/         kampong dev | run | serve | export | templates | doctor | lock; Fastify local server
packages/cli/templates/  ready-made specs (market-etl; ADR-0046)
packages/server/      hosted multi-tenant server (Drizzle/Postgres, Better Auth) — V5
apps/canvas/          React + Vite + @xyflow/react canvas
e2e/                  cross-package acceptance tests; e2e/browser = Playwright
deploy/helm/          Kubernetes chart for the hosted server
docs/                 product docs (Zensical site: `zensical.toml`) and docs/adr/
mastra-projects/      separate discovery initiative, not part of the product (below)
```

Each package has `test/unit` and, where relevant, `test/integration`.

**`mastra-projects/`** is outside the npm workspace/build/lint/CI: non-mocked demo apps built directly
on Mastra (no `AgentSpec`) to find which use cases are worth supporting. Read its own
`PLAN.md`/`SLICES.md`/`QUESTIONS.md`/`docs/adr/` before working there; this file's conventions don't
apply. Root `npm run build|lint|typecheck|test:*` never touch it.

## Commands

```
npm install              # install all workspaces
npm run build            # tsc -b (dependency-order-aware) + vite build for apps/canvas
npm run lint             # eslint .
npm run format:check     # prettier --check .
npm run typecheck        # tsc --noEmit per package
npm run test:unit        # fast layer, no infra (unit + unit-web); mirrors the pre-push hook
npm run test:integration # cross-module layer; integration-db needs Postgres (see ci.yml)
npm run test:e2e         # full-stack acceptance (installs and runs generated projects)
npm run test:e2e:browser # Playwright
npm test                 # unit + integration
make try-demo            # look at the app, no Docker/keys: market-etl in .try/demo, Replay-ready (make try: blank)
make try-reset           # delete .try/
make try-hosted          # hosted server on a throwaway Postgres (needs Docker)
make e2e-browser         # Playwright: playwright.local.config.ts, then hosted-flow if Docker works
make verify              # the full manual gate in order, one summary line per stage
```

**Run `npm run build` first on a fresh checkout.** Cross-package imports resolve through each
package's gitignored `dist/`, so without a build they fail with `TS2307`. Root `build` must stay
`tsc -b` (not `npm run build --workspaces`, which ignores the dependency graph; this broke CI once).

The pre-push hook (`.husky/pre-push`) runs lint + format:check + build + typecheck + test:unit.
`--no-verify` is fine for a scoped, deliberate exception.

## Workflow conventions

- One branch per card or slice, cut from a fresh `main`; land via PR with CI green. Branch protection on
  `main` isn't configured; set it up before a second contributor joins.
- Delete the branch after the PR merges. PRs are squash-merged, so git can't tell a merged branch from an
  unmerged one; check `gh pr list --state merged --head <branch>` before pruning.
- A new architectural decision, or a `QUESTIONS.md` default that turns out to be load-bearing, gets its own
  `docs/adr/NNNN-*.md`, numbered from the highest existing one (currently 0060).
- Every bug or flake becomes a regression test before the fix.
- A change to a CLI command, spec field or step kind updates `docs/reference/` and the README in the same PR.

## Testing approach (see PLAN.md §Testing approach)

- **Round-trip:** `YAML → canvas render → mutation → serialize → re-parse` must be a fixed point for every
  fixture, comments and formatting included (`packages/spec/test/integration/round-trip.test.ts`).
- **Exporter correctness is behavioral equivalence**, not code shape: install and run the generated project
  in a clean directory and compare its output to the engine's on the same input
  (`e2e/exporter-behavioral-equivalence.test.ts`, `e2e/market-etl-template.test.ts`).
- **Execution tests use recorded fixtures** (`--tools replay`, `e2e/fixtures/`): no live network in
  unit/integration tests.
