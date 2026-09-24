import { randomUUID } from "node:crypto";
import { fetchDailySeries } from "./alpha-vantage-client.js";
import { isAnomaly, percentChange, resolveAnomalyThreshold } from "./anomaly.js";
import { upsertPriceObservation, recordAnomaly } from "./supabase-client.js";
import { summarizeAnomaly } from "./agents/summarizer.js";
import { postAnomalyAlert } from "./slack-notify.js";
import { emitEtlEvent } from "./events.js";

const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA"];

export function resolveSymbols(): string[] {
  const raw = process.env.TICKERS;
  if (!raw) return DEFAULT_SYMBOLS;
  return raw
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

/** One real ETL run: pull each symbol's real daily series, validate + load the latest observation, and autonomously alert Slack on a real anomaly -- no human approval gate (SLICES.md V5: this demo deliberately tests the fully-autonomous end of the spectrum). */
export async function runEtl(): Promise<void> {
  const runId = randomUUID();
  const symbols = resolveSymbols();
  const threshold = resolveAnomalyThreshold();
  emitEtlEvent({ type: "run_started", run: runId, symbols, at: Date.now() });

  let anomalyCount = 0;
  for (const symbol of symbols) {
    try {
      const series = await fetchDailySeries(symbol);
      const [latest, previous] = series;
      if (!latest || !previous) {
        throw new Error(`Alpha Vantage returned fewer than 2 observations for ${symbol}`);
      }

      await upsertPriceObservation(symbol, latest);
      emitEtlEvent({
        type: "symbol_pulled",
        run: runId,
        symbol,
        date: latest.date,
        close: latest.close,
        at: Date.now(),
      });

      const change = percentChange(previous.close, latest.close);
      emitEtlEvent({ type: "symbol_validated", run: runId, symbol, change, at: Date.now() });

      if (isAnomaly(change, threshold)) {
        anomalyCount += 1;
        const { summary } = await summarizeAnomaly(
          symbol,
          latest.date,
          previous.close,
          latest.close,
          change,
          threshold,
        );
        await recordAnomaly(symbol, latest.date, change, threshold);
        await postAnomalyAlert(`:rotating_light: *Real anomaly detected* — ${summary}`);
        emitEtlEvent({ type: "anomaly_flagged", run: runId, symbol, change, summary, at: Date.now() });
      }
    } catch (err) {
      emitEtlEvent({
        type: "symbol_error",
        run: runId,
        symbol,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    }
  }

  emitEtlEvent({ type: "run_completed", run: runId, anomalyCount, at: Date.now() });
}
