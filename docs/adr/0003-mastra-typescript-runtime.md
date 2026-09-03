# ADR-0003: Mastra (TypeScript) is the execution runtime

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The ideation doc's own framework survey (§1) names LangGraph as "the industry standard" for stateful, failure-tolerant production agents (Python/TS), and Mastra as "the go-to framework for JavaScript/TypeScript developers," built on the Vercel AI SDK with evals, memory, RAG, and multi-provider routing included.

The product decision to build a local web canvas (ADR-0005) plus a local CLI plus an execution engine means the runtime choice determines whether the whole local tool is single-language or requires bundling a second language runtime. A Python-based engine (LangGraph) would require either shelling out to a bundled Python interpreter from the Node-based CLI/canvas, or running a separate Python process/server locally — real packaging and distribution overhead for a tool whose main promise is "just run it, no lock-in, no fuss."

## Decision

The execution engine is built on **Mastra** (TypeScript). The canvas, CLI, spec parser/validator, execution engine, and TypeScript exporter (ADR-0002) are all one language and one runtime (Node.js). Mastra's Vercel AI SDK foundation is also what removes the need for a separate LLM gateway service in v1 (ADR-0004).

## Alternatives considered

| Option                    | Why not                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LangGraph (Python/TS)     | "Industry standard" for production reliability, but choosing it would mean either bundling a Python runtime inside a Node-based local tool or running a separate Python process — meaningfully more packaging complexity for the local-first MVP, for a reliability guarantee (checkpointed recovery) that matters more at hosted/enterprise scale (roadmap V5/V6) than for a single local test run. |
| CrewAI / AutoGen (Python) | Same single-language-stack problem as LangGraph, plus a role/crew mental model more suited to multi-agent (explicitly deferred, ADR-0001) than the single-agent v1 scope.                                                                                                                                                                                                                            |

## Consequences

- Every part of the local tool ships as one `npm`/`npx`-installable package; no Python interpreter dependency, no cross-language IPC.
- The TypeScript export target (ADR-0002) is native Mastra code, not a translation layer — the exported project _is_ what the canvas ran, reducing behavioral-drift risk between "canvas run" and "exported run" (this equivalence is the acceptance test for SLICES V4).
- If a future enterprise customer specifically requires Python (e.g., to fit an existing Python-only ML/data stack), that is a real limitation of this decision and would need its own investigation — not assumed away here.
- Revisiting this later (e.g., adding a Python execution backend) is possible but nontrivial, since the exporter, execution engine, and local CLI are all currently Mastra/TypeScript-specific.
- **License check (verified 2026-09-03):** Mastra's core framework is Apache 2.0 (moved off Elastic License 2.0 in July 2025), which permits commercial and hosted use with no restriction — this is what makes the V5 hosted-SaaS roadmap viable at all. Mastra's own `ee/`-directory enterprise features (their equivalent of our roadmap V6 governance layer) are under a separate Mastra Enterprise License requiring a paid license for production use — this project must build its own governance layer (V6) rather than depend on Mastra's `ee/` modules, or explicitly budget for a Mastra Enterprise license if it ever reuses them.
