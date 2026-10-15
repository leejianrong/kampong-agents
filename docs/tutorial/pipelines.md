# Scheduled data pipelines

Most of the tutorial so far is about an agent that answers a question. This page is about the other
kind of workflow: one that wakes on a clock, loops over a list, checks and reshapes data, writes it
somewhere, and only calls a model when something is worth saying. It needs no code, only a spec.

The worked example is the `market-etl` template. Every step type below is documented in the
[AgentSpec reference](../reference/agentspec.md).

## The shape

```
schedule (every 6h)
  -> foreach symbol            on_error: continue
       fetch      kampong/alpha-vantage     a 200-OK rate limit counts as a failure
       check      validate                  at least 2 daily observations
       shape      transform                 latest and previous close
       delta      transform                 change_pct
       write      kampong/supabase upsert   one row per (symbol, date)
       anomaly    branch                    abs(change_pct) >= vars.threshold
         then:    summarize (model, output_schema) -> kampong/slack post_message
  -> report      transform                  loaded and failed counts
```

A symbol that fails stops at the failing step, and the write comes after every check, so a
rate-limited or malformed symbol leaves no partial row. The other symbols are still written.

## Try it with no network

`market-etl` ships with recorded fixtures, so it runs with no network and no keys. Model calls replay from recorded answers
too, so the `summarize` step needs no Ollama either.

```sh
kampong templates                       # lists the template and the folder it lives in
cd packages/cli/templates/market-etl    # or copy the folder anywhere and cd into it
kampong doctor agent.yaml --tools replay --fixtures fixtures
kampong run agent.yaml --input "" --tools replay --fixtures fixtures \
  --var symbols=AAPL,MSFT,NVDA --json
```

In the recorded data AAPL moves enough to be summarised and posted (add `--var threshold=50` to skip the model),
NVDA moves little (written, no alert),
and MSFT is answered with Alpha Vantage's daily-quota message, which lands in the loop's `errors`. The fixtures
are synthetic responses in the real shape, not a capture of the live services.

## The pieces

**A clock.** `trigger: { type: schedule, every: 6h }` (or `cron` with a `tz`). `kampong serve` drives it: one run
at a time, an overlap lock so a slow run is not doubled up, jitter and backoff, and a visible failure limit. A
scheduled run has no payload, so the symbols, threshold and channel are `vars` you can change without editing the
steps.

**A loop that survives bad items.** `foreach` with `on_error: continue` records a failing item in
`each_symbol.errors` and moves on. The step's output is `{ results, errors, skipped, count }`, so a final
`transform` can report how many loaded and how many failed.

**Plain data steps instead of model calls.** `transform` computes with JSONata, `validate` refuses a malformed
record (fail the item, or skip it quietly), and `dedupe` remembers a key for a time window so the same alert is
not handled twice. None of them call a model, so they are fast, free and deterministic.

**A branch.** `branch` with `if` or `switch` runs one list of steps or another, and `stop` ends a run early with a
reason. The model is only called on the arm where there is something to say, and its `output_schema` makes the
answer a validated object rather than prose to parse.

**Components, not hand-written HTTP.** `kampong/alpha-vantage`, `kampong/supabase`, `kampong/slack`,
`kampong/gmail` and `kampong/github` are first-party connectors with declared operations and credentials. They
read secrets from environment variables, and a rate limit reported with HTTP 200 is turned into a real failure.

## Going live

```sh
kampong serve agent.yaml          # starts the schedule; POST /schedule/run-now starts a run immediately
```

Pending approvals are stored on disk and survive a restart. Set the connector tokens and model key in the
environment of that process. `kampong export` ejects a schedule spec too: in the exported project,
`npm run serve` (or the Docker image) runs the same schedule, and `npm start` is a single run.
