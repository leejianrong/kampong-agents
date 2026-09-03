import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHttpTool, TOOL_NAME_HEADER } from "../../src/http-tool.js";
import { createFixtureFetch, MissingFixtureError } from "../../src/tool-fixtures.js";
import type { Tool } from "@kampong/spec";

// SLICES.md V3 unit-level coverage for the mock/record tool layer
// (KAN-1111, PLAN.md Shape S4).

const TOOL: Tool = {
  name: "check_stripe_charge",
  action: "http_request",
  method: "GET",
  url: "https://api.stripe.test/v1/charges/{charge_id}",
  extract: "data.status",
};

describe("createFixtureFetch", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-fixtures-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("'live' mode passes every call straight through, untouched", async () => {
    const inner = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const wrapped = createFixtureFetch({ mode: "live", fixturesDir: dir, fetchImpl: inner });

    await wrapped("https://example.test/x", { method: "GET" });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("'record' mode calls through and persists a fixture keyed on tool name + method + substituted URL", async () => {
    const inner = vi.fn(
      async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const recordFetch = createFixtureFetch({ mode: "record", fixturesDir: dir, fetchImpl: inner });

    const result = await callHttpTool(TOOL, { charge_id: "ch_123" }, { fetchImpl: recordFetch });

    expect(result).toBe("succeeded");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("'replay' mode never calls the network and returns the recorded body deterministically", async () => {
    const inner = vi.fn(
      async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const recordFetch = createFixtureFetch({ mode: "record", fixturesDir: dir, fetchImpl: inner });
    await callHttpTool(TOOL, { charge_id: "ch_123" }, { fetchImpl: recordFetch });

    const replayFetch = createFixtureFetch({ mode: "replay", fixturesDir: dir });
    const result1 = await callHttpTool(TOOL, { charge_id: "ch_123" }, { fetchImpl: replayFetch });
    const result2 = await callHttpTool(TOOL, { charge_id: "ch_123" }, { fetchImpl: replayFetch });

    expect(result1).toBe("succeeded");
    expect(result2).toBe("succeeded");
    // Only the one real call from the earlier "record" step -- never the network in replay.
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("'replay' mode throws a specific MissingFixtureError -- never a silent passthrough to a live call -- on a cache miss", async () => {
    const inner = vi.fn(async () => new Response("should never be called", { status: 200 }));
    const replayFetch = createFixtureFetch({
      mode: "replay",
      fixturesDir: dir,
      fetchImpl: inner as unknown as typeof fetch,
    });

    // Directly against the wrapped fetch: proves the *specific* error type.
    await expect(
      replayFetch("https://api.stripe.test/v1/charges/ch_999", {
        method: "GET",
        headers: { [TOOL_NAME_HEADER]: "check_stripe_charge" },
      }),
    ).rejects.toThrow(MissingFixtureError);
    expect(inner).not.toHaveBeenCalled();

    // callHttpTool wraps every fetch failure with the tool name/URL (existing
    // convention, http-tool.test.ts) -- the specific fixture-miss message
    // must still survive inside that wrapper, not get replaced by a generic one.
    await expect(
      callHttpTool(TOOL, { charge_id: "ch_999" }, { fetchImpl: replayFetch }),
    ).rejects.toThrow(/No recorded fixture/);
  });

  it("keys fixtures on the tool-name header set by callHttpTool, not a caller-supplied name", async () => {
    const wrapped = createFixtureFetch({
      mode: "record",
      fixturesDir: dir,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });

    await wrapped("https://example.test/x", {
      method: "GET",
      headers: { [TOOL_NAME_HEADER]: "my_tool" },
    });

    const written = readdirSync(dir);
    expect(written.some((f) => f.startsWith("my_tool."))).toBe(true);
  });
});

describe("createFixtureFetch -- secret redaction (BYOK convention, AGENTS.md)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-fixtures-secrets-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never writes a literal secret value to disk, even when it appears in the URL or response body", async () => {
    const secretApiKey = "sk-super-secret-value-12345";
    const toolWithSecretUrl: Tool = {
      name: "call_with_key",
      action: "http_request",
      method: "GET",
      url: `https://api.example.test/v1/data?api_key=${secretApiKey}`,
    };
    const inner = (async () =>
      new Response(JSON.stringify({ echoed_key: secretApiKey, ok: true }), {
        status: 200,
      })) as unknown as typeof fetch;
    const recordFetch = createFixtureFetch({
      mode: "record",
      fixturesDir: dir,
      fetchImpl: inner,
      secrets: [secretApiKey],
    });

    await callHttpTool(toolWithSecretUrl, {}, { fetchImpl: recordFetch });

    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(join(dir, file), "utf8");
      expect(contents).not.toContain(secretApiKey);
      expect(contents).toContain("[REDACTED]");
    }
  });
});
