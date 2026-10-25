# ADR-0059: Canvas v2, small category-coloured cards flowing left to right

- Status: Accepted (KAM-E41)
- Date: 2026-10-25
- Deciders: Jian (product owner)

## Context

The canvas draws every step as a small plain rectangle with text near 8 px, and a tall workflow is fitted to the
view at about a quarter zoom. The first user is a non-technical person who can prompt an LLM (ADR-0053). Next to
n8n, Gumloop and Opus, ours reads as dull and hard to use. The editing mechanics are sound (inspector, palette,
run status, validation); what is missing is that a step can be recognised at a glance and that results appear
where the eye already is.

What the three tools share, from screenshots and their docs: the canvas shows an overview and one panel holds
detail; every node has a recognisable icon and a name; settings are layered with advanced ones behind a toggle;
run results sit on the nodes; there is one obvious next action.

## Decision

1. **A step is a 260x68 card**: a tinted icon tile, a small-caps kind label, the name, a one-line summary written
   from its settings, and ports. Detail stays in the inspector. Gumloop's large editable cards were rejected:
   our graphs are long pipelines (market-etl has about fifteen steps) and large cards would make them taller.
2. **Six categories, colour plus glyph**: trigger (amber), AI action (violet), tool (teal), data (blue: transform,
   validate, dedupe), flow (rose: loop, branch, stop), approval (orange). Colour is never the only signal:
   states carry an icon and a word too. Material Design 3 roles stay the base; the greens and greys do not change.
3. **Left to right.** Wide screens fit a long pipeline better, and n8n, Gumloop and Opus all do it. Edges leave
   the right port and enter the left; a step's column is how many steps lie before it, a branch's later arms drop
   to rows below, and tools sit in a row under the first step that calls them. A workflow opens on its first four
   steps at a readable zoom (at least 0.8), not the whole of it; the Fit control still fits everything. Tab order
   keeps following run order. Today `.kampong/layout.json` (ADR-0006) is only a cache of the automatic layout,
   because dragging is not saved (KAM-186), so the new layout is recomputed from the graph and stamped with a
   reserved `$layout` entry; a file without it is the old top-to-bottom layout and is replaced. If KAM-186
   decides to persist dragging, pinned positions will override the automatic ones.
4. **A loop is a group around its steps**, collapsible; a branch card shows its condition and labelled arms;
   a tool a step uses is a dashed pill linked by a dashed edge.
5. **Edges and status show the run.** Idle grey, running animated dashes (reduced motion respected), passed
   green with an item count, failed red. A status pill sits on the card's top edge; the failing reason is in the
   summary and in a bottom run log with per-item input, output and error.
6. **One inspector, docked right**, with Setup / Output / Test / Settings, and a small floating toolbar on the
   selected card. Add step is a docked panel with search and icon tiles in four groups and a chip that names
   where the step goes.
7. **Connector logos.** For now a letter in a brand-like colour (S for Slack, G for Gmail). Real logos are a
   later spike (KAM-248) because licensing is unknown.
8. **Not decided here:** dark mode (KAM-201), undo and redo (KAM-183), node dragging (KAM-186).

## Consequences

- The mockups in `docs/design/canvas-v2/` are the visual reference. They are drawn top to bottom; this ADR wins
  where they differ.
- Existing browser specs encode the old geometry and selectors; each card in the epic updates its own.
- Auto-layout for a graph with no saved positions has to be written (KAM-238).
- The summary line needs a per-kind summariser in the canvas.
