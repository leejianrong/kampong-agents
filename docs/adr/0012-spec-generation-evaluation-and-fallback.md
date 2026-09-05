# ADR-0012: Scope evaluation and fallback approach for natural-language spec generation (V8)

- Status: Proposed
- Date: 2026-09-05
- Deciders: Jian (product owner)

## Context

SLICES.md's V8 ("Natural-Language Prompt-to-Workflow Generator") delivers R9.2: a user types
something like _"build me an agent that monitors my inbox for refund requests, checks Stripe, and
drafts a response"_ and the tool generates an initial `AgentSpec` (the original sketch is
`ideation.md` §3.2's "prompt-to-workflow engine," one bullet inside its hybrid-canvas pitch — the
doc never goes deeper than that one sentence anywhere else). QUESTIONS.md's Q13 decided V8 is "not
in v1... a separate, nondeterministic R&D problem... waits until there's a stable spec/execution
target to generate reliably against." V1–V4 are now that stable target (AGENTS.md's build-status
section), which is why SLICES.md names three concrete design questions to resolve "when this is
actually scoped": how generation quality gets evaluated, what the fallback is when generation
produces an invalid or nonsensical spec, and whether this runs against BYOK models only or needs a
dedicated fine-tuned/prompted approach.

This ADR is that scoping decision — not an implementation plan. It proposes concrete, reasoned
answers to the three questions, grounded in what actually exists in the codebase today, and is
explicit about which parts are firm recommendations versus open questions V8 implementation work
should still expect to revisit. Because V8 is explicitly named as "a separate, nondeterministic
R&D problem" rather than a normal slice, this ADR carries more open questions than usual — that is
expected, not a gap in the analysis, provided each of the three named questions gets a concrete
proposed direction.

**What the current code actually looks like**, as of the V1–V4 baseline this ADR builds on:

- `packages/spec/src/parse.ts`'s `parseSpec` is already exactly the "field/line-level error, not a
  generic parse failure" validator (KAN-1095): it runs the YAML source through `yaml`'s
  `parseDocument` with a `LineCounter`, then `agentSpecSchema.safeParse`, and maps every Zod issue
  back to a concrete `{ path, message, line, column }` via `doc.getIn(path, true)`'s source range.
  This is the exact machinery a generated spec needs to pass through — a generated spec is not a
  new kind of artifact the schema treats specially, it is YAML text, same as a hand-authored file.
- `packages/spec/src/schema.ts`'s `agentSpecSchema` is single-agent only (ADR-0001): one
  `role`/`goal`/`model`/`guardrails`/`tools`/`workflow` per file, `tools[].action` fixed to
  `"http_request"`, `model.api_key` constrained to a `${ENV_VAR}` placeholder
  (`envVarPlaceholderSchema`) and never a literal secret. Nothing about generation gets to relax
  any of this — a generated spec is validated against precisely the same schema a human author's
  spec is.
- `packages/spec/src/json-schema.ts` publishes `agent-spec.v1.0.schema.json` from the same Zod
  schema (ADR-0008's `yaml-language-server` pragma wiring), so an accurate, current JSON Schema
  for "what a valid `AgentSpec` looks like" already exists as a build artifact — it does not need
  to be independently maintained for a generator's prompt/few-shot context.
- `packages/engine/src/model.ts`'s `ModelClient` (built in ADR-0009's `generateStructured` work)
  already resolves a BYOK provider/model/api_key from an `AgentSpec`'s `model` field and asks a
  real Mastra `Agent` for structured `{ result, confidence }` output for `confidence_gate` steps.
  This is the same shape of capability ("ask a configured model for structured output, get a
  confidence-like signal back") a judge-style quality check over a generated spec would need —
  nothing about it is generation-specific today, but the pattern already exists to build on.
- There is no existing eval-harness, LLM-as-judge, or golden-fixture-regression infrastructure
  anywhere in the repo today (checked across `packages/*/test` and `e2e/`). The closest analogues
  are `packages/engine/src/tool-fixtures.ts` (recorded mock **tool** responses for deterministic
  HITL/guardrail tests, not model-output quality scoring) and `packages/spec/test/fixtures.ts`
  (hand-authored `AgentSpec` YAML fixtures for parser/round-trip tests, not prompt→spec pairs).
  V8 is not extending a partially-built eval system — it is proposing the first one.
- ADR-0004 (no LLM gateway; a failed model call fails visibly, never silently retried against a
  different provider) and AGENTS.md's Ollama convention (an unavailable local model is a hard,
  visible error, never a silent fallback to a paid cloud API) are the two load-bearing
  anti-silent-fallback precedents this ADR must stay consistent with — spec **generation** is
  still a model call, and the project's general philosophy toward model-call failure is not
  suspended just because the call in question produces YAML instead of a chat reply.

## Decision

### 1. Generation quality is evaluated in three layers — schema validity as a hard gate, a small golden-fixture regression set as the only thing tracked as a leading indicator, and LLM-as-judge / human review as directional signals — not one single "quality score."

**Firm recommendation.** Reuse `packages/spec`'s existing `parseSpec` as the hard, non-negotiable
gate: a generated spec that fails schema validation is **not** a successful generation, full stop
(see Decision 2 for what happens instead). This is not a new check to design — it is the same
validator every hand-authored spec already goes through, run against generated YAML text with zero
special-casing.

Passing schema validation is necessary but not sufficient — a spec can be perfectly valid
`AgentSpec` YAML and still not reflect what the user actually asked for (e.g. the user asked for a
Stripe check and the generated spec has no such tool). Two further layers are proposed for that
gap:

- **A small, hand-curated golden-fixture regression set**, structured as prompt → expected-shape
  assertions (e.g. "must include a tool referencing a Stripe-like URL," "must include a
  `request_human_approval` or `confidence_gate` somewhere," not a byte-exact expected YAML file,
  since generation is nondeterministic). This lives at the same altitude as
  `e2e/exporter-behavioral-equivalence.test.ts` — an e2e-layer regression suite that actually
  invokes generation and asserts on the result — and gives V8 implementation work a concrete,
  versionable signal for "did changing the generation prompt/model make things better or worse,"
  the same role `packages/spec/test/fixtures.ts` and `packages/engine/src/tool-fixtures.ts` already
  play for their respective slices.
- **LLM-as-judge, using the same `ModelClient.generateStructured` pattern ADR-0009 already built**,
  scoring a generated spec against the original prompt on a small number of concrete axes (does
  the spec's `role`/`goal` match the stated intent, are the tools the user described present, is
  there a plausible guardrail/approval step where the prompt implied risk). This is a **directional
  signal for a human reviewer**, not an automated pass/fail gate — see Decision 2 for why nothing
  gets auto-approved on the strength of a judge score alone.

Human review is not a fourth, separate mechanism bolted on top — it is the existing canvas review
loop. A generated spec is not something the tool ever executes on the strength of its own
generation; it lands on the canvas exactly like any externally-authored spec would (ADR-0008's "a
folder of specs renders with zero import step" already covers this — a freshly generated spec file
is just another file in that folder), where the user sees the block canvas, the YAML preview panel,
and (if wired in for this feature) the judge's directional notes, before anything runs. This is
deliberately not a new UI concept to invent; it is the same review surface every hand-authored spec
already gets.

**Open questions for V8 implementation to revisit:**

- The exact judge-score schema/axes and how (or whether) they surface in the canvas UI at all —
  this ADR only establishes that judging is directional and reuses `generateStructured`, not the
  concrete prompt or scoring rubric.
- Whether the golden-fixture set needs to grow into anything resembling a benchmark suite (tracked
  over time, gating a "generation prompt changed" PR) or stays a small manually-run regression
  check — a genuine eval-harness investment this ADR does not size.
- Whether human review needs a dedicated "generation review" UI affordance (e.g. a diff-like view
  emphasizing what the model added versus a blank spec) beyond the existing canvas/YAML-preview
  surface, or whether reusing that surface unchanged is good enough for a first cut.

### 2. Fallback for an invalid or nonsensical generation is always a visible, un-auto-repaired failure surfaced through the existing validation-error UI — never a silent retry, auto-fix, or degrade.

**Firm recommendation.** This decision is the direct extension of ADR-0004's "a failed call fails
visibly, it is not silently retried against another provider" and AGENTS.md's Ollama
hard-error convention into the generation feature specifically:

- **Schema-invalid output** (the generated YAML doesn't parse, or fails `agentSpecSchema`) is
  surfaced through exactly the same `SpecError[]` (`path`/`message`/`line`/`column`) the hand-authoring
  path already produces — the raw generated YAML is shown to the user alongside its field/line-level
  errors, precisely as if the user had hand-typed something broken. No parallel "generation failed"
  error format gets invented, and nothing about the errors is hidden or summarized away.
- **No silent auto-repair.** The tool never quietly rewrites, patches, or "fixes" a generated
  spec's invalid fields on its own initiative and presents the repaired version as if it were the
  original generation — that would mean the user reviews and approves something the model produced
  in a second, invisible pass they never saw, which is exactly the kind of silent-degradation this
  project's model-call philosophy exists to rule out.
- **A bounded, visible retry against the same configured model/provider is allowed, a silent one is
  not.** If a first generation attempt is schema-invalid, the tool may re-prompt the same BYOK
  model the user already configured (e.g. feeding the validation errors back so the model can
  correct itself) — but the retry itself, and the fact that it happened, must be visible in the UI
  ("generation failed validation, retrying (1/N)..."), and after a small fixed retry cap (proposed:
  low single digits) it fails visibly with the last set of validation errors shown, rather than
  looping indefinitely or falling back to a different provider/model than the one configured. This
  mirrors ADR-0004's own model exactly: retrying the _same_ provider on a transient failure is
  reasonable; silently switching providers is not, and neither is silently trying forever.
- **Schema-valid but nonsensical output has no separate mechanical fallback** — there is no
  reliable automated test for "this valid spec doesn't actually mean what the user meant," which is
  precisely why Decision 1 puts that judgment in the LLM-as-judge/human-review layer rather than a
  hard gate. The fallback for this case is procedural, not mechanical: the spec is never
  auto-executed on the strength of passing schema validation alone, it always lands as a draft
  for human review on the canvas, same as every other generated spec regardless of quality signal.

**Open questions for V8 implementation to revisit:**

- The exact retry cap and whether the re-prompt strategy (feeding validation errors back verbatim
  vs. a more structured repair prompt) meaningfully improves success rate — an empirical question
  for implementation time, informed by the golden-fixture set from Decision 1.
- Whether a user-facing "discard and regenerate from scratch" action (a fresh attempt, not a
  correction of the last one) is offered alongside the automatic bounded retry — plausible, not
  decided here.
- Whether partial generations (e.g. a plausible `agent.role`/`goal` but a `workflow` the model
  couldn't complete) are worth surfacing as an explicitly-labeled partial draft, or whether "no
  passing spec" should always mean "nothing shown but the errors" with no partial-credit UI at all.

### 3. Generation targets BYOK models only, through the existing `ModelClient`/Vercel AI SDK path — no dedicated hosted, fine-tuned, or gateway-fronted generation model in this scope.

**Firm recommendation.** Spec generation is itself a model call, and this project already has a
settled position on how model calls are made (ADR-0004): straight through Mastra's Vercel AI SDK
provider interface, resolved from a user-supplied provider/model/`${ENV_VAR}`-referenced API key,
with no gateway and no automatic cross-provider failover. There is no reason for the generation
feature to be the one model call in the whole product that breaks this pattern. Concretely: the
"generate a spec from this prompt" call reuses the same `ModelClient` resolution
`packages/engine/src/model.ts` already implements — provider, model name, and API key come from
whatever the user has configured (the same BYOK credentials they already use to run their agents),
not from a Kampong-operated hosted inference service or a separately licensed fine-tuned model.

This also keeps the feature consistent with two other load-bearing conventions beyond ADR-0004
specifically: **local-first, no telemetry by default** (a user's natural-language prompt — which
may describe real business logic, e.g. "checks Stripe" — goes only to whichever BYOK provider they
already trust with their agent's own model calls, never to a Kampong-operated collection point) and
**the Ollama hard-error convention** (if a user has configured a local Ollama model and generation
against it fails or produces garbage, that is a visible failure exactly as Decision 2 describes —
never a silent, unrequested upgrade to a paid cloud API on the user's behalf).

A dedicated fine-tuned or specially-prompted generation model is explicitly not ruled out
forever — it is deferred, not rejected, the same way ADR-0004 defers a gateway to V5 rather than
building one before there is evidence it is needed. The proposed starting point is prompting a
generic, already-configured BYOK model well: a system prompt built around the published
`agent-spec.v1.0.schema.json` (already generated for editor tooling per ADR-0008 — reused here as
generation context, not re-authored) plus a handful of few-shot prompt→spec examples drawn from the
golden-fixture set in Decision 1. Whether that prompting-only approach produces acceptable quality
across the range of local (Ollama) and cloud (Anthropic/OpenAI/OpenRouter) models this project
already supports, or whether some provider tier needs a genuinely different approach (a
fine-tuned model, a much larger few-shot context, or being descoped from generation entirely for
weaker local models) is exactly the kind of empirical, nondeterministic question SLICES.md already
flags this whole slice as being about — this ADR proposes where to start, not a guarantee of where
it ends.

**Open questions for V8 implementation to revisit:**

- Whether every supported provider (including small local Ollama models) is expected to support
  generation at comparable quality, or whether generation is scoped to cloud providers only for a
  first cut, with local-model generation explicitly called out as lower-quality/best-effort rather
  than silently assumed equivalent.
- Whether a fine-tuned or specially-prompted model ever becomes warranted, and if so whether it
  would be self-hosted (consistent with local-first) or a hosted Kampong-operated service (which
  would need its own ADR, likely tied to the V5 hosted slice rather than V8 itself).
- Whether the few-shot golden-fixture examples fed into the generation prompt need to be
  user-extensible (letting a team seed generation with their own house style of spec) or stay a
  fixed set shipped with the tool.

## Alternatives considered

| Option                                                                                                                                                | Why not                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build a wholly new, generation-specific validator instead of reusing `parseSpec`                                                                      | A generated spec has to pass exactly the same validity bar a hand-authored one does (same schema, same downstream canvas/engine/exporter) — a parallel validator would risk drifting from the real schema and duplicates machinery that already reports field/line-level errors.      |
| Treat a single automated quality score (schema validity alone, or a single LLM-judge score alone) as sufficient to auto-accept a generation           | Schema validity can't detect "valid but wrong"; a single judge score is itself a nondeterministic model call and not a safe sole gate for auto-accepting anything, especially given this project's guardrail-forward, human-in-the-loop framing.                                      |
| Silently retry generation against a different, "smarter" provider when the configured one produces invalid output                                     | Directly reproduces the exact cross-provider auto-failover ADR-0004 already rejected for ordinary agent execution — there is no principled reason generation should get an exception to that rule.                                                                                    |
| Auto-repair an invalid generated spec's specific failing fields (e.g. patch a missing required field with a placeholder) and present it as the result | Presents the user with something the model produced in an invisible second pass they never reviewed, undermining the trust the fail-visibly convention exists to protect — indistinguishable in effect from a silent fallback.                                                        |
| Build or license a dedicated fine-tuned spec-generation model before shipping any version of V8                                                       | Real infrastructure/training investment that matters once there's evidence prompting a generic BYOK model isn't good enough — building it first repeats the "governance/reliability infrastructure before a customer justifies it" pattern ADR-0004 already called out for a gateway. |
| Route generation calls through a dedicated hosted Kampong-operated inference service                                                                  | Introduces exactly the kind of centralized, Kampong-operated model-serving component the local-first/no-telemetry/no-gateway-until-V5 conventions all argue against doing before the hosted slice exists.                                                                             |

## Consequences

- Generation quality evaluation is layered, not a single score: `parseSpec` schema validity is a
  hard gate (reusing existing, already-tested machinery), a golden-fixture regression set is the
  first eval-harness-shaped infrastructure this repo will have, and LLM-as-judge plus human review
  are directional signals feeding the same canvas review surface every spec already gets — no new
  "generated spec" review UI concept needs inventing for a first cut.
- The fallback story for generation failure is a direct, unexceptional extension of ADR-0004 and
  the Ollama hard-error convention: bounded same-provider retry is fine, cross-provider failover
  and silent auto-repair are not, and "valid but nonsensical" is handled procedurally (never
  auto-run) rather than mechanically (no automated nonsense-detector is being built).
- Generation is scoped to BYOK models via the existing `ModelClient`/Vercel AI SDK path, with no
  new hosted or gateway-fronted component — consistent with local-first/no-telemetry and with
  ADR-0004's stance that a gateway (and, by the same reasoning, dedicated generation
  infrastructure) waits for the hosted slice (V5) to justify it. A fine-tuned generation model is
  deferred, not rejected, pending evidence that prompting alone underperforms.
- A generated spec that passes validation is the source of truth from that point on, exactly like
  a hand-authored one (ADR-0002) — the canvas, CLI, and execution engine have no notion of
  "generated" versus "hand-authored" specs, and this ADR introduces none. Generation only ever
  produces v1-scoped, single-agent `AgentSpec` files (ADR-0001) — nothing here proposes generation
  target `sub_agents` or any other not-yet-shipped schema surface.
- This ADR leaves real, sized-for-V8-implementation-time work open: the judge scoring rubric, the
  size and maintenance model of the golden-fixture set, the exact retry cap and re-prompt strategy,
  and whether local-model generation is first-class or best-effort. That is expected and
  acceptable for a scoping decision over "a separate, nondeterministic R&D problem" — SLICES.md's
  V8 section is otherwise still accurate and does not need updating as a result of this ADR.
- This ADR supersedes none of ADR-0001, ADR-0002, or ADR-0004 — it applies ADR-0004's
  no-gateway/fail-visibly reasoning to a new kind of model call (generation) that didn't exist
  when ADR-0004 was written, and confirms ADR-0001's and ADR-0002's single-agent/YAML-source-of-
  truth constraints apply unchanged to generated specs.
