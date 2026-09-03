import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import {
  createMastraModelClient,
  MissingApiKeyError,
  resolveEnvVarPlaceholder,
} from "../../src/model.js";

// SLICES.md V2 integration test plan: "Missing/invalid API key produces a
// clear, specific error rather than a generic failure" (KAN-1106). Exercises
// the real provider-construction path (crosses the @kampong/spec boundary)
// with no live network call -- constructing an AI SDK provider client is
// synchronous local work; only an actual generate() call would hit the
// network, and no test here calls one.

const SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "test-agent",
    name: "Test Agent",
    role: "Tester",
    goal: "Say hello.",
    model: {
      provider: "anthropic",
      name: "claude-3-5-haiku-latest",
      api_key: "${KAMPONG_TEST_API_KEY}",
    },
    workflow: [{ step: "greet", action: "say_hello" }],
  },
};

describe("resolveEnvVarPlaceholder", () => {
  it("resolves a set environment variable", () => {
    expect(resolveEnvVarPlaceholder("${SOME_VAR}", "anthropic", { SOME_VAR: "secret-value" })).toBe(
      "secret-value",
    );
  });

  it("throws MissingApiKeyError naming the specific variable, not a generic failure", () => {
    let error: unknown;
    try {
      resolveEnvVarPlaceholder("${SOME_VAR}", "anthropic", {});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MissingApiKeyError);
    expect((error as MissingApiKeyError).envVar).toBe("SOME_VAR");
    expect((error as Error).message).toContain("SOME_VAR");
    expect((error as Error).message).toContain("anthropic");
  });
});

describe("createMastraModelClient (BYOK resolution)", () => {
  const ENV_VAR = "KAMPONG_TEST_API_KEY";

  beforeEach(() => {
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("throws a clear, specific error when the referenced env var is unset -- never a silent fallback", () => {
    expect(() => createMastraModelClient(SPEC, process.env)).toThrow(MissingApiKeyError);
    try {
      createMastraModelClient(SPEC, process.env);
    } catch (err) {
      expect((err as Error).message).toContain(ENV_VAR);
      expect((err as Error).message).toContain("anthropic");
      // never echoes a key value, since none was set
      expect((err as Error).message).not.toMatch(/sk-/);
    }
  });

  it("succeeds once the env var is set, with zero network call made", () => {
    process.env[ENV_VAR] = "sk-ant-fake-test-key-not-real";
    const client = createMastraModelClient(SPEC, process.env);
    expect(typeof client.generateText).toBe("function");
    expect(typeof client.generateStructured).toBe("function");
  });

  it("throws a clear error when the spec has no model configured at all", () => {
    const noModelSpec: AgentSpec = { ...SPEC, agent: { ...SPEC.agent, model: undefined } };
    expect(() => createMastraModelClient(noModelSpec, process.env)).toThrow(
      /no `agent.model` configured/,
    );
  });
});

// OpenRouter is a cloud aggregator like anthropic/openai -- unlike ollama it
// requires a real BYOK api_key -- so it goes through the exact same
// resolution path exercised above. Separate describe block (rather than
// parametrizing the ones above) so the SPEC fixture above stays untouched.
describe("createMastraModelClient (BYOK resolution) -- openrouter", () => {
  const ENV_VAR = "KAMPONG_TEST_OPENROUTER_API_KEY";

  const OPENROUTER_SPEC: AgentSpec = {
    version: "1.0",
    agent: {
      id: "test-agent",
      name: "Test Agent",
      role: "Tester",
      goal: "Say hello.",
      model: {
        provider: "openrouter",
        name: "anthropic/claude-3.5-haiku",
        api_key: `\${${ENV_VAR}}`,
      },
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  };

  beforeEach(() => {
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("throws MissingApiKeyError when the referenced env var is unset -- openrouter is a cloud provider, not ollama", () => {
    expect(() => createMastraModelClient(OPENROUTER_SPEC, process.env)).toThrow(MissingApiKeyError);
    try {
      createMastraModelClient(OPENROUTER_SPEC, process.env);
    } catch (err) {
      expect((err as Error).message).toContain(ENV_VAR);
      expect((err as Error).message).toContain("openrouter");
    }
  });

  it("succeeds once the env var is set, with zero network call made", () => {
    process.env[ENV_VAR] = "sk-or-fake-test-key-not-real";
    const client = createMastraModelClient(OPENROUTER_SPEC, process.env);
    expect(typeof client.generateText).toBe("function");
    expect(typeof client.generateStructured).toBe("function");
  });
});
