# ADR-0046: Templates, and the market-etl template as the first acceptance test

Status: accepted (KAN-1865)

## Context

SLICES.md V11 says each of the five demos ships as a template and closes its phase as an acceptance test: a
spec-only build that runs on recorded fixtures with no network, passes exporter behavioural equivalence, and has one
live smoke test behind real credentials. No templates mechanism existed. market-etl is the first, and it exercises
the work of ADRs 0040 to 0045 together: `schedule`, `foreach` with `on_error`, `kampong/alpha-vantage` with
`failure_when`, `validate`, `transform`, `kampong/supabase`, `branch`, `output_schema` and `kampong/slack`.

## Decision

- **A template is a folder under `packages/cli/templates/<name>/`** with `agent.yaml`, `README.md`, `template.json`
  (`{ "description" }`) and, when it runs offline, `fixtures/`. `kampong templates [--json]` lists the folders that
  hold an `agent.yaml`, with each folder's path. The command reads the folder next to `src/` or `dist/`, so it works
  from a checkout. It does not copy anything: the README says to copy the folder. Packaging the folder into a
  published CLI is for when the CLI is published.
- **Fixtures are committed, and say where they came from.** `e2e/fixtures/record-market-etl-fixtures.mjs` regenerates
  them by running the template with `--tools record` against an offline fake of the three services
  (`e2e/fixtures/market-etl-network.mjs`). They are synthetic responses in the real shape, not a capture, and the
  README says so.
- **The same fake serves the equivalence test.** `e2e/market-etl-template.test.ts` runs the engine against the fake
  through its fetch seam and the exported project through a `--import` preload that replaces `fetch`, then compares
  the outcome and every request (rows written, Slack text) from both. The export is installed and type-checked in a
  clean directory first.
- **Symbols, threshold and channel are `vars`,** not trigger fields: a scheduled run has no payload (ADR-0040).
- **Long strings in a spec are literal block scalars (`|-`).** The `yaml` stringifier re-folds a long double-quoted or
  `>-` scalar at 80 columns, so such a spec is not a fixed point of a canvas save. Literal blocks are never re-folded.
  Flow maps are written in block style because the stringifier rewrites `{ a: 1 }` as `{a: 1}`.

## Findings (gaps in the platform, not worked around)

1. **Replaying a `kind: rest` component op needs its credential.** `callHttpTool` resolves the `${ENV}` in the
   injected credential before the fixture layer sees the request, so `kampong run --tools replay` fails with
   "Environment variable ALPHAVANTAGE_API_KEY is not set" unless a placeholder is set. ADR-0034 and SLICES.md promise
   replay needs no credentials; module ops (Supabase) already satisfy it. The template tests set placeholders and the
   README says so.
2. **Model calls have no record/replay.** A run with a model step is offline only with a local model or an injected
   one. The tests inject a stand-in; the equivalence test uses a fake Ollama server.
3. **`toYamlString` re-folds long scalars and rewrites flow maps** (above), so hand-written specs with long
   expressions or `{ a: b }` maps are reformatted on a canvas save. The fix is `lineWidth: 0` and a flow-map option
   in the serializer; it was not made here because it changes the output of every existing spec.
4. **An exported project runs once per start.** The schedule trigger is vendored but not wired into the generated
   server (ADR-0040), so the export of a scheduled template is a job to put on cron.

## Not in this card

- The original demo's `anomalies` table insert and its separate summarizer agent.
- Copying a template (`kampong templates copy`), a template gallery on the canvas, or the other four templates.
