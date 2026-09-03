# ADR-0008: Hand-editing in an external IDE or agentic coding tool is a first-class workflow

- Status: Accepted
- Date: 2026-09-03
- Deciders: Jian (product owner)

## Context

The primary buyer (PLAN.md §Users and actors) is a technical builder — exactly the kind of user
who will very likely write or edit an `AgentSpec` YAML file in Cursor, or generate/modify one
with an agentic coding tool (Claude Code, Codex), rather than through the in-app canvas or its
YAML preview panel. Those tools already have far better code-editing intelligence (autocomplete,
refactors, AI-assisted generation) than anything this project would build in-house.

ADR-0002 already made YAML the single source of truth with a file-watcher (Q10) that detects
external changes, but the original design treated an external edit as a secondary case — the
canvas would prompt "reload?" on any change from outside the app, as if external edits were the
exception. Given who the primary user actually is, that framing is backwards: external editing
is a primary, heavily-used path, not an edge case to tolerate.

## Decision

1. **A folder of hand-written or agent-generated specs must render on the canvas with zero
   import or registration step.** `kampong dev` pointed at any directory containing valid
   `*.yaml` `AgentSpec` files renders them immediately — this was already an implication of
   YAML being the source of truth (ADR-0002), but is made explicit and load-bearing here.
2. **Auto-reload by default on an external file change — no confirmation prompt.** Every canvas
   mutation flushes to disk immediately (PLAN.md Shape S1: "single write path... every mutation
   is validated before anything else reads it"), so the canvas has no sustained "unsaved state."
   A real conflict exists only in the narrow race where a canvas mutation is in flight
   (validated but not yet flushed) when an external write lands; only that case surfaces a
   prompt. The common case — a developer saves in Cursor, or Claude Code finishes writing a
   file — reloads immediately with a lightweight, non-blocking notification.
3. **Publish the `AgentSpec` schema as a standalone JSON Schema artifact**, versioned alongside
   the spec's own `version` field (Q16), and have the spec-authoring flow reference it via the
   `yaml-language-server` pragma convention (`# yaml-language-server: $schema=...`) that VS
   Code/Cursor's YAML tooling already understands out of the box. This gives external editors
   and agentic coding tools real validation and autocomplete on Kampong specs without this
   project building any editor tooling itself, and lets an agentic tool validate its own
   generated spec without calling into this app at all.
4. **The in-app split-screen YAML view is explicitly scoped as a light, honest viewer/editor —
   not a competitor to Cursor or an agentic coding tool.** A reasonably capable embedded code
   editor component is enough (syntax highlighting, the schema-validated error squiggles any
   such component gets for free from the JSON Schema in (3)); no custom language server, no
   AI-assisted authoring, no refactoring tools get built for v1.

## Alternatives considered

| Option                                                           | Why not                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always prompt on external change                                 | Makes the primary power-user workflow feel adversarial — friction on every single external save, for a conflict that's rare by construction.                                                                                                            |
| Build a smart in-app YAML editor with autocomplete/AI assistance | Strictly worse than what these users already have in Cursor/Claude Code; would spend build effort competing with tools this project can't realistically out-build, instead of on the actual differentiator (the duality engine, execution, and export). |

## Consequences

- The file-watcher (Q10, PLAN.md Shape S2) needs a "pending local mutation" flag to distinguish
  the rare genuine conflict from the common external-edit case — a small but real bit of logic
  beyond a naive prompt-always implementation, and one the round-trip test suite (SLICES.md V1)
  needs to explicitly cover, not just describe.
- The published JSON Schema must stay in lockstep with the versioned spec schema (S1) — every
  spec schema version needs a corresponding schema artifact version, tying into the
  versioning/migration story (Q16).
- This reframes what "editing YAML" means for this product: the in-app editor is a convenience,
  not the primary authoring surface, and messaging/positioning should say so honestly rather
  than imply a competing code-editing experience.
