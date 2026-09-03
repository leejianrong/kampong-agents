import { describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { createMastraModelClient, OPENROUTER_BASE_URL } from "../../src/model.js";

// Follow-up to the V3 Ollama adapter (KAN-1112): the Ollama entry shipped
// with a real bug that only surfaced against an actual server -- Ollama's
// OpenAI-compatibility layer only implements the classic Chat Completions
// API (`POST /v1/chat/completions`), not the newer Responses API
// (`POST /v1/responses`) that the bare `createOpenAI(...)(name)` factory
// call defaults to, so the fix was calling `.chat(name)` instead.
//
// This is the regression test for the same class of bug on OpenRouter's
// adapter -- verified against OpenRouter's own documented API surface
// (openrouter.ai/docs: "OpenRouter's request and response schemas are very
// similar to the OpenAI Chat API"; the only documented completion endpoint
// is `POST /api/v1/chat/completions`, there is no Responses-API-shaped
// endpoint), not assumed just because Ollama needed `.chat()` too.
//
// The fake server below actually enforces the endpoint shape: it 404s any
// request whose path isn't `/chat/completions`, and returns a real
// Chat-Completions-shaped body (mirroring e2e/offline-run.test.ts's
// `fakeOllamaFetch` pattern) for the ones that are. If `model.ts` ever
// regresses to the bare `createOpenAI(...)(name)` call (Responses API), the
// AI SDK would request `/responses` instead, this fake would 404 it, and
// `generateText`/`generateStructured` would reject -- catching a
// wire-format mismatch here instead of leaving it to whoever adds the next
// provider.

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function fakeOpenRouterFetch(replyText: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (!url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({ error: { message: `not found: ${url} (not a Chat Completions path)` } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    // Shaped after OpenRouter's actual documented response: an
    // OpenAI-Chat-Completions-compatible body ("very similar ... with a few
    // small differences" per their docs), including OpenRouter-specific
    // fields (`provider`) alongside the standard ones.
    return new Response(
      JSON.stringify({
        id: "gen-openrouter-fake",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "anthropic/claude-3.5-haiku",
        provider: "Anthropic",
        choices: [
          { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function openRouterSpec(): AgentSpec {
  return {
    version: "1.0",
    agent: {
      id: "openrouter-agent",
      name: "OpenRouter Agent",
      role: "Tester",
      goal: "Say hello using an OpenRouter model.",
      model: {
        provider: "openrouter",
        name: "anthropic/claude-3.5-haiku",
        api_key: "${KAMPONG_TEST_OPENROUTER_FAKE_KEY}",
      },
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  };
}

describe("OpenRouter adapter -- wire format against a fake OpenRouter-shaped server", () => {
  it("calls the documented Chat Completions endpoint and returns the reply text (proves `.chat()`, not `.responses()`)", async () => {
    process.env.KAMPONG_TEST_OPENROUTER_FAKE_KEY = "sk-or-fake-test-key-not-real";
    try {
      const client = createMastraModelClient(openRouterSpec(), process.env, {
        fetchImpl: fakeOpenRouterFetch("Hello from OpenRouter!"),
      });

      const text = await client.generateText({ instructions: "Be nice.", prompt: "hi" });
      expect(text).toBe("Hello from OpenRouter!");
    } finally {
      delete process.env.KAMPONG_TEST_OPENROUTER_FAKE_KEY;
    }
  });

  it("resolves the fixed https://openrouter.ai/api/v1 base URL, no per-spec override", () => {
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("would fail against a server that only implements the Responses API shape (the Ollama-class bug, reproduced)", async () => {
    // Same fake server, but responding as if only `/responses` (not
    // `/chat/completions`) were implemented -- i.e. what OpenRouter's own
    // compat layer would do to a Responses-API request, since it doesn't
    // implement that endpoint. Proves the fake genuinely discriminates
    // between the two wire formats rather than accepting anything.
    const responsesOnlyFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      if (url.endsWith("/responses")) {
        return new Response(JSON.stringify({ output: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    }) as unknown as typeof fetch;

    process.env.KAMPONG_TEST_OPENROUTER_FAKE_KEY = "sk-or-fake-test-key-not-real";
    try {
      const client = createMastraModelClient(openRouterSpec(), process.env, {
        fetchImpl: responsesOnlyFetch,
      });
      await expect(client.generateText({ instructions: "x", prompt: "hi" })).rejects.toBeDefined();
    } finally {
      delete process.env.KAMPONG_TEST_OPENROUTER_FAKE_KEY;
    }
  });
});
