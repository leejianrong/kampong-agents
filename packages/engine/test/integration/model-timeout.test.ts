import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSpec } from "@kampong/spec";
import { createAgentRun } from "../../src/run.js";
import {
  createMastraModelClient,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelCallTimeoutError,
} from "../../src/model.js";

// KAN-1185 (R6, ADR-0004): a model call with no timeout can hang `kampong
// run` indefinitely with zero progress output -- confirmed via a live repro
// against a real, unusually slow Ollama daemon that took >90s to respond to
// a small generation call. Proves the fix deterministically and fast: a fake
// `fetch` that never resolves on its own -- exactly the "hung network call"
// shape -- but does honor an `AbortSignal` the same way a real
// Node/undici `fetch` would, combined with a short (tens-of-ms),
// test-specific `timeout_ms`/`--timeout` override so the test itself stays
// fast rather than actually waiting out a real default timeout.

function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

// Chat-Completions-shaped success response (mirrors openrouter.test.ts's
// fakeOpenRouterFetch / e2e/offline-run.test.ts's fakeOllamaFetch) -- proves
// the timeout-enforcing fetch wrapper doesn't interfere with a normal,
// fast-resolving call.
function fastFetch(replyText: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "gen-fake",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "llama3.1",
        choices: [
          { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function ollamaSpec(overrides: Partial<AgentSpec["agent"]["model"]> = {}): AgentSpec {
  return {
    version: "1.0",
    agent: {
      id: "local-agent",
      name: "Local Agent",
      role: "Tester",
      goal: "Say hello using a local model.",
      model: { provider: "ollama", name: "llama3.1", ...overrides },
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  };
}

const SHORT_TIMEOUT_MS = 25;

describe("createMastraModelClient -- model-call timeout (KAN-1185)", () => {
  it("times out a hanging generateText call at the spec's agent.model.timeout_ms, with a specific error", async () => {
    const client = createMastraModelClient(
      ollamaSpec({ timeout_ms: SHORT_TIMEOUT_MS }),
      {},
      { fetchImpl: hangingFetch() },
    );

    let error: unknown;
    try {
      await client.generateText({ instructions: "x", prompt: "hi" });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ModelCallTimeoutError);
    expect((error as ModelCallTimeoutError).timeoutMs).toBe(SHORT_TIMEOUT_MS);
    expect((error as ModelCallTimeoutError).provider).toBe("ollama");
    expect((error as Error).message).toContain(`timed out after ${SHORT_TIMEOUT_MS}ms`);
    expect((error as Error).message).toContain("ollama");
  }, 5000);

  it("times out a hanging generateStructured call the same way", async () => {
    const client = createMastraModelClient(
      ollamaSpec({ timeout_ms: SHORT_TIMEOUT_MS }),
      {},
      { fetchImpl: hangingFetch() },
    );

    await expect(
      client.generateStructured({
        instructions: "x",
        prompt: "hi",
        schema: z.object({ result: z.string() }),
      }),
    ).rejects.toThrow(ModelCallTimeoutError);
  }, 5000);

  it("a `timeoutMs` option (the CLI's --timeout) takes precedence over agent.model.timeout_ms", async () => {
    const client = createMastraModelClient(
      ollamaSpec({ timeout_ms: 60_000 }), // the spec says 60s...
      {},
      { fetchImpl: hangingFetch(), timeoutMs: SHORT_TIMEOUT_MS }, // ...but this wins
    );

    let error: unknown;
    try {
      await client.generateText({ instructions: "x", prompt: "hi" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ModelCallTimeoutError);
    expect((error as ModelCallTimeoutError).timeoutMs).toBe(SHORT_TIMEOUT_MS);
  }, 5000);

  it("exposes a default timeout in the tens-of-seconds range when nothing overrides it", () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("does not time out (or otherwise interfere with) a call that resolves well within the timeout", async () => {
    const client = createMastraModelClient(
      ollamaSpec({ timeout_ms: SHORT_TIMEOUT_MS }),
      {},
      { fetchImpl: fastFetch("hi there") },
    );

    const text = await client.generateText({ instructions: "x", prompt: "hi" });
    expect(text).toBe("hi there");
  }, 5000);

  it("a non-timeout failure (e.g. connection refused) is still reported as OllamaUnavailableError, not misreported as a timeout", async () => {
    const connectionRefusedFetch = (async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
        code: "ECONNREFUSED",
      });
      throw new TypeError("fetch failed", { cause });
    }) as typeof fetch;

    const client = createMastraModelClient(
      ollamaSpec({ timeout_ms: SHORT_TIMEOUT_MS }),
      {},
      { fetchImpl: connectionRefusedFetch },
    );

    let error: unknown;
    try {
      await client.generateText({ instructions: "x", prompt: "hi" });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeInstanceOf(ModelCallTimeoutError);
    expect((error as Error).name).toBe("OllamaUnavailableError");
  }, 5000);
});

describe("createAgentRun -- end-to-end model-call timeout plumbing (KAN-1185)", () => {
  it("a run whose model call hangs ends in status 'failed' with a specific, diagnosable error -- never hangs, never a generic message", async () => {
    const run = createAgentRun(ollamaSpec(), {
      modelFetchImpl: hangingFetch(),
      timeoutMs: SHORT_TIMEOUT_MS,
    });

    const state = await run.start("hello");

    expect(state.status).toBe("failed");
    expect(state.error).toContain(`timed out after ${SHORT_TIMEOUT_MS}ms`);
    expect(state.error).toContain("ollama");
  }, 5000);
});
