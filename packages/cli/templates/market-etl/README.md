# market-etl

A scheduled price pipeline written as a spec only: no code, no custom components. It pulls the
latest daily series for each symbol from Alpha Vantage, checks it, computes the day-over-day percent
change, upserts one row per symbol into Supabase, and when the move reaches a threshold asks a model
for a one-sentence summary and posts it to Slack. It mirrors `mastra-projects/market-etl`.

```
schedule (every 6h)
  -> foreach symbol            on_error: continue, failures land in each_symbol.errors
       fetch      kampong/alpha-vantage time_series_daily   (a 200-OK rate limit is a failure)
       check      validate    at least 2 daily observations
       shape      transform   latest and previous date and close
       sane       validate    both closes are positive
       delta      transform   change_pct
       row        transform   the record to store
       write      kampong/supabase upsert on (symbol, trade_date)
       anomaly    branch      abs(change_pct) >= vars.threshold
         then:    summarize   model call, output_schema { summary, direction }
                  alert       kampong/slack post_message
  -> report      transform   loaded and failed counts
```

A symbol that fails stops at the failing step. The write comes after every check, so a rate-limited or
malformed symbol leaves no partial row, and the others are still written.

## Try it offline

Everything below runs with no network. Copy the folder (or run it in place) and use the recorded
fixtures in `fixtures/`:

```
kampong templates                                   # lists this template and where it lives
kampong doctor agent.yaml --tools replay --fixtures fixtures
kampong run agent.yaml --input "" --tools replay --fixtures fixtures \
  --var symbols=AAPL,MSFT,NVDA --json
```

In the recorded data AAPL moves +4% (above the default 1.5% threshold, so it is summarised and posted),
NVDA moves +0.1% (written, no alert), and MSFT is answered with Alpha Vantage's daily-quota message
under HTTP 200 (the gotcha this template exists to cover: the call is reported as failed, MSFT ends up
in `each_symbol.errors`, and nothing is written for it). A fourth recorded symbol, `TINY`, has a single
day of history and fails the `check` step. Lower or raise the threshold with `--var threshold=0.05`
(NVDA alerts too) or `--var threshold=50` (nothing does).

The `summarize` model call replays from a recorded answer too (`@model.*.json`), so no model, key or Ollama
is needed. A model fixture is keyed on the whole prompt, so a symbol or threshold that makes a different
prompt has no answer: it ends up in `each_symbol.errors` at `summarize` with a "No recorded model fixture"
message (a visible failure, never a call to a live model) while its row is still written. Record more with
`--tools record`, or use `--model live` to send the call to the spec's `agent.model` (Ollama by default).

The fixtures were generated from synthetic responses shaped like the real ones, and the model answers from a
scripted stand-in, by `e2e/fixtures/record-market-etl-fixtures.mjs`, not captured from a live account or model.
To record your own, run live once with `--tools record` and your keys.

## Run it live

| Variable               | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `ALPHAVANTAGE_API_KEY` | Free key from alphavantage.co. The free tier is 25 requests a day.      |
| `SUPABASE_URL`         | `https://<ref>.supabase.co`                                             |
| `SUPABASE_KEY`         | A key that can write the table (secret key, or a policy that allows it) |
| `SLACK_BOT_TOKEN`      | A bot token with `chat:write`, invited to the channel                   |
| the model's own key    | Only if you change `agent.model` from the local Ollama default          |

Create the table once:

```sql
create table price_observations (
  symbol      text    not null,
  trade_date  date    not null,
  close       numeric not null,
  change_pct  numeric not null,
  primary key (symbol, trade_date)
);
```

Tune a run with vars, with no edit to the spec: `symbols`, `threshold` (percent, default 1.5) and
`slack_channel` (default `#market-alerts`). `kampong serve agent.yaml` runs the schedule; `POST
/schedule/run-now` starts a run immediately.

`kampong doctor agent.yaml --probe` checks that each credential is accepted without running the pipeline.

## Live smoke test

`packages/cli/test/integration/market-etl-live.test.ts` runs the template against the real services for
one symbol (IBM) with a threshold of 0, so the Slack leg always runs. It is skipped unless all of these
are set, so CI never makes a live call:

```
ALPHAVANTAGE_API_KEY SUPABASE_URL SUPABASE_KEY SLACK_BOT_TOKEN KAMPONG_LIVE_SLACK_CHANNEL
npx vitest run --project integration packages/cli/test/integration/market-etl-live.test.ts
```

It spends one Alpha Vantage request, upserts one `price_observations` row for IBM and posts one Slack
message to `KAMPONG_LIVE_SLACK_CHANNEL`. The summary comes from a stand-in model, so no model key is needed.

## Export

`kampong export agent.yaml ./market-etl-app` produces a standalone project. `e2e/market-etl-template.test.ts`
installs and runs it in a clean directory and checks that its output and every request it makes match the
engine's. A generated project runs the pipeline once per `npm start`; it does not wire the `schedule`
trigger into its server (ADR-0040), so schedule it with cron or run `kampong serve` instead.

## What it leaves out of the original demo

The original also inserts each flagged move into an `anomalies` table, and its summarizer is a separate
agent. Here the summary is one `output_schema` step and the Slack post is the only record of an alert.
