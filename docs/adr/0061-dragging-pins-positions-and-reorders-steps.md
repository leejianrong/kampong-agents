# ADR-0061: Dragging a card pins its position; dropping a step on a step reorders

- Status: Accepted (KAM-186)
- Date: 2026-10-30
- Deciders: Jian (product owner)

## Context

Cards were never draggable in practice. The canvas owns its nodes (React Flow is a controlled component) and
ignored the position changes a drag reports, so a card did not move and `.kampong/layout.json` did not change
(KAM-186, observed 2026-10-19). ADR-0059 §3 left the question open: the layout is recomputed from the graph on
every load and stamped with a reserved `$layout` entry, "if KAM-186 decides to persist dragging, pinned positions
will override the automatic ones". The owner decided to persist drags.

Two things a person might mean by dragging a card, and they must not be confused:

- arranging: put this card there;
- changing what the workflow does: run this step earlier or later. The run order is the order of the YAML list
  (ADR-0055), and the step-move operation (`step.move`, KAM-170) is the only thing that changes it.

## Decision

1. **A drop on empty canvas is a free move, and it is pinned.** The position is saved in the layout store under
   the node's id (`workflow:<step>`, `tool:<name>`, `agent:<id>`, `guardrails:<id>`, ADR-0006) as
   `{ "x": 640, "y": 222, "pinned": true }`. The spec text is never touched. A free move changes no behaviour.
2. **A drop on another step of the same list is a reorder.** "Same list" means the same parent and arm: the
   top-level workflow, one foreach body, or one branch arm. The dragged step takes the place of the one it was
   dropped on (`step.move` with that step's index, which is the final index), so dropping on a later step moves
   it down and on an earlier one moves it up. It goes through the same operation, the same validation and the
   same refusal as the Move buttons (KAM-174): a move that would put a step before one it reads is refused in
   words and nothing is written. The decision is made from where the dragged card's centre lies when it is
   dropped (overlap with another card), so no modifier key or hidden target is needed; two cards overlapping is
   never a layout anyone wants, so the gesture is free.
3. **Any other drop on a card snaps back and saves nothing.** A step onto a step in another list (which would be
   a move between scopes), a tool onto a step, and a drag shorter than 3 px (a click that wobbled).
4. **How a pin coexists with `$layout` and the automatic layout.** The stored file keeps the `$layout` stamp and
   one entry per node. An entry is a pin only if it carries `"pinned": true`; every other entry is a cache of the
   automatic layout (ADR-0059 §3). On every load the automatic layout is recomputed, then each pinned entry of a
   node that still exists overrides that node's position (`layoutWithPins`). So:
   - a file with no pins lays out exactly as before, and a hand-added step still gets an automatic place;
   - the automatic layout of the other cards is not changed by a pin (nothing reflows around a pinned card);
   - a file without the current `$layout` stamp is the old top-to-bottom layout and is replaced; it can hold no
     pins, because the flag did not exist;
   - a pin whose node is gone (deleted step) is dropped at the next load; a rename moves the pin with the node
     (the existing layout move);
   - deleting `.kampong/layout.json` is still safe: it loses the arrangement, not behaviour (ADR-0006).
5. **A reorder that changes a step's place releases its pin.** After a `step.move` that changes the step's list or index (a no-op move keeps the pin), the step goes to its automatic place for its
   new position in the run order (the `unpin` layout move). Other pins are left where they are, and the old
   "swap vertical slots" reorder move is skipped when any step in the column is pinned.
6. **Card layout and loops.** Pinned positions are in the stored layout's coordinates. A collapsed loop closes up
   the room it gave back by shifting what is drawn (ADR-0059 §4), and a drop's travel is applied to the stored
   position, so a collapsed loop does not corrupt what is saved. A loop's outline follows its members, pinned or
   not. Loop outlines, collapsed-loop cards and the insertion marker are not draggable.
7. **One write path, two modes.** `pinNodePositions(repo, positions)` in `@kampong/spec` is the only code that
   writes a pin. `kampong dev` exposes it as `PUT /api/layout` (over `.kampong/layout.json`) and the hosted server
   as `PUT /api/specs/:id/layout` (over the `layouts` row, workspace-scoped, ADR-0019). Both take
   `{ positions: { "<node id>": { x, y } | null } }`, where `null` unpins; unknown ids, the reserved `$layout`
   key and non-finite numbers are ignored; a spec that does not parse refuses (422). Both answer with the layout a
   reload would give. The shared repository contract (filesystem and Postgres) tests it, so the two modes cannot
   drift. The layout is a JSON map in both places, so no migration is needed.
8. **The React Flow lock control is removed.** It toggled dragging, selection and connecting at once and nothing
   else in the canvas used it. Dragging is always on when the canvas is editable and off in the assistant's
   plan preview.

9. **Pins are validated.** A pinned entry whose x or y is not finite or has an absolute value above 100000 is
   ignored when read (the node gets its automatic place, so a hand-edited `1e308` cannot break the canvas) and
   rejected when written through `pinNodePositions` (that node is skipped, not clamped).
10. **The plan preview keeps pins.** `planPreview` takes the stored layout and lays out with `layoutWithPins`, so
    pinned cards do not jump while a plan is shown.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Disable dragging (the other branch of the card) | Throws away the one way a person can arrange a large workflow, which ADR-0006 already promised. |
| Treat every horizontal drag past a neighbour as a reorder | A free move and a reorder would depend on distance travelled, and the order would change by accident. Overlap with a card is explicit. |
| Reorder only with a modifier key or a handle | Not discoverable for the first user (ADR-0053), and the Move buttons already cover the keyboard. |
| Keep pins in a separate `$pinned` map | A second structure to keep in step on rename, delete and reorder; a flag on the entry moves with the entry. |
| Pin every node on the first drag | Freezes the automatic layout after one drag, so adding a step later would no longer flow. |

## Consequences

- Dragging a card selects it (opens the inspector), as clicking does.
- A reorder is a spec change (one `step.move` save, one entry in the file's history); a free move is not.
- There is still no "reset layout" control; unpinning exists in the API (`null`) and a reorder does it for one
  step. A control can be added later without changing the store. Auto-layout algorithms are out of scope.
- ADR-0059 §3's note that dragging is not saved is superseded by this ADR; its "Not decided here" item for
  node dragging is decided here.
- Follow-up: `pinNodePositions` reads the layout, changes it and writes it back, like the existing layout writers
  (rename and delete moves). Two simultaneous writers to the same spec could lose one update; a layout-only save
  is cheap to redo, so this is accepted for now. Other open tabs are not told about a layout change either.
