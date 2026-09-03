# ADR-0004: No separate LLM gateway service in v1; add one when hosted mode ships

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The ideation doc's enterprise-features section (§5.2.B) specifies a dynamic LLM gateway with automatic cross-provider fallback/retry (e.g., reroute from OpenAI to Anthropic on a `503`) and cost-aware semantic routing. This is real infrastructure — a proxy service, retry/circuit-breaking logic, provider health tracking — that matters most when many concurrent users are hitting shared infrastructure at scale (i.e., hosted mode, roadmap V5), not for a single developer running one agent locally against their own API key.

Mastra is built on the Vercel AI SDK, which already provides a unified interface for calling multiple model providers (OpenAI, Anthropic, local models via Ollama, etc.) through a consistent API, including manual provider/model switching.

## Decision

v1 has no separate LLM gateway service. Model selection is a per-agent config value in the `AgentSpec` (which provider/model to call), resolved directly through Mastra's Vercel AI SDK provider interface. There is no automatic cross-provider failover in v1: if a call fails, it fails visibly (surfaced to the developer or the guardrail's `fallback_action`), rather than being silently retried against a different provider.

A gateway (self-hosted LiteLLM, or a hosted equivalent) is planned as part of roadmap slice V5 (hosted/BYOK), once multiple users are sharing infrastructure and reliability-at-scale actually matters.

## Alternatives considered

| Option                                                    | Why not                                                                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stand up LiteLLM or Portkey locally in v1                 | Adds an extra local service/process to run and configure for a single-user local tool, for a failover capability that has no real payoff until multiple users/production traffic exist. |
| Build a custom gateway now so it's "ready" for enterprise | Directly repeats the pattern this whole plan is trying to avoid: building governance/reliability infrastructure before there is a customer whose usage justifies it.                    |

## Consequences

- Simpler v1: one fewer moving part to install, run, and debug locally.
- The `AgentSpec`'s model-selection field should be designed generically enough (provider + model name, not hard-coded to one provider) that inserting a gateway later, transparently, doesn't require a spec schema change — only a change in how the execution engine resolves "which provider client to call."
- Explicit gap: if a call fails locally, the developer sees the failure directly rather than getting automatic resilience. This is an acceptable trade-off for MVP and should be called out in docs, not hidden.
