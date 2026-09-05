# Kampong Agents — agent brief

A dev-first, canvas-code-duality agent-workflow builder. Full context lives in `PLAN.md`
(problem/solution/scope/requirements), `SLICES.md` (build sequence), and `docs/adr/*.md`
(the decisions and their reasoning) — this file is the fast-start summary, not a replacement
for reading those when you're actually implementing a slice.

## Build status

**V1–V4 (the full MVP) are implemented and merged to `main`.** Concretely: the `AgentSpec`
YAML schema + validator and published JSON Schema (`packages/spec`); the sidecar layout store,
canvas read/write path, tool- and workflow-step forms, file-watcher auto-reload, and YAML
preview panel (`apps/canvas`); the Mastra-backed execution engine with guardrail/HITL approval
and BYOK model config (`packages/engine`); `kampong dev`/`run`/`export` and the Fastify local
server, including the mock/record tool layer and Ollama adapter (`packages/cli`); and the
one-way TypeScript exporter (`packages/exporter`). Lint, typecheck, build, and all three test
layers are green. V5–V8 (hosted/BYOK SaaS, enterprise governance, multi-agent orchestration,
NL-to-workflow generation) remain roadmap — not started. Trust the code over this file or the
planning docs for exactly what's implemented and how; trust `PLAN.md`/`SLICES.md`/`docs/adr/`
for what's _supposed_ to get built next and why.

Work is tracked on the Pandan board "Kampong Agents" (board id 26, key `KAM`) — one epic per
slice in `SLICES.md`. V1–V4 epics are done; V5–V8 epics are open and labeled `[ROADMAP]`.

## Load-bearing conventions (don't re-litigate these — see the cited ADR if you need the why)

- **YAML is the single source of truth, canvas is bidirectional with it, code export is
  one-way.** The canvas never reads from or writes to generated TypeScript; only the
  `AgentSpec` YAML round-trips. (ADR-0002)
- **TypeScript end to end, on Mastra.** No Python component anywhere — canvas, CLI, execution
  engine, and exporter are all one language/runtime. Mastra core is Apache 2.0 (safe for
  hosted resale); its own `ee/`-directory enterprise features are separately licensed — don't
  depend on those for the V6 governance work, build it ourselves. (ADR-0003)
- **v1 is single-agent only.** No multi-agent org-chart orchestration yet; the spec schema
  should leave room for a `sub_agents` field later, but nothing assumes it's coming soon.
  (ADR-0001)
- **No separate LLM gateway (LiteLLM/Portkey) until the hosted slice (V5).** Model calls go
  straight through Mastra's Vercel AI SDK provider interface; a failed call fails visibly,
  it is not silently retried against another provider. (ADR-0004)
- **The canvas is a local web app served by the CLI (`kampong dev` → localhost), not a
  desktop app.** This is what lets the same UI be reused for hosted mode (V5) later.
  (ADR-0005)
- **Canvas node layout lives in a sidecar `.kampong/layout.json`, never in the spec YAML.**
  Keeps the spec hand-authorable and diff-clean. (ADR-0006)
- **Stack: React + Vite + `@xyflow/react` for the canvas; Fastify + SSE for the local server;
  the `yaml` package (not `js-yaml`) for comment-preserving parsing; no database in v1.**
  (ADR-0007)
- **Hand-editing a spec in Cursor or an agentic coding tool (Claude Code, Codex) is a primary
  workflow, not an edge case.** A folder of externally-authored specs renders on the canvas with
  zero import step; external file changes auto-reload by default (no prompt) — the canvas only
  prompts on a genuine in-flight-mutation conflict. The `AgentSpec` JSON Schema is published and
  wired via the `yaml-language-server` pragma so external tools get real validation/autocomplete
  without any custom editor tooling on our side. The in-app YAML view stays a light viewer/editor,
  not a competing IDE. (ADR-0008)
- **Local-first, no telemetry by default.** Nothing phones home unless a user explicitly
  opts in. Secrets are never written into a spec file — specs reference `${ENV_VAR}`
  placeholders only, actual values live in `.env`/the environment.
- **A local model (Ollama) that's unavailable is a hard, visible error — never a silent
  fallback to a paid cloud API.**
- **Any frontend/UI work uses Material Design 3** (color roles, type scale, shape/elevation
  tokens, state layers) rather than ad hoc styling — see the `material-design-3` skill/
  reference before building canvas UI.
- **Enterprise features (hosted/BYOK, SSO/RBAC/audit) are on the roadmap, not cut** — see
  `PLAN.md` §Scope and `SLICES.md` V5/V6. Don't build them early; don't assume they're never
  coming either.

## Repo layout

```
packages/spec/       AgentSpec YAML schema + validator (S1, S7) — yaml pkg, JSON Schema artifact
packages/engine/      Mastra-backed execution engine, guardrails/HITL, mock/record + Ollama (S3/S4)
packages/exporter/    AgentSpec -> standalone TypeScript project codegen, one-way (S6)
packages/cli/         kampong dev / kampong run / kampong export + the Fastify local server (S5)
apps/canvas/          local web canvas app — React + Vite + @xyflow/react (S2)
e2e/                  cross-package acceptance tests (e.g. exporter behavioral equivalence)
docs/adr/             architectural decisions, one per file
```

Each package has `test/unit` (no infra, runs everywhere) and, where relevant, `test/integration`
(cross-module behavior). Root-level `e2e/` holds tests that install/execute a real generated
project or otherwise exercise the full stack.

## Commands

```
npm install              # install all workspaces
npm run build             # tsc -b (dependency-order-aware) + vite build for apps/canvas
npm run lint               # eslint .
npm run format:check       # prettier --check .
npm run typecheck          # tsc --noEmit per package
npm run test:unit          # fast layer — no infra, mirrors the pre-push hook
npm run test:integration   # cross-module layer
npm run test:e2e           # full-stack acceptance layer
npm test                   # unit + integration (what CI's fast path expects)
```

**Run `npm run build` before `typecheck`/`test:unit`/`test:integration`/`test:e2e` on a fresh
checkout.** Cross-package imports (e.g. `apps/canvas` importing `@kampong/spec`) resolve via each
package's `"types"`/`"main"` field pointing at `dist/`, which is gitignored — without a build
first, those imports fail to resolve with `TS2307: Cannot find module`. `npm run build` itself
must stay `tsc -b` at the root (not `npm run build --workspaces`, which iterates by directory name,
not the dependency graph, and will try to build `apps/canvas` before `packages/spec` exists) —
this bit a real CI run once; don't reintroduce it.

The pre-push hook (`.husky/pre-push`) runs lint + format:check + build + typecheck + test:unit —
the same fast, no-infra gate as the first five CI jobs, so a push rarely lands red. `--no-verify`
is fine for a scoped, deliberate exception.

## Workflow conventions

- One branch per vertical slice from `SLICES.md`, cut from a fresh `main`.
- Every change should land via PR with CI green. Branch protection on `main` isn't configured
  yet; set that up before this repo has more than one contributor.
- A new architectural decision, or a default from `QUESTIONS.md` that turns out to be load-bearing,
  gets its own `docs/adr/NNNN-*.md` — number sequentially from the highest existing ADR (currently
  0008).
- Every bug or flake becomes a regression test before the fix, not after.

## Testing approach (see PLAN.md §Testing approach for the full reasoning)

- **Highest-leverage test:** the `AgentSpec` round-trip — `YAML → canvas render → mutation →
YAML serialize → re-parse` must be a fixed point for every fixture, including preserved
  comments/formatting (the reason we use the `yaml` package, not `js-yaml` — ADR-0007). This
  lives at the integration layer (`packages/spec/test/integration/round-trip.test.ts` has the
  placeholder).
- **Exporter correctness is behavioral equivalence, not code-shape comparison:** actually
  `npm install && npm start` the generated project in a clean directory and diff its output
  against the canvas/CLI-run output on the same input. This is an e2e-layer test
  (`e2e/exporter-behavioral-equivalence.test.ts` has the placeholder) because it really
  installs and runs a generated Node project.
- **Local execution tests (guardrails, HITL, tool calls) should use recorded mock tool
  responses** for determinism — no live network calls in unit/integration tests.
