# ADR-0060: A workflow assistant over any OpenAI-compatible endpoint

- Status: Accepted for local mode; the hosted key source is open (KAM-252)
- Date: 2026-10-25
- Deciders: Jian (product owner)

## Context

Prompt-to-workflow is core to the main path for a first user (ADR-0053). Gumloop's chat builder builds, edits and
runs a flow from a description. We have a validated `AgentSpec` and a mutation API (ADR-0055) that a model can be
held to, but no assistant. The product owner decided it should be built and should talk to an OpenAI-compatible
API.

## Decision

1. **Propose, then apply.** The assistant returns a plan as validated edits; nothing changes until the user
   presses Apply. One Undo reverts a whole apply. A follow-up prompt shows its change as a diff first (KAM-206).
2. **Edits go through the mutation layer** (ADR-0055) and are checked against `AgentSpec`. Invalid model output is
   reported and never applied. YAML stays the canonical text form (ADR-0054); the assistant never writes files.
3. **Any OpenAI-compatible endpoint.** Base URL, key and model come from the environment or the spec's model block.
   Order of preference follows the repo rule: OpenRouter, then any OpenAI-compatible endpoint, never defaulting
   to a direct Anthropic key.
4. **No silent fallback.** A failed call fails visibly (ADR-0004); an unreachable local model is a hard error.
5. **Secrets stay out.** Only `${ENV_VAR}` placeholders are in a spec already; the request also carries no `.env`
   values, and nothing is sent unless the user uses the assistant. No telemetry. Using it does send the spec and
   the prompt to the configured endpoint, and the UI says so on first use.
6. **Two modes.** Build proposes edits; Ask answers questions and never edits.
7. **Tests use recorded responses**, as for model fixtures (ADR-0051); no live network in unit or integration.

## Open

- **Hosted key source**: bring-your-own (the BYOK vault) or a resold key with metering. This ties to pricing
  (KAM-209) and is the product owner's decision; the hosted assistant waits on it (KAM-252).

## Consequences

- A new local server route and a chat panel (KAM-249, KAM-250), then Ask mode and diffs (KAM-251, KAM-206).
- The step-kind catalogue sent to the model is generated from the spec package so it cannot drift.
