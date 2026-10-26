import { describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import {
  AssistantCallError,
  chat,
  resolveAssistantConfig,
  type AssistantConfig,
} from "../../src/assistant.js";

// KAM-249: where the assistant talks to, in the repo's order, and that a failure is visible and holds no key.

const spec = (model: string) =>
  parseSpec(`version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
${model}
  workflow:
    - step: s
      action: x
`).spec!;

describe("resolveAssistantConfig", () => {
  it("prefers an explicit endpoint, then OpenRouter, then OpenAI", () => {
    const env = {
      KAMPONG_ASSISTANT_BASE_URL: "http://127.0.0.1:9000/v1/",
      KAMPONG_ASSISTANT_API_KEY: "k1",
      KAMPONG_ASSISTANT_MODEL: "m",
      OPENROUTER_API_KEY: "k2",
      OPENAI_API_KEY: "k3",
    };
    expect(resolveAssistantConfig(env)).toMatchObject({
      ok: true,
      config: { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "k1", model: "m" },
    });
    const noExplicit: NodeJS.ProcessEnv = { ...env };
    delete noExplicit.KAMPONG_ASSISTANT_BASE_URL;
    expect(resolveAssistantConfig(noExplicit)).toMatchObject({
      ok: true,
      config: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k2" },
    });
    const onlyOpenai: NodeJS.ProcessEnv = { ...noExplicit };
    delete onlyOpenai.OPENROUTER_API_KEY;
    expect(resolveAssistantConfig(onlyOpenai)).toMatchObject({
      ok: true,
      config: { baseUrl: "https://api.openai.com/v1", apiKey: "k3" },
    });
  });

  it("takes the model from the workflow when none is named", () => {
    const s = spec(
      '  model: { provider: openrouter, name: vendor/small, api_key: "${OPENROUTER_API_KEY}" }',
    );
    expect(resolveAssistantConfig({ OPENROUTER_API_KEY: "k" }, s)).toMatchObject({
      ok: true,
      config: { model: "vendor/small" },
    });
    // The workflow's own key variable counts as set up.
    const own = spec('  model: { provider: openrouter, name: vendor/small, api_key: "${MY_KEY}" }');
    expect(resolveAssistantConfig({ MY_KEY: "k" }, own)).toMatchObject({
      ok: true,
      config: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
    });
  });

  it("uses a local Ollama through its OpenAI-compatible path, with no key", () => {
    const s = spec("  model: { provider: ollama, name: llama3.1 }");
    expect(resolveAssistantConfig({}, s)).toMatchObject({
      ok: true,
      config: { baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
    });
    const config = (resolveAssistantConfig({}, s) as { config: AssistantConfig }).config;
    expect(config.apiKey).toBeUndefined();
  });

  it("will not use a direct Anthropic key, and says what to do instead", () => {
    const s = spec('  model: { provider: anthropic, name: x, api_key: "${ANTHROPIC_API_KEY}" }');
    const result = resolveAssistantConfig({ ANTHROPIC_API_KEY: "k" }, s);
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
    if (!result.ok) expect(result.error).toContain("OPENROUTER_API_KEY");
  });

  it("says when nothing is set up, and when a model is missing", () => {
    expect(resolveAssistantConfig({})).toMatchObject({ ok: false, code: "not_configured" });
    expect(resolveAssistantConfig({ OPENROUTER_API_KEY: "k" })).toMatchObject({
      ok: false,
      code: "incomplete",
    });
  });
});

describe("chat", () => {
  const config: AssistantConfig = {
    baseUrl: "https://llm.example.test/v1",
    apiKey: "sk-secret-123",
    model: "m",
    from: "test",
    timeoutMs: 1000,
  };
  const messages = [{ role: "user" as const, content: "hi" }];

  it("sends the key only as a bearer header, and returns the reply text", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const reply = await chat(config, messages, async (url, init) => {
      seen = { url, init };
      return Response.json({ choices: [{ message: { content: "hello" } }] });
    });
    expect(reply).toBe("hello");
    expect(seen!.url).toBe("https://llm.example.test/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-secret-123",
    );
    expect(String(seen!.init.body)).not.toContain("sk-secret-123");
  });

  it("fails visibly when the endpoint is down, and never names the key", async () => {
    const err = await chat(config, messages, async () => {
      throw new Error("connect ECONNREFUSED sk-secret-123");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantCallError);
    expect((err as Error).message).toContain(
      "Could not reach the assistant endpoint llm.example.test",
    );
    expect((err as Error).message).not.toContain("sk-secret-123");
  });

  it("reports a refusal with its status, and an empty answer", async () => {
    await expect(
      chat(config, messages, async () => new Response("bad key sk-secret-123", { status: 401 })),
    ).rejects.toThrow(/answered 401: bad key \[key\]/);
    await expect(
      chat(config, messages, async () => Response.json({ choices: [] })),
    ).rejects.toThrow(/empty answer/);
  });
});
