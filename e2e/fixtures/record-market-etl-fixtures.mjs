// Regenerates packages/cli/templates/market-etl/fixtures from the fake network (KAN-1865). The fixtures are
// what `kampong run --tools record` writes, taken against synthetic responses shaped like the real ones,
// not captured from a live account. To record from the real services instead, run the template with
// `--tools record` and real keys (see the template's README).
//
//   npm run build && node e2e/fixtures/record-market-etl-fixtures.mjs
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelFixtures } from "../../packages/engine/dist/index.js";
import { runCli } from "../../packages/cli/dist/cli.js";
import { fakeFetch } from "./market-etl-network.mjs";
import { fakeModel } from "./market-etl-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "../../packages/cli/templates/market-etl");
const fixtures = join(template, "fixtures");

globalThis.fetch = fakeFetch;
const env = {
  ALPHAVANTAGE_API_KEY: "fake-alpha-vantage-key",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_KEY: "fake-supabase-key",
  SLACK_BOT_TOKEN: "xoxb-fake-slack-token",
};
Object.assign(process.env, env);

rmSync(fixtures, { recursive: true, force: true });
const io = {
  stdout: (line) => process.env.DEBUG_RECORD && console.error(line),
  stderr: console.error,
  stdin: process.stdin,
};
// The default threshold (1.5) alerts on AAPL only; 0.05 also alerts on NVDA, which records its Slack call.
// TINY has one day of history and records a fetch whose validate step fails.
for (const args of [
  ["--var", "symbols=AAPL,MSFT,NVDA,TINY"],
  ["--var", "symbols=NVDA", "--var", "threshold=0.05"],
]) {
  const code = await runCli(
    [
      "run",
      join(template, "agent.yaml"),
      "--input",
      "",
      "--json",
      "--tools",
      "record",
      "--fixtures",
      fixtures,
      ...args,
    ],
    io,
    {
      // The stand-in's answers are filed as model fixtures (KAM-156), so a replay needs no model at all.
      model: createModelFixtures({ mode: "record", fixturesDir: fixtures, inner: fakeModel }),
    },
  );
  if (code !== 0) throw new Error(`recording run failed with exit code ${code}`);
}
console.error(`recorded into ${fixtures}`);
