<!--
title: "A rate limit that returns 200 OK"
description: A market-data ETL job with an unattended Slack alert, and what Alpha Vantage's rate limiting taught us about HTTP tools, pacing and scheduled triggers in kampong-agents.
slug: market-etl
author: Jian
date: 2026-10-02
tags: [mastra, agents, etl, alpha-vantage, supabase, slack, kampong-agents]
-->

---

# A rate limit that returns 200 OK

The fifth demo is deliberately the opposite of the incident responder. It has no human in the loop at all. A job pulls real daily prices from Alpha Vantage, validates them, stores them in Supabase, and if a ticker moves more than a threshold between two closes, a small agent writes a summary and posts it to Slack. Nobody approves anything.

We built it to ask whether kampong-agents can describe an unattended background job. That turned out to be the more interesting question than the ETL itself.

![The market-etl dashboard after a run: AAPL stepping through Pull, Validate and Anomaly, with the flagged -0.81% move summarised underneath](https://raw.githubusercontent.com/leejianrong/kampong-agents/main/mastra-projects/market-etl/docs/dashboard.png)

## The run

One run takes each ticker in turn, fetches `TIME_SERIES_DAILY`, upserts the latest observation into `price_observations`, and compares the last two closes. The anomaly check is a few lines of pure logic with a 1.5% default threshold:

```ts
export function percentChange(previousClose: number, latestClose: number): number {
  if (previousClose === 0) throw new Error("previousClose cannot be 0 (division by zero).");
  return ((latestClose - previousClose) / previousClose) * 100;
}

export function isAnomaly(change: number, threshold = resolveAnomalyThreshold()): boolean {
  return Math.abs(change) >= threshold;
}
```

Real markets are quiet most days, so to see the alert path fire I lowered the threshold to 0.1% and ran AAPL. The latest close was 330.32 against 333.02 the day before, down 0.81%, which crossed the line. The summariser wrote it up, a row landed in the `anomalies` table, and a real Slack alert went out with no approval step. I haven't yet seen it fire on a move big enough to cross the default threshold, so I can't tell you how the summariser's "numbers, not hype" instruction holds up on a dramatic day.

## A 200 that means no

Alpha Vantage doesn't use status codes for failure. A rate-limited request, a rejected one and a bad symbol all come back as HTTP 200, with a `Note`, `Information` or `Error Message` field in the body. A client that checks `response.ok` and moves on will read that as an empty result and carry on cheerfully with no data.

The client here checks the body and throws:

```ts
if (body["Error Message"]) throw new AlphaVantageError(`Alpha Vantage error for ${symbol}: ${body["Error Message"]}`);
if (body.Note) throw new AlphaVantageError(`Alpha Vantage rate limit for ${symbol}: ${body.Note}`);
if (body.Information) throw new AlphaVantageError(`Alpha Vantage rejected request for ${symbol}: ${body.Information}`);
```

That mattered on the first real run. Pulling AAPL, MSFT and NVDA one after another with no gap between requests tripped the free tier's burst limit (one request per second), and the MSFT call came back as a 200 with an `Information` message about it. The check turned it into a visible failure for that symbol, the loop carried on to NVDA, and no partial row was written for MSFT. Failing loudly on one ticker and still finishing the rest is the behaviour I want from a job nobody is watching.

Detecting the limit and avoiding it are separate problems, though. The loop has no pacing at all. Anyone running this against more than a couple of tickers on the free tier will hit the burst limit as well as the daily cap, so a real tool needs a delay or backoff as a setting.

## What it says about kampong-agents

Two gaps, and the first is a bigger one than it looks.

There's no scheduled trigger. Every trigger in the spec is a chat turn or a webhook, and `kampong dev` and `kampong run` are both interactive. Running a pipeline on a timer, with no event to key off, is a different shape, and nothing in the CLI starts a long-lived unattended loop today. Our demo has a "Run now" button and a timer variable, which is the demo author doing the scheduler's job by hand. The question for the spec is whether an unattended job belongs in v1 at all. After this and the inbox poller in the support triage demo, I think it does, and we shouldn't treat it as a boundary the way single-agent is.

The second is the HTTP tool. kampong's `http_request` checks the status code and nothing else, so an Alpha Vantage tool built from a spec would treat every rate limit as success. It needs a configurable rule for spotting failure inside a 200 body, and per-tool pacing and backoff. Neither is hard, and without them a spec can't safely call a large class of real APIs.

The approval side needs nothing. Leaving out `requires_approval` already means "no human", which is the one part of this demo the spec handled cleanly.
