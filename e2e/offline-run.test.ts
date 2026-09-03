import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec } from "@kampong/spec";
import { createAgentRun, createFixtureFetch } from "@kampong/engine";

// SLICES.md V3's headline e2e acceptance test (KAN-1113): "kampong run
// against a mock-recorded spec, fully offline (network disabled), completes
// and matches the expected fixture output." Also the regression coverage
// for R3 ("zero required network calls, zero default telemetry" -- this
// repo has no telemetry code at all, so proving no network calls IS this
// requirement's coverage).
//
// "Fully offline" here is proven, not assumed: the REAL global `fetch` is
// stubbed to throw immediately on any call, and the run still completes --
// which only works because both of this slice's offline seams genuinely
// route around it rather than merely defaulting to it when convenient:
//   - the tool call goes through the mock/record layer in "replay" mode
//     (KAN-1111), which on a fixture hit never calls any fetch at all;
//   - the model call goes through the real `ollama` provider-resolution
//     path (KAN-1112, model.ts), but with its OWN `fetch` swapped out via
//     `modelFetchImpl` -- proving that seam, not just the tool seam, never
//     silently falls back to the global fetch either.
// This is the "equivalent programmatic path" to `kampong run` (createAgentRun
// is exactly what cli.ts's `run` command calls) rather than spawning the
// actual `kampong` binary, since the binary intentionally has no flag to
// override the model's own fetch -- that's a test-only seam, not a user
// affordance (see run.ts's `CreateAgentRunOptions.modelFetchImpl` docstring).

const FIXTURE_SPEC = `version: "1.0"
agent:
  id: offline-agent
  name: "Offline Agent"
  role: "Support"
  goal: "Look up a charge with no network access."
  model:
    provider: ollama
    name: llama3.1
    base_url: "http://127.0.0.1:1"
  tools:
    - name: check_charge
      action: http_request
      method: GET
      url: "https://api.stripe.test/v1/charges/off-999"
      extract: "data.status"
  workflow:
    - step: parse
      action: extract_entities
    - step: decide
      type: condition
      if: "parse.eligible == true"
      then: "x"
      else: "execute_tool(check_charge)"
`;

function fakeOllamaFetch(replyText: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-offline",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "llama3.1",
        choices: [
          { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("fully offline run: mock-recorded tool + Ollama model, network provably disabled (KAN-1113)", () => {
  let fixturesDir: string;

  beforeEach(() => {
    fixturesDir = mkdtempSync(join(tmpdir(), "kampong-e2e-fixtures-"));
  });

  afterEach(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("completes and matches the expected output with zero calls ever reaching the real network", async () => {
    const globalFetchGuard = vi.fn(async () => {
      throw new Error(
        "network access attempted during a fully offline run -- the offline seams should " +
          "never fall through to the real global fetch",
      );
    });
    vi.stubGlobal("fetch", globalFetchGuard);

    const { success, spec } = parseSpec(FIXTURE_SPEC);
    expect(success).toBe(true);

    // Step 1 (setup, not part of the "offline" claim): record the tool
    // fixture once, standing a fake "live" fetch in for a real network call
    // -- deliberately NOT the stubbed global fetch above.
    const fakeLiveToolFetch = (async () =>
      new Response(JSON.stringify({ data: { status: "succeeded" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const recordFetch = createFixtureFetch({
      mode: "record",
      fixturesDir,
      fetchImpl: fakeLiveToolFetch,
    });
    const recordingRun = createAgentRun(spec!, {
      fetchImpl: recordFetch,
      modelFetchImpl: fakeOllamaFetch("(recording step -- not asserted on)"),
    });
    const recorded = await recordingRun.start("Check charge off-999");
    expect(recorded.status).toBe("completed");

    // Step 2: the actual fully-offline run this test is about. "replay"
    // mode for the tool call (a fixture hit never touches any fetch at
    // all) plus a fake Ollama-shaped fetch for the model call -- neither
    // seam should ever reach `globalFetchGuard`.
    const replayFetch = createFixtureFetch({ mode: "replay", fixturesDir });
    const offlineRun = createAgentRun(spec!, {
      fetchImpl: replayFetch,
      modelFetchImpl: fakeOllamaFetch("offline parse result"),
    });
    const result = await offlineRun.start("Check charge off-999");

    expect(result.status).toBe("completed");
    expect(result.finalOutput?.parse).toEqual({ text: "offline parse result" });
    expect(result.finalOutput?.decide).toBe("succeeded");
    expect(globalFetchGuard).not.toHaveBeenCalled();
  });

  it("replay mode fails visibly rather than silently falling back to the network when no fixture exists", async () => {
    const globalFetchGuard = vi.fn(async () => {
      throw new Error("network access attempted");
    });
    vi.stubGlobal("fetch", globalFetchGuard);

    const { spec } = parseSpec(FIXTURE_SPEC);
    const replayFetch = createFixtureFetch({ mode: "replay", fixturesDir }); // nothing recorded yet
    const run = createAgentRun(spec!, {
      fetchImpl: replayFetch,
      modelFetchImpl: fakeOllamaFetch("parse result"),
    });

    const result = await run.start("Check charge off-999");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/No recorded fixture/);
    expect(globalFetchGuard).not.toHaveBeenCalled();
  });
});
