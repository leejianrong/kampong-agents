# ADR-0062: Undo and redo restore snapshots of the spec text and layout

- Status: Accepted
- Date: 2026-10-30
- Deciders: Jian (product owner); written by the agent that built KAM-183

## Context

Saves write straight to the file (local) or the spec row (hosted), so Ctrl+Z did nothing once an edit was saved.
ADR-0055 already named the shape of an answer: "undo is restore a previous source", because the text is what is
stored. ADR-0054 keeps the `yaml` package's comment-preserving text as the canonical form, and ADR-0008 says an edit
made outside the canvas is picked up without a prompt. The assistant's Undo (KAM-250, ADR-0060) already restored a
file this way. KAM-186 (ADR-0061) added pinned positions, which are not in the spec text, so an undo that only
restored text would leave a dragged card where it was dropped.

## Decision

1. **A snapshot is the spec text plus the layout map.** The text is kept exactly as it was (comments and
   formatting included, never a re-serialised object), and the layout map is what the server returned with it. A
   restore writes the text through `replaceSource` and then sends the difference in pinned positions through
   `pinPositions` (set the pins the snapshot has, unpin the ones it lacks). Undoing a drag-pin or a step move
   therefore puts the cards back as well. Automatic positions are not restored: they are recomputed from the graph
   (ADR-0059).
2. **One mechanism for both modes.** `apps/canvas/src/editHistory.ts` holds the stack, and `App` records every
   write the canvas makes by wrapping the `ApiClient` (`withHistory`): `applyPatch`, `applyOps`, `replaceSource`,
   `pinPositions`, `startBlank` and `startFromTemplate`. The local client and every hosted per-spec client satisfy
   the same interface (ADR-0020), and both servers already implement `replaceSource` and `pinPositions` over the
   shared repository functions, so there is no second restore path to drift. The stack is per `ApiClient`, so
   opening another hosted spec starts a new one. A contract test runs the restore calls against the filesystem and
   Postgres repositories.
3. **The assistant's Undo is the same restore.** It calls `restoreSnapshot` too (text only, always written, guarded
   by the revision of its own apply). Its Apply goes through the wrapped client, so it is also one entry on the
   stack, and its Undo is recorded like any edit: the history stays linear.
4. **Depth cap of 100 snapshots.** The oldest falls off first. A snapshot is a few kilobytes of text; the cap is a
   memory bound, not a product limit, and one constant (`HISTORY_DEPTH`).
5. **A new edit clears redo**, as in any editor. Undo and redo themselves are not recorded as edits.
6. **Stale-snapshot safety.** Each recorded write keeps the revision the server returned (the file hash locally,
   the row version hosted). A restore sends it as `baseRevision`, so a file that has changed since is refused
   (`stale`), nothing is written, the stack is cleared and the person is told. An external edit is never
   overwritten. A layout-only restore (undoing a drag) writes no text, so it needs no such guard.
7. **External edits clear the stack with a notice.** Locally, the file watcher's `reload` and `conflict` events
   (ADR-0008) clear it, unless the text is what the canvas already has (an editor touching the file). The notice is
   a toast: "The workflow changed outside the canvas, so Undo history was cleared." Hosted has no watcher, so the
   revision check in item 6 is what catches it.
8. **Edits that did not start from a workflow are not recorded.** The first save that creates the file has no
   previous text to go back to, so history starts after it.
9. **Keyboard.** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo. The shortcut is ignored (and not
   prevented) when the event comes from an input, textarea, select, contenteditable, textbox, combobox or searchbox,
   so a text field (including the expression editor) keeps its native text undo. A Ctrl+Z pressed while a save is still in flight (a
   card dropped a moment ago) waits for it; restores run one at a time. What a restore compares against is read
   afresh from the server, not from the screen, which may not have caught up.
10. **Registry, menu and toast.** `actions.ts` gains `undo` and `redo` actions (menu surface, with their
    shortcuts), so the command palette (Ctrl+K) lists them from the same list and the menu shows them. A disabled one
    is `aria-disabled` (still focusable, so a screen reader finds it and says it is unavailable); the palette leaves
    it out. The "Saved" toast gets an Undo link while there is something to undo, and "Undone" gets a Redo link; the
    toast is a polite live region and stays 8 seconds when it has a link. Pressing Ctrl+Z with nothing to undo says
    "Nothing to undo." in the same region. The link is an M3 snackbar text button.

## Refinements after review

11. **Own echo is not an outside edit.** The file watcher can report this client's own save or restore before the
    canvas has reloaded it. A change seen while a write or restore is in flight, or within 1.5 seconds after one, is
    not taken for an external edit. An outside edit hiding in that window leaves the stack, and the revision guard
    (item 12) still refuses a restore over it.
12. **The stale guard is always present.** Both servers' load responses now carry `revision` (the file hash locally,
    the row version hosted). A load seeds it while the stack is empty, each recorded write replaces it, and a restore
    that finds none uses the one it has just read.
13. **"Before" is read from the server, and writes are serialised.** `withHistory` runs writes one at a time and reads
    the stored text and layout when each one's turn comes, so two quick edits cannot both record the state before the
    first. A pin drop that changes no pin is not an edit: nothing is recorded and redo is kept.
14. **A restore that half-succeeds says so.** If the text is back but the pins fail, the step is taken, the canvas
    reloads, and the toast says the positions could not be restored.
15. **The assistant's Undo is a history undo.** It asks the canvas to undo the last step, provided the history's
    revision is still the one Apply produced, so it neither pollutes the stack nor leaves the pins behind.
16. **Not under an open draft or a run.** Undo and Redo say "Finish or discard the open form first." (the forms the
    panel guard of KAM-182 covers) or "A run is in progress." and do nothing.
17. **Layouts and the toast.** The shortcut also matches the physical key (`event.code`), so non-Latin layouts work.
    A toast with an Undo or Redo link pauses while the pointer or focus is on the link, and a plain toast raised
    meanwhile waits behind it instead of replacing it.

## Not decided here

- Cross-session history: the stack is in memory and ends with the tab. Git covers the file (local); a hosted
  `spec_revisions` table (ADR-0055) remains the answer if hosted needs durable history.
- Per-edit collapsing: two quick saves are two entries.
- Undoing a change to the run state, secrets or components: only the spec text and the layout are history.

## Consequences

- `PUT /api/spec/source` and its hosted twin are now the undo path, so a change to their validation or revision
  rules is a change to Undo.
- `ApplyPatchResponse` types the `revision` both servers already sent.
- A restored text is validated like any import; a snapshot taken while the file was invalid cannot be restored and
  says so.
