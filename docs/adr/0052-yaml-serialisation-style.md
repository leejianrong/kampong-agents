# ADR-0052: YAML serialisation keeps the author's style

Status: accepted (KAM-157)

## Context

ADR-0007 chose the `yaml` package so a save round-trips a spec byte for byte, comments and formatting included.
The package's defaults broke that for the 1.1 syntax: it refolded a long double-quoted or plain scalar at 80
columns (a JSONata `when` or `items` expression is exactly that), and it has one flow-padding setting for maps and
lists together, so `{ a: 1 }` became `{a: 1}`. A hand-authored spec was reformatted on the first canvas save.
`market-etl` worked around it with literal blocks and block maps.

## Decision

- **`lineWidth: 0`** in `toYamlString`: no scalar is refolded.
- **Flow spacing is read from the document, not chosen.** `parseSpec` looks at the character after every flow
  `{` and `[` and records, separately for maps and for lists, whether the majority is padded. Saving writes that
  style back through wrapped map and seq tags (the package keeps one setting, and a nested collection inherits
  its parent's, so each kind sets its own). Prettier's `{ a: 1 }` with `[a, b]` and fully tight `{a: 1}` both
  survive; a document made in memory is written tight, as before; a document mixing styles is normalised to its
  majority on save.
- **A folded `>-` block is the one thing not preserved.** Its value has no record of where the author broke the
  lines, so a hand-wrapped one is saved with each paragraph on one line. The value is identical and a second
  save changes nothing. Keeping the line breaks would mean re-reading the source token for every block scalar; a
  literal `|` block already keeps them, so the docs say to use that where breaks matter.

## Consequences

- A canvas save no longer reflows long expressions or flow collections. Existing byte-for-byte fixtures needed
  no change.
- `toYamlString` clones the document when a style has padding, so the canvas's own document is untouched.
