import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@kampong/spec";
import { createFirstPartyRegistry } from "../../src/component-registry.js";
import { invokeOp } from "../../src/component.js";
import { callHttpTool } from "../../src/http-tool.js";
import { createFixtureFetch } from "../../src/tool-fixtures.js";

// KAM-155: replaying a recorded call must not need the credential it was recorded with (ADR-0034).
// Record with the credentials set, then replay with an empty environment.

const LIVE_ENV = { AV_KEY: "av-live-secret", SLACK_TOKEN: "xoxb-live-secret" };
const NO_ENV = {};

const HTTP_TOOL: Tool = {
  name: "fetch",
  action: "http_request",
  method: "GET",
  url: "https://api.example.test/q",
  query: { apikey: "${AV_KEY}" },
  headers: { Authorization: "Bearer ${AV_KEY}" },
};
const SLACK_TOOL: Tool = {
  name: "notify",
  action: "slack_post_message",
  token: "${SLACK_TOKEN}",
  channel: "#c",
  text: "hi",
};

describe("replay does not read credentials", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-replay-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const server = async () => new Response(JSON.stringify({ ok: true, v: 1 }), { status: 200 });

  async function recordThenReplay(tool: Tool) {
    const record = createFixtureFetch({ mode: "record", fixturesDir: dir, fetchImpl: server });
    const recorded = await callHttpTool(tool, {}, { fetchImpl: record, env: LIVE_ENV });
    const replay = createFixtureFetch({
      mode: "replay",
      fixturesDir: dir,
      fetchImpl: async () => {
        throw new Error("replay must not reach the network");
      },
    });
    const replayed = await callHttpTool(tool, {}, { fetchImpl: replay, env: NO_ENV });
    return { recorded, replayed };
  }

  it("replays a generic http_request tool whose url and headers read ${ENV}", async () => {
    const { recorded, replayed } = await recordThenReplay(HTTP_TOOL);
    expect(replayed).toEqual(recorded);
  });

  it("replays a legacy connector tool (slack) with no token set", async () => {
    const { recorded, replayed } = await recordThenReplay(SLACK_TOOL);
    expect(replayed).toEqual(recorded);
  });

  it("replays a rest component op (kampong/alpha-vantage) with no key set", async () => {
    const registry = createFirstPartyRegistry();
    const { manifest } = await registry.resolve("kampong/alpha-vantage", "1.0.0");
    const run = (mode: "record" | "replay", env: NodeJS.ProcessEnv) =>
      invokeOp(
        manifest,
        "time_series_daily",
        { symbol: "IBM" },
        {
          env,
          secretEnv: { key: "${ALPHAVANTAGE_API_KEY}" },
          pacer: { wait: async () => {} },
          fetchImpl: createFixtureFetch({
            mode,
            fixturesDir: dir,
            fetchImpl: async () =>
              new Response(
                JSON.stringify({ "Time Series (Daily)": { "2026-10-01": { "4. close": "1" } } }),
              ),
          }),
        },
      );
    const recorded = await run("record", { ALPHAVANTAGE_API_KEY: "av-live-secret" });
    expect(await run("replay", NO_ENV)).toEqual(recorded);
  });

  it("still reports a missing fixture, and still demands the credential when live", async () => {
    const replay = createFixtureFetch({ mode: "replay", fixturesDir: dir });
    await expect(callHttpTool(HTTP_TOOL, {}, { fetchImpl: replay, env: NO_ENV })).rejects.toThrow(
      /fixture/i,
    );
    await expect(callHttpTool(HTTP_TOOL, {}, { env: NO_ENV })).rejects.toThrow(/AV_KEY is not set/);
  });
});
