import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { resolveModel } from "../model.js";

export const anomalySummarySchema = z.object({
  summary: z
    .string()
    .describe("A concise, factual one-paragraph Slack message describing this real price move -- numbers, not hype."),
});
export type AnomalySummary = z.infer<typeof anomalySummarySchema>;

export const summarizerAgent = new Agent({
  id: "market-summarizer",
  name: "Market Anomaly Summarizer",
  instructions: `You write short, factual Slack alerts about a real
detected price-move anomaly for a stock ticker. State the symbol, the real
percent change, the real previous and latest close prices, and the
threshold that was crossed. Do not speculate about why the price moved --
you only have price data, not news. Do not add hype or a call to action;
this is an autonomous, no-human-review alert, so it must stand on its own
as a plain factual summary.`,
  model: resolveModel(),
});

export async function summarizeAnomaly(
  symbol: string,
  date: string,
  previousClose: number,
  latestClose: number,
  change: number,
  threshold: number,
): Promise<AnomalySummary> {
  const prompt = `Symbol: ${symbol}
Date: ${date}
Previous close: ${previousClose}
Latest close: ${latestClose}
Percent change: ${change.toFixed(2)}%
Threshold crossed: ${threshold}%`;

  const result = await summarizerAgent.generate(prompt, {
    structuredOutput: { schema: anomalySummarySchema },
  });
  return result.object;
}
