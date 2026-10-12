// `node --import` preload for the exported market-etl project (KAN-1865): replaces the global fetch with
// the fake network and, at exit, prints the requests it saw to the file named by MARKET_ETL_REQUEST_LOG,
// so the e2e test can compare what the exported project did with what the engine did.
import { writeFileSync } from "node:fs";
import { fakeFetch, requests } from "./market-etl-network.mjs";

// The model is a local fake Ollama server; only the three remote services are faked here.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  new URL(typeof input === "string" ? input : (input.url ?? input.toString())).hostname ===
  "127.0.0.1"
    ? realFetch(input, init)
    : fakeFetch(input, init);
process.on("exit", () => {
  const path = process.env.MARKET_ETL_REQUEST_LOG;
  // NODE_OPTIONS reaches npm and every process it starts; only the one that made requests writes the log.
  if (path && requests.length > 0) writeFileSync(path, JSON.stringify(requests));
});
