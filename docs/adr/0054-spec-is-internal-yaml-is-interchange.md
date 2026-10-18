# ADR-0054: The spec is the truth; YAML is its interchange format, not the thing users edit

- Status: Accepted
- Date: 2026-10-19
- Deciders: Jian (product owner)

## Context

ADR-0002 made the YAML file the single lossless source of truth, and ADR-0008 made hand-editing it in Cursor or
Claude Code a first-class workflow. That fits a developer working in a folder. It does not fit the first user in
ADR-0053, who should never see a file.

How it works today (checked in the code on 2026-10-19):

- **Local (`kampong dev`).** The canvas sends small patch operations (`set`, `add`, `remove` at a path). `SpecStore`
  applies them to the YAML text with `applyPatchToSource` (comments and formatting survive), validates, and writes
  `agent.yaml`. A file watcher streams external changes back to the canvas. Layout lives in `.kampong/layout.json`.
- **Hosted (`packages/server`).** `PgSpecRepository` stores the same YAML as a text column
  (`specs.yaml_source`) and runs the same `applyPatchToSource`. There is no file watcher. ADR-0020 serves the same
  canvas bundle in both modes behind one `ApiClient` interface.

So hosted mode already keeps the YAML as an internal blob. What is still true everywhere is that every edit is a
text patch addressed by path, which is why there is no step insert, move or rename API (KAM-169/170) and why undo,
history and "what changed" are hard.

## Decision

1. **One definition of a workflow.** The `AgentSpec` schema, validator, JSON Schema and version field in
   `@kampong/spec` remain the only definition of what a valid workflow is. There is no second schema.
2. **The file is no longer the product's truth.** The invariant becomes: *the validated spec is the truth, and YAML is
   its canonical text form.* In hosted mode and for non-technical users the spec is an internal document that the
   product manages. Users are not asked to see or touch a file.
3. **YAML is interchange.** "Download as YAML" and "Import YAML" work at any time, and an optional read-only
   "For developers" view shows the YAML. Exported YAML must be valid for the CLI, `kampong serve` and
   `kampong export`, and `import(export(spec))` must give back an equal spec.
4. **Local mode is unchanged.** `kampong dev|run|serve|export` keep working on `agent.yaml`. External editing (ADR-0008)
   stays supported there. It is no longer the primary editing story and is not guaranteed in hosted mode.
5. **Local and hosted must not drift.** Both modes use the same mutation layer in `@kampong/spec` and the same
   `SpecRepository` interface. A parity suite applies the same operation sequence to the filesystem repository and
   the Postgres repository and requires identical results; it runs in CI. No spec semantics, step kind or validation
   rule exists in only one mode. Spec version support follows ADR-0027 and must reach parity (ADR-0053, item 5).
6. **The internal representation is open.** This ADR does not mandate a storage change. The step-addressing ADR
   (KAM-169) must evaluate a structured document with YAML as a serialiser, against today's YAML text with patches,
   on undo, version history, diffing, LLM-generated edits and concurrent edits. Whichever it picks must satisfy
   points 1 to 5.
7. **Git sync is future work.** Syncing a hosted workspace to a git repository (the competitors charge for it) is not
   committed. It would sit on top of this decision as a paid feature.

## Consequences

- ADR-0002: the "YAML is the single lossless source of truth" wording is superseded. Its other half stands: code
  export to TypeScript is one-way, and the canvas never reads generated code.
- ADR-0008: stays for local mode; superseded as the primary workflow.
- ADR-0014 ("no second parsed copy of a spec") is still respected: one definition, one text form.
- **Comments.** Local files keep comments. If hosted storage becomes a structured document, comments in an imported
  YAML file may not survive a round trip through hosted mode. That is acceptable for the first user and must be
  documented on import.
- `AGENTS.md` conventions, the README, `PLAN.md` and the docs change from "YAML is the single source of truth" to
  this wording.
- The round-trip test (`YAML -> canvas -> mutation -> serialize -> re-parse`) stays for local mode and becomes the
  basis of the import/export check for hosted mode.
- New work: step mutation API and its ADR (KAM-169/170, rewritten), the parity suite, the import/export UI, and a
  "For developers" drawer.
