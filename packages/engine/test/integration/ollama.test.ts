import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSpec } from "@kampong/spec";
import {
  createMastraModelClient,
  DEFAULT_OLLAMA_BASE_URL,
  OllamaUnavailableError,
} from "../../src/model.js";

// SLICES.md V3 integration test plan: "Ollama adapter surfaces a clear,
// specific error when the local model server isn't running -- never a
// silent fallback to a cloud provider." (KAN-1112, AGENTS.md/PLAN.md Q8.)
//
// Unlike a missing BYOK key (byok.test.ts), "unavailable" can only be
// detected at call time -- there's no key to check synchronously -- so this
// exercises the real provider-construction + generate() path with an
// injected `fetchImpl` shaped like a real connection-refused failure
// (Node/undici's `fetch` throws `TypeError: fetch failed` with a `.cause`
// carrying the actual `ECONNREFUSED` system error), rather than mocking
// away the network seam entirely.

function connectionRefusedFetch(): typeof fetch {
  return (async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    throw new TypeError("fetch failed", { cause });
  }) as typeof fetch;
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

describe("Ollama adapter -- server unavailable", () => {
  it("throws OllamaUnavailableError (not a generic error) when the local server refuses the connection", async () => {
    const client = createMastraModelClient(
      ollamaSpec(),
      {},
      { fetchImpl: connectionRefusedFetch() },
    );

    await expect(client.generateText({ instructions: "x", prompt: "hi" })).rejects.toThrow(
      OllamaUnavailableError,
    );
  });

  it("names the base URL and never mentions falling back to a cloud provider by default", async () => {
    const client = createMastraModelClient(
      ollamaSpec(),
      {},
      { fetchImpl: connectionRefusedFetch() },
    );

    let error: unknown;
    try {
      await client.generateText({ instructions: "x", prompt: "hi" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OllamaUnavailableError);
    expect((error as OllamaUnavailableError).baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect((error as Error).message).toContain(DEFAULT_OLLAMA_BASE_URL);
    expect((error as Error).message).toContain("ollama serve");
  });

  it("uses a custom base_url from the spec, both for the request target and the error message", async () => {
    const customBaseUrl = "http://localhost:22222";
    const client = createMastraModelClient(
      ollamaSpec({ base_url: customBaseUrl }),
      {},
      {
        fetchImpl: connectionRefusedFetch(),
      },
    );

    let error: unknown;
    try {
      await client.generateStructured({
        instructions: "x",
        prompt: "hi",
        schema: z.object({ result: z.string() }),
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(OllamaUnavailableError);
    expect((error as OllamaUnavailableError).baseUrl).toBe(customBaseUrl);
  });

  it("does not require -- or resolve -- any api_key for the ollama provider", () => {
    // No api_key on the spec at all; construction must not throw
    // MissingApiKeyError the way it would for anthropic/openai.
    expect(() => createMastraModelClient(ollamaSpec(), {})).not.toThrow();
  });

  it("a non-connection-refused error from the model call is NOT reinterpreted as OllamaUnavailableError", async () => {
    const authFailureFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        statusText: "Bad Request",
      })) as typeof fetch;

    const client = createMastraModelClient(ollamaSpec(), {}, { fetchImpl: authFailureFetch });

    let error: unknown;
    try {
      await client.generateText({ instructions: "x", prompt: "hi" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(OllamaUnavailableError);
  });
});
