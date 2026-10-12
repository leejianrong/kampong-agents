import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";
// @ts-expect-error a plain .mjs shared with the e2e layer; it has no type declarations
import { fakeModel } from "../../../../e2e/fixtures/market-etl-model.mjs";

// KAN-1865: the market-etl template's one live smoke test. It is skipped unless every credential it needs
// is in the environment, so CI and a plain `npm test` never touch the network (as the DB suites are
// skipped without a database). It makes REAL calls: one Alpha Vantage request for IBM, an upsert of one
// row into the `price_observations` table of the Supabase project, and one Slack message. See the
// template's README for the table and the variables.

const REQUIRED = [
  "ALPHAVANTAGE_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "SLACK_BOT_TOKEN",
  "KAMPONG_LIVE_SLACK_CHANNEL",
] as const;
const live = REQUIRED.every((name) => (process.env[name] ?? "") !== "");

const SPEC_PATH = fileURLToPath(new URL("../../templates/market-etl/agent.yaml", import.meta.url));

describe.skipIf(!live)("market-etl template, live smoke test", () => {
  it("pulls IBM from Alpha Vantage, upserts the row to Supabase and posts to Slack", async () => {
    const { io, out, err } = capture();
    // A threshold of zero makes any move an anomaly, so the Slack leg runs whatever the market did. The
    // summary comes from a stand-in model: only the three services are live.
    const code = await runCli(
      [
        "run",
        SPEC_PATH,
        "--input",
        "",
        "--json",
        "--var",
        "symbols=IBM",
        "--var",
        "threshold=0",
        "--var",
        `slack_channel=${process.env.KAMPONG_LIVE_SLACK_CHANNEL}`,
      ],
      io,
      { model: fakeModel },
    );
    expect(code, err.join("\n")).toBe(EXIT_SUCCESS);
    const outcome = JSON.parse(out[0]!) as {
      output: {
        each_symbol: { errors: unknown[]; results: { alert?: { ok: boolean } }[] };
        report: { loaded: number; failed: number };
      };
    };
    expect(outcome.output.each_symbol.errors).toEqual([]);
    expect(outcome.output.report).toEqual({ loaded: 1, failed: 0 });
    expect(outcome.output.each_symbol.results[0]!.alert).toMatchObject({ ok: true });
  }, 120_000);
});
