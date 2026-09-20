export interface DailyObservation {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class AlphaVantageError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

interface AlphaVantageDailyResponse {
  "Time Series (Daily)"?: Record<
    string,
    { "1. open": string; "2. high": string; "3. low": string; "4. close": string; "5. volume": string }
  >;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

/** Real Alpha Vantage TIME_SERIES_DAILY call. Alpha Vantage returns HTTP 200 even when rate-limited or given a bad symbol -- it signals failure via an "Error Message"/"Note"/"Information" field instead of a status code, which this hard-fails on rather than silently treating as "no data" (AGENTS.md's failure-behaviour convention). */
export async function fetchDailySeries(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyObservation[]> {
  const apiKey = requireEnv("ALPHA_VANTAGE_API_KEY");
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "TIME_SERIES_DAILY");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new AlphaVantageError(`Alpha Vantage HTTP ${response.status} for ${symbol}`);
  }

  const body = (await response.json()) as AlphaVantageDailyResponse;
  if (body["Error Message"]) throw new AlphaVantageError(`Alpha Vantage error for ${symbol}: ${body["Error Message"]}`);
  if (body.Note) throw new AlphaVantageError(`Alpha Vantage rate limit for ${symbol}: ${body.Note}`);
  if (body.Information) throw new AlphaVantageError(`Alpha Vantage rejected request for ${symbol}: ${body.Information}`);

  const series = body["Time Series (Daily)"];
  if (!series) throw new AlphaVantageError(`Alpha Vantage response for ${symbol} has no time series data`);

  return Object.entries(series)
    .map(([date, values]) => ({
      date,
      open: Number(values["1. open"]),
      high: Number(values["2. high"]),
      low: Number(values["3. low"]),
      close: Number(values["4. close"]),
      volume: Number(values["5. volume"]),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}
