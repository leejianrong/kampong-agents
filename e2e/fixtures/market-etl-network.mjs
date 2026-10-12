// A fake of the three services the market-etl template calls (KAN-1865): Alpha Vantage, Supabase
// PostgREST and Slack. It answers by URL, with data shaped like the real responses, and keeps a log of
// every request so a test can see which rows were written and which messages were posted.
//
// Used three ways, all offline:
//  - e2e/market-etl-template.test.ts calls `fakeFetch` directly as the engine's fetch seam;
//  - the same test preloads `market-etl-preload.mjs` into the exported project's process;
//  - `record-market-etl-fixtures.mjs` records the template's committed fixtures from it.

export const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";

const day = (close, open = close, volume = 1000000) => ({
  "1. open": open.toFixed(4),
  "2. high": (close + 1).toFixed(4),
  "3. low": (close - 1).toFixed(4),
  "4. close": close.toFixed(4),
  "5. volume": String(volume),
});

const series = (symbol, days) => ({
  "Meta Data": {
    "1. Information": "Daily Prices (open, high, low, close) and Volumes",
    "2. Symbol": symbol,
    "3. Last Refreshed": Object.keys(days).sort().at(-1),
    "4. Output Size": "Compact",
    "5. Time Zone": "US/Eastern",
  },
  "Time Series (Daily)": days,
});

/** What the fake Alpha Vantage answers per symbol (always HTTP 200, as the real one does). */
export const ALPHA_VANTAGE = {
  // +4.0% on the latest day: above the default 1.5% threshold.
  AAPL: series("AAPL", {
    "2026-10-09": day(104),
    "2026-10-08": day(100),
    "2026-10-07": day(99.5),
  }),
  // The rate-limit gotcha: 200 OK, and a body with no prices.
  MSFT: {
    Information:
      "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.",
  },
  // +0.1%: below the default threshold, above a threshold of 0.05.
  NVDA: series("NVDA", {
    "2026-10-09": day(500.5),
    "2026-10-08": day(500),
    "2026-10-07": day(498),
  }),
  // A single day of history: the validate step refuses it.
  TINY: series("TINY", { "2026-10-09": day(10) }),
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Every request the fake saw: { service, method, url, body }. */
export const requests = [];

export async function fakeFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  if (url.hostname === "www.alphavantage.co") {
    requests.push({ service: "alpha-vantage", method, url: url.toString(), body });
    const symbol = url.searchParams.get("symbol");
    const answer = ALPHA_VANTAGE[symbol];
    return json(answer ?? { "Error Message": "Invalid API call." });
  }
  if (url.hostname.endsWith(".supabase.co")) {
    requests.push({ service: "supabase", method, url: url.toString(), body });
    return new Response(null, { status: 201 });
  }
  if (url.hostname === "slack.com") {
    requests.push({ service: "slack", method, url: url.toString(), body });
    return json({ ok: true, channel: "C0MARKET", ts: "1760000000.000100" });
  }
  throw new Error(`market-etl fake network: no route for ${method} ${url.toString()}`);
}

/** The rows written to Supabase so far, as { symbol, trade_date, close, change_pct }. */
export function writtenRows() {
  return requests
    .filter((r) => r.service === "supabase")
    .flatMap((r) => JSON.parse(r.body ?? "[]"));
}

/** The text of every Slack message posted so far. */
export function postedMessages() {
  return requests.filter((r) => r.service === "slack").map((r) => JSON.parse(r.body).text);
}
