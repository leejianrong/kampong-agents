# ADR-0005: OpenRouter is the default model provider; never a direct Anthropic key

- Status: Accepted
- Date: 2026-09-20
- Deciders: leejianrong

## Context

Slice 1 (`pr-review-swarm/`) originally wired its agents straight to
Anthropic via `@ai-sdk/anthropic` + `ANTHROPIC_API_KEY`, mirroring
kampong-agents' own engine default. The user then stated a standing
preference, not scoped to this one demo: never call the Anthropic API
directly, in this project or any other. Default to OpenRouter; fall back to
some other OpenAI-compatible API only if OpenRouter genuinely doesn't fit.

## Decision

Every `mastra-projects` demo resolves its model through OpenRouter by
default: `@ai-sdk/openai`'s `createOpenAI` pointed at
`https://openrouter.ai/api/v1` with a real `OPENROUTER_API_KEY`, using
`.chat(modelName)` rather than the bare factory call (OpenRouter only
implements the Chat Completions API, not OpenAI's newer Responses API --
the same gotcha kampong-agents' own `packages/engine/src/model.ts` already
hit and documented for Ollama/OpenRouter). The model name itself is
configurable per demo via an env var, defaulting to a generic, inexpensive
model rather than anything Anthropic-branded.

This is scoped to code these demos write themselves -- it does not touch
kampong-agents' own product, where `AgentSpec.model.provider` supporting
`anthropic` as one of several user-selectable BYOK options is a legitimate
product feature, not something being defaulted to on the user's behalf.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep Anthropic as the default, let OpenRouter be an opt-in override | Contradicts the explicit standing preference; a default the user has to remember to override every time is the wrong default |
| A different OpenAI-compatible provider (e.g. a direct OpenAI key) as the primary default | OpenRouter was named first and gives model choice without a second BYOK key per provider; direct OpenAI stays the documented fallback if OpenRouter doesn't fit a specific demo |

## Consequences

Every demo needs one `OPENROUTER_API_KEY` rather than a per-provider key,
and picking a different underlying model is a one-line env var change rather
than a code change. The cost is one more real gotcha to get right per demo
(`.chat()` vs. the bare factory call) -- already paid once in `pr-review-swarm/`
and documented there and here so the next demo doesn't rediscover it.
