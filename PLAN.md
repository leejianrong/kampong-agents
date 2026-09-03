# Kampong Agents: Plan

Status: agreed · Milestone: MVP (v1)

## Problem

Technical teams and agencies building AI agent workflows today have to choose between two bad options: a no-code canvas tool (Lindy, Gumloop, n8n) that locks their workflow logic into a proprietary platform with no real code underneath, or a code-first framework (LangGraph, Mastra, CrewAI) that gives them full control but no visual surface a non-technical teammate or client can look at, tweak, or approve. Neither lets a developer and a non-technical collaborator work on the _same_ artifact.

Separately, the broader no-code agent market is already crowded and consolidating (Lindy, Gumloop, n8n, Langflow, Flowise — the last acquired by Workday in 2025), and 88% of enterprise agent pilots never reach production, most often because of unclear scope rather than missing features. Leading with a generic, do-everything builder or a full enterprise-governance checklist before proving anything is the same mistake that produces those failed pilots.

## Solution

A local-first agent-building tool where a visual canvas and a plain YAML spec file are two views of the exact same thing, always in sync. A developer can hand-edit the YAML in their own editor, or drag blocks on the canvas — either way, the other view updates immediately, with zero information loss. The spec runs locally against a real LLM (bring-your-own-key) or a local model (Ollama), including tool calls and human-approval steps, fully offline-testable with recorded mock tool responses. When ready, the spec exports to a standalone, runnable TypeScript project with no further dependency on this tool at all — the "no lock-in" guarantee that builds trust with technical buyers.

It feels like: `npx kampong dev` opens a local canvas in the browser, pointed at a folder of plain `.yaml` files that are safe to commit to git. Nothing leaves the laptop unless the developer configures it to.

## Users and actors

- **Primary: the technical builder** — a developer or agency engineer building an agent workflow for their own ops or for a client. They are the buyer and the one who ultimately owns the spec/code. In practice, many will author or edit the YAML spec entirely outside this app — in Cursor, or via an agentic coding tool (Claude Code, Codex) — rather than through the in-app editor (ADR-0008).
- **Secondary: the non-technical collaborator** — a teammate or client who views and lightly edits the same workflow through the canvas's plain-language blocks, without touching YAML directly.
- **Non-human actor: the CLI**, used the same way by a human at a terminal or by CI (e.g., validating a spec, running a regression test on every commit).

On conflict: the technical builder's expectations win. The canvas must never produce a YAML diff a developer wouldn't want to see, and it must never silently overwrite an external edit (see Implementation decisions).

## Scope

**In this milestone (v1).**

- A single-agent `AgentSpec` YAML format: role/goal, knowledge references, HTTP tools, guardrails, a linear/conditional workflow (per the schema already sketched in `ideation.md` §4.2, trimmed to one agent — ADR-0001).
- A local web canvas (served via CLI, not a desktop app — ADR-0005) that reads and writes this YAML bidirectionally, with zero data loss on round-trip, for every supported node type — including specs authored or edited entirely outside the app, which render with zero import step and auto-reload on change by default (ADR-0008).
- A published JSON Schema for the `AgentSpec`, wired via the `yaml-language-server` pragma convention, so external editors and agentic coding tools get real validation/autocomplete on Kampong specs (ADR-0008).
- Local execution of a spec against a BYOK cloud model or a local Ollama model, including HTTP tool calls, conditional branching, and a blocking human-approval step for guardrail-triggered escalation.
- Fully offline test capability: mock/record tool responses, no required network calls, no telemetry by default.
- One-way TypeScript export ("eject") to a standalone, independently runnable Mastra project — no bidirectional code sync (ADR-0002).
- A CLI (`kampong dev`, `kampong run`, `kampong export`) as a script/CI-friendly entry point with JSON output and meaningful exit codes.

**Out of this milestone — but roadmapped, not cut (see SLICES.md V5–V6):**

- **Hosted/BYOK SaaS mode (V5).** Same canvas UI, hosted multi-tenant, with workspace-scoped key storage. Comes after v1 proves the local duality/execution/export loop actually gets used.
- **Enterprise governance (V6).** SSO/SCIM, RBAC, PII scrubbing/egress firewalls, SIEM-exportable audit logs, per-run cost circuit breakers, department chargebacks. Sequenced after hosted mode exists, because these features exist to satisfy IT/security review of a _shared_ system — there's nothing to review in a single-user local tool.
- **LLM gateway with automatic cross-provider failover** — folds into V5, once shared infrastructure makes reliability-at-scale a real concern (ADR-0004).

**Further out on the roadmap — not sequenced in detail yet (see SLICES.md V7–V8):**

- **Multi-agent org-chart orchestration (V7, ADR-0001).** Manager/worker delegation, an org-chart canvas view. The spec schema leaves room for a `sub_agents` field, but the real design work waits until the single-agent spec and execution model (V1–V4) are proven.
- **Natural-language prompt-to-workflow generation (V8, Q13).** "Type a sentence, get a generated harness." A separate, nondeterministic R&D problem in its own right — waits until there's a stable spec/execution target to generate reliably against.

**Out and not currently roadmapped (revisit only if it becomes a real blocker):**

- Real-time multi-user collaborative editing (Q24).

## Requirements

| ID  | Requirement                                                                                                                                                                                           | Status          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| R0  | A developer designs an agent visually and gets a lossless, git-diffable YAML spec, kept bidirectionally in sync with the canvas — with no platform lock-in.                                           | Core goal       |
| R1  | Canvas edits and direct YAML edits — including specs authored entirely in an external editor or agentic coding tool — stay bidirectionally synced with zero data loss, for every supported node type. | Must-have       |
| R2  | A spec executes locally — BYOK cloud model or local Ollama model — including tool calls and a blocking human-approval guardrail step.                                                                 | Must-have       |
| R3  | The full local workflow (build, run, test) works fully offline via mock tool recording and local models, with no required network calls or default telemetry.                                         | Must-have       |
| R4  | A spec exports to a standalone TypeScript project that runs independently of this tool and behaves identically to the canvas-run version on the same input.                                           | Must-have       |
| R5  | Tool definition works via a structured form with zero LLM calls; NL-assisted schema drafting is optional on top.                                                                                      | Must-have       |
| R6  | CLI commands are scriptable: JSON output, meaningful exit codes, usable from CI.                                                                                                                      | Must-have       |
| R7  | Hosted/BYOK SaaS mode, reusing the same canvas UI.                                                                                                                                                    | Roadmap (V5)    |
| R8  | Enterprise governance: SSO/RBAC/audit logs/PII scrubbing/cost circuit breakers.                                                                                                                       | Roadmap (V6)    |
| R9  | Further-future, not yet sequenced in detail: R9.1 multi-agent org-chart orchestration; R9.2 natural-language prompt-to-workflow generation.                                                           | Roadmap (V7/V8) |

## Shape

| Part | Mechanism                                                                                                                                                                                                                                                                                                                     | ADR                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| S1   | `AgentSpec` YAML schema + validator (parsed via the `yaml` package for comment/format-preserving round trips, not `js-yaml`): single source of truth, versioned (`version` field), single write path — every mutation (canvas action, CLI edit, or external file edit) is parsed and validated before anything else reads it. | ADR-0002, ADR-0007                     |
| S2   | Canvas renderer/editor (React + `@xyflow/react`): reads/writes `AgentSpec` + sidecar `.kampong/layout.json`; file-watcher auto-reloads on external changes by default, prompting only on a genuine in-flight-mutation conflict.                                                                                               | ADR-0002, ADR-0006, ADR-0007, ADR-0008 |
| S3   | Execution engine: maps a validated `AgentSpec` to a Mastra agent (system prompt, HTTP tools, conditional workflow steps); `requires_approval` steps block on an interactive prompt (browser modal for canvas test-runs, CLI stdin for headless runs) until approved or rejected.                                              | ADR-0003, ADR-0004                     |
| S4   | Mock/record tool layer: captures a real HTTP tool response once, replays it deterministically on later runs; Ollama adapter for local-model execution with a hard error (never silent fallback) if unavailable.                                                                                                               | —                                      |
| S5   | CLI (`kampong dev` / `kampong run` / `kampong export`) + the local Fastify server `kampong dev` starts (static canvas assets, spec-CRUD REST API, SSE run-progress stream): thin wrapper around S1–S3/S6, the single entry point whether invoked by a human or a script/CI job.                                               | ADR-0005, ADR-0007                     |
| S6   | TypeScript exporter: `AgentSpec → standalone Mastra project` codegen, one-way, never re-imported.                                                                                                                                                                                                                             | ADR-0002, ADR-0003                     |
| S7   | Published JSON Schema artifact for the `AgentSpec`, versioned alongside S1, referenced via a `# yaml-language-server: $schema=...` pragma so external editors/agentic tools validate specs without touching this app.                                                                                                         | ADR-0008                               |

## Affordances

**UI.**

| Affordance                                             | Place                                                                          | Wires to                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------- |
| Block canvas (Trigger → Tools → Workflow → Guardrails) | Main canvas view                                                               | S2 → S1                               |
| Property inspector side panel                          | Opens on block click                                                           | S2 → S1                               |
| Split-screen YAML preview                              | Toggleable panel beside canvas                                                 | S1 (read-only render of current spec) |
| Tool builder form (name, method, URL, extract path)    | Modal from "Add Tool"                                                          | S1                                    |
| Confidence-threshold guardrail control                 | Guardrails block inspector                                                     | S1                                    |
| Test-run sandbox + approval modal                      | "Run" button, in-canvas panel                                                  | S3                                    |
| External-change auto-reload notice                     | Non-blocking toast when file changes on disk (prompt only on genuine conflict) | S2                                    |

**Non-UI.**

| Affordance                                  | Kind             | Wires to                                  |
| ------------------------------------------- | ---------------- | ----------------------------------------- |
| `kampong dev`                               | CLI command      | Starts local server (S2, S3) on localhost |
| `kampong run <spec>.yaml --input "..."`     | CLI command      | S3, headless, JSON output + exit code     |
| `kampong export <spec>.yaml`                | CLI command      | S6                                        |
| `.kampong/layout.json`                      | Sidecar store    | S2                                        |
| Mock/record tool store                      | Local file store | S4                                        |
| Local run-history log (SQLite or flat JSON) | Store            | S3                                        |

## Implementation decisions

- **Module boundaries:** a spec-parser/validator package (S1) that every other package depends on and none of them bypass; a canvas web app (S2) and CLI (S5) that are two front ends to the same S1/S3/S6 packages, not separate implementations.
- **Concurrency:** the canvas file-watches the spec on disk. Because every canvas mutation flushes to disk immediately (no sustained "unsaved state"), an external change auto-reloads by default with a lightweight notice — the canvas prompts only in the narrow case where a local mutation is in flight but not yet flushed when the external write lands (Q10, ADR-0008). There is no merge — the most recent write wins, consistent with a single-user local tool.
- **Stack:** canvas app in React + `@xyflow/react`; local server in Fastify with SSE for run-progress streaming; YAML parsed via the `yaml` package for comment/format-preserving round trips; no database in v1 (ADR-0007).
- **External-editor support:** the `AgentSpec` JSON Schema (S7) is published and referenced via the `yaml-language-server` pragma so Cursor/VS Code/agentic coding tools validate specs natively; the in-app YAML view is a light viewer/editor, not a competing IDE (ADR-0008).
- **Failure behavior:** invalid YAML surfaces a specific line/field error in both the code preview and the canvas (not a generic parse failure); a failed tool call or LLM error during a run halts that run and reports which step failed, rather than continuing silently; an unavailable local model is a hard, visible CLI error, never a silent fallback to a paid API (Q8).
- **Secrets:** the spec references credentials only as `${ENV_VAR}` placeholders (Q14); actual values live in `.env`/the OS environment and are never written into a spec file, so any spec is always safe to commit.
- **Telemetry:** none by default in local mode (Q15); any future usage analytics is explicit opt-in.
- **Versioning:** every spec carries a `version` field (Q16) from day one; loading an older version runs a simple field-based migration rather than failing outright.
- **Visual design system:** any frontend/UI work (the canvas app, property panels, guardrail controls, and later the hosted V5 UI) is built using Material Design 3 (the `material-design-3` skill/reference) — color roles, type scale, shape/elevation tokens, and state layers — rather than an ad hoc component set, so the UI stays visually coherent as it grows from local canvas to hosted product.

## Testing approach

The highest-leverage seam is the round trip: `YAML → canvas render → canvas mutation → YAML serialize → re-parse`, which must be a fixed point for every supported node type — this is tested as a property/fixture suite, not through UI click-throughs. The second-highest seam is execution correctness against fixtures: recorded mock tool responses make agent runs deterministic and testable without live API calls. The exporter is tested by actually installing and running the generated project in CI and diffing its output against the canvas-run output on the same fixed input — behavioral equivalence, not code-shape comparison. Per-slice test plans live in SLICES.md.

## Assumed defaults

| ID  | Assumed                                                                   | Cost if wrong                                                                                                                       |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Q5  | MVP must execute agents locally, not just design+export                   | Rebuilding slice sequencing; guardrail/HITL UX would be untestable and undemonstrated                                               |
| Q6  | Canvas is a local web app, not a desktop app                              | Repackaging effort (Electron wrapper) if developers reject browser-based local tools; moderate                                      |
| Q7  | No separate LLM gateway needed for v1                                     | Have to retrofit resilience logic if BYOK direct-call failures prove too disruptive even locally; low-moderate                      |
| Q9  | Layout lives in a sidecar file, not the YAML                              | Migration script needed if this is wrong once specs exist in the wild; low                                                          |
| Q10 | External changes auto-reload by default (prompt only on genuine conflict) | If auto-reload ever feels data-lossy to real users, need to add back an explicit confirmation step; low-moderate, easy to add later |
| Q11 | HITL approval is a blocking local prompt, not remote escalation           | Acceptable gap for local-first MVP; becomes a real requirement only once hosted mode (V5) has real users needing async approval     |
| Q12 | Structured form is the primary tool-definition path, NL-assist optional   | Low cost either way; additive if wrong                                                                                              |
| Q17 | Plain files, no database, for spec/layout/mock storage                    | Migration to a DB-backed store would be needed for hosted mode (V5) regardless — not wasted work                                    |

## Open risks

- **Duality round-trip correctness is the single biggest technical risk.** If the canvas can't guarantee zero-loss round-tripping for real-world specs (nested conditionals, multiple tools), the core differentiator collapses into "yet another YAML editor with a diagram view." Slice 1 (SLICES.md) exists specifically to surface this early.
- **Mastra's TypeScript-only stance (ADR-0003) may cost adoption among Python-centric agent builders.** If early user interviews show the target technical audience strongly prefers Python, this is a hard-to-reverse decision — worth explicitly validating with a handful of target users before or during Slice 1, not after v1 ships.
- **"No lock-in" is only credible if the exported code is actually good, idiomatic TypeScript a developer would want to maintain**, not obviously-generated boilerplate. Slice 4's acceptance test (behavioral equivalence) doesn't check this; it should be spot-checked by hand before calling v1 done.
