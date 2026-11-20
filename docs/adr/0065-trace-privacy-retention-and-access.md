# ADR-0065: What a trace may hold, how long it lives, and who can read it

- Status: Proposed (defaults below need the product owner's confirmation)
- Date: 2026-11-20
- Deciders: Jian (product owner); drafted by the agent working KAM-255

## Context

A trace records what an agent did. Prompts and model outputs can hold customer messages, personal data and secrets.
ADR-0063 adds traces for Kampong workflows and, later, for agents built elsewhere over OpenTelemetry, whose GenAI
conventions can carry the full prompt and completion as span attributes. ADR-0053 left the hosted analytics policy
open, and "no telemetry by default" is a local-CLI convention only. The enterprise buyer will ask these questions
first, so they are settled before outside ingest ships (KAM-267).

Today's recorder (KAM-256) already follows decision 1 below: it stores timing, status, model name and token counts,
and no prompts or outputs.

## Decision (proposed defaults)

1. **Metadata by default, content by choice.** A trace stores structure and numbers: step names and kinds, timing,
   status, errors, model, token counts, cost. **Prompt and output content is off by default** and is switched on per
   workspace (and per workflow) because evals, the playground and the judge need it. Hosted shows what is stored
   before it is switched on. Local mode may keep content in `.kampong/` because the data never leaves the machine.
2. **Outside agents: content attributes are dropped at ingest** unless the workspace has switched content on. The
   OTLP endpoint removes the `gen_ai.prompt`, `gen_ai.completion` and message-content attributes before storage, not
   at display time.
3. **Redaction at write time.** Before anything is stored, known secrets and configured patterns (emails, card
   numbers, API-key shapes, plus the workspace's own regexes) are replaced with a marker. The engine's existing
   secret redaction (`redact.ts`) is the base. Redaction is never applied only when reading, because the stored copy
   is what leaks. A redacted trace says it was.
4. **Retention (hosted defaults, per workspace configurable):** content-bearing traces 30 days; metadata-only traces
   90 days; datasets and experiment results until the owner deletes them, because they are a deliberate copy.
   Retention drops whole monthly partitions (ADR-0064). Self-host defaults are the same and configurable, including
   "keep forever".
5. **Access.** A workspace's traces are visible to its members by role: any member sees metadata; content is visible
   to admins and reviewers only. Kampong staff have no access to a customer's trace content; a support session needs
   the customer's explicit, time-boxed grant, and is logged. Cross-workspace access is impossible by RLS (ADR-0014).
6. **Deletion.** Deleting a run, a workflow or a workspace deletes its traces, content and any dataset items that
   reference them only if the owner chooses to. A workspace export includes its traces.
7. **Our analytics are separate.** The hosted product's own usage analytics never read trace content, and customer
   traces are never used to train or evaluate Kampong's own models. Hosted product analytics are listed on a public
   page. The local CLI stays at no telemetry by default (AGENTS.md).
8. **LLM-as-judge sends content to a model provider.** Switching on judge scoring says so, and uses the workspace's
   own key unless the owner chose otherwise (the key source is KAM-252).

## Not decided here

- The exact default numbers in decision 4 (30 and 90 days), and whether metadata should live longer on paid plans.
- Legal review of the policy and any region requirements (data residency); the enterprise licence's terms.
- Whether reviewers need a second, narrower role than admin for content.

## Consequences

- KAM-256's recorder already conforms; KAM-257 stores only what decisions 1 to 3 allow.
- Dataset, judge and playground slices (KAM-260, 261, 262, 264) need the content switch and say so in their UI.
- OTLP ingest (KAM-267) is blocked on this ADR being Accepted.
- ADR-0053's open "analytics policy for hosted" question is answered by decision 7, once accepted.
