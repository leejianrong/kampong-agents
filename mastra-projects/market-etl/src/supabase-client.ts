import { createClient } from "@supabase/supabase-js";
import type { DailyObservation } from "./alpha-vantage-client.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

// Secret API key, never exposed to a browser -- this process is the only
// consumer. RLS is enabled with no policies on both tables (see the
// migration this demo applied), so only a secret (or legacy service_role)
// key can read/write them.
export function getSupabaseClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false },
  });
}

export async function upsertPriceObservation(symbol: string, observation: DailyObservation): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("price_observations").upsert(
    {
      symbol,
      observed_at: observation.date,
      open: observation.open,
      high: observation.high,
      low: observation.low,
      close: observation.close,
      volume: observation.volume,
    },
    { onConflict: "symbol,observed_at" },
  );
  if (error) throw new Error(`Upserting ${symbol} ${observation.date} failed: ${error.message}`);
}

export async function recordAnomaly(
  symbol: string,
  observedAt: string,
  percentChange: number,
  threshold: number,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("anomalies")
    .insert({ symbol, observed_at: observedAt, percent_change: percentChange, threshold });
  if (error) throw new Error(`Recording anomaly for ${symbol} ${observedAt} failed: ${error.message}`);
}
