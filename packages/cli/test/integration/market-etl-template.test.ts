import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec, specWarnings } from "@kampong/spec";
import { EXIT_SUCCESS, EXIT_USAGE_ERROR, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";
// @ts-expect-error a plain .mjs shared with the e2e layer; it has no type declarations
import { fakeModel } from "../../../../e2e/fixtures/market-etl-model.mjs";

// KAN-1865: the market-etl template, spec-only, runs offline on its recorded fixtures. Nothing here touches
// the network: the global fetch is replaced by one that fails the test, and tool calls replay from
// templates/market-etl/fixtures.

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/market-etl/", import.meta.url));
const SPEC_PATH = `${TEMPLATE_DIR}agent.yaml`;
const FIXTURES = `${TEMPLATE_DIR}fixtures`;

interface Outcome {
  success: boolean;
  status: string;
  output: {
    each_symbol: {
      results: {
        row: { record: { symbol: string; trade_date: string; close: number; change_pct: number } };
        anomaly: { taken: string };
        summarize?: { summary: string; direction: string };
        alert?: { ok: boolean };
      }[];
      errors: { item: string; step: string; message: string }[];
      count: number;
    };
    report: { loaded: number; failed: number };
  };
}

describe("the market-etl template", () => {
  beforeEach(() => {
    // Replaying a rest component op still reads its credential before it looks for the fixture (a gap,
    // follow-up card), so a placeholder value is needed. It is never sent anywhere.
    vi.stubEnv("ALPHAVANTAGE_API_KEY", "placeholder");
    vi.stubEnv("SLACK_BOT_TOKEN", "placeholder");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the offline template test reached the network");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const run = async (...vars: string[]) => {
    const calls: string[] = [];
    const model = {
      ...fakeModel,
      async generateStructured(request: { prompt: string }) {
        calls.push(request.prompt);
        return fakeModel.generateStructured(request);
      },
    };
    const { io, out, err } = capture();
    const code = await runCli(
      [
        "run",
        SPEC_PATH,
        "--input",
        "",
        "--json",
        "--tools",
        "replay",
        "--fixtures",
        FIXTURES,
        ...vars.flatMap((v) => ["--var", v]),
      ],
      io,
      { model },
    );
    return {
      code,
      outcome: JSON.parse(out[0] ?? "{}") as Outcome,
      stderr: err.join("\n"),
      modelCalls: calls,
    };
  };

  it("is a valid version 1.1 spec with a schedule trigger and no warnings", () => {
    const { success, spec, errors } = parseSpec(readFileSync(SPEC_PATH, "utf8"));
    expect(errors).toEqual([]);
    expect(success).toBe(true);
    expect(spec?.version).toBe("1.1");
    expect(spec?.agent.trigger).toMatchObject({ type: "schedule" });
    expect(specWarnings(spec!)).toEqual([]);
  });

  it("loads the other symbols, puts the rate-limited one in errors[] and writes no partial row", async () => {
    const { code, outcome, stderr } = await run("symbols=AAPL,MSFT,NVDA");
    expect(code, stderr).toBe(EXIT_SUCCESS);
    expect(outcome.status).toBe("completed");
    const loop = outcome.output.each_symbol;
    expect(loop.count).toBe(3);
    expect(loop.results.map((r) => r.row.record.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(loop.results.map((r) => r.row.record)).toEqual([
      { symbol: "AAPL", trade_date: "2026-10-09", close: 104, change_pct: 4 },
      { symbol: "NVDA", trade_date: "2026-10-09", close: 500.5, change_pct: 0.1 },
    ]);
    // The 200-OK rate limit is a failure of the fetch, so nothing after it ran for MSFT: it has no row and
    // no write step (a write with no recorded fixture would have failed at "write" instead).
    expect(loop.errors).toHaveLength(1);
    expect(loop.errors[0]).toMatchObject({ item: "MSFT", step: "fetch" });
    expect(loop.errors[0]!.message).toContain("rate limit");
    expect(outcome.output.report).toEqual({ loaded: 2, failed: 1 });
  });

  it("a symbol with too little history fails its validate step and writes nothing", async () => {
    const { outcome } = await run("symbols=TINY,NVDA");
    const loop = outcome.output.each_symbol;
    expect(loop.errors).toEqual([
      expect.objectContaining({
        item: "TINY",
        step: "check",
        message: "TINY: fewer than 2 daily observations",
      }),
    ]);
    expect(loop.results.map((r) => r.row.record.symbol)).toEqual(["NVDA"]);
  });

  it("the threshold branch fires only for the symbol that moved past it", async () => {
    const { outcome, modelCalls } = await run("symbols=AAPL,NVDA");
    const [aapl, nvda] = outcome.output.each_symbol.results;
    expect(aapl!.anomaly.taken).toBe("then");
    expect(aapl!.summarize).toEqual({ summary: "AAPL moved 4% on the day.", direction: "up" });
    expect(aapl!.alert).toMatchObject({ ok: true });
    expect(nvda!.anomaly.taken).toBe("none");
    expect(nvda!.summarize).toBeUndefined();
    expect(nvda!.alert).toBeUndefined();
    expect(modelCalls).toHaveLength(1);
  });

  it("a lower threshold fires it for both, a higher one for neither", async () => {
    const low = await run("symbols=NVDA", "threshold=0.05");
    expect(low.outcome.output.each_symbol.results[0]!.anomaly.taken).toBe("then");
    expect(low.outcome.output.each_symbol.results[0]!.alert).toMatchObject({ ok: true });

    const high = await run("symbols=AAPL,NVDA", "threshold=50");
    expect(high.outcome.output.each_symbol.results.map((r) => r.anomaly.taken)).toEqual([
      "none",
      "none",
    ]);
    expect(high.modelCalls).toHaveLength(0);
  });

  it("kampong doctor passes offline against the fixtures, without calling out", async () => {
    const { io, out, err } = capture();
    const code = await runCli(
      ["doctor", SPEC_PATH, "--tools", "replay", "--fixtures", FIXTURES],
      io,
      {
        env: {
          ALPHAVANTAGE_API_KEY: "k1",
          SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
          SUPABASE_KEY: "k2",
          SLACK_BOT_TOKEN: "k3",
        },
      },
    );
    expect(code, out.join("\n") + err.join("\n")).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("tool fetch_daily has a recorded fixture");
    expect(out.join("\n")).toContain("tool upsert_price has a recorded fixture");
    expect(out.join("\n")).toContain("tool post_alert has a recorded fixture");
  });

  it("is listed by kampong templates", async () => {
    const { io, out } = capture();
    expect(await runCli(["templates"], io)).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toMatch(/market-etl\s+.*Alpha Vantage/);
  });

  it("kampong templates --json lists name, description and path, and rejects unknown options", async () => {
    const json = capture();
    expect(await runCli(["templates", "--json"], json.io)).toBe(EXIT_SUCCESS);
    const list = JSON.parse(json.out.join("\n")) as {
      name: string;
      description: string;
      path: string;
    }[];
    expect(list.find((t) => t.name === "market-etl")).toMatchObject({
      description: expect.stringContaining("Alpha Vantage"),
      path: expect.stringContaining("market-etl"),
    });
    expect(
      readFileSync(`${list.find((t) => t.name === "market-etl")!.path}/agent.yaml`, "utf8"),
    ).toBe(readFileSync(SPEC_PATH, "utf8"));

    const bad = capture();
    expect(await runCli(["templates", "--nope"], bad.io)).toBe(EXIT_USAGE_ERROR);
  });
});
