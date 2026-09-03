import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import { VALID_FIXTURE, VALID_FIXTURE_WITH_MODEL } from "../fixtures.js";

describe("parseSpec", () => {
  it("parses a valid fixture", () => {
    const result = parseSpec(VALID_FIXTURE);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.id).toBe("refund-agent");
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a wrong-type field value with a field path and a line number", () => {
    const bad = VALID_FIXTURE.replace("confidence_threshold: 0.85", 'confidence_threshold: "high"');
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    const err = result.errors.find(
      (e) => e.path.join(".") === "agent.guardrails.confidence_threshold",
    );
    expect(err).toBeDefined();
    expect(err?.line).toBeGreaterThan(0);
  });

  it("rejects an invalid HTTP method enum value with a field path", () => {
    const bad = VALID_FIXTURE.replace("method: GET", "method: FETCH");
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.tools.0.method")).toBe(true);
  });

  it("rejects a spec missing a required field, naming the field in the path", () => {
    const bad = VALID_FIXTURE.replace(
      '  goal: "Review incoming refund requests and process eligible ones."\n',
      "",
    );
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.goal")).toBe(true);
  });

  it("parses a model field with a ${ENV_VAR} api_key placeholder", () => {
    const result = parseSpec(VALID_FIXTURE_WITH_MODEL);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.model).toEqual({
      provider: "anthropic",
      name: "claude-3-5-haiku-latest",
      api_key: "${ANTHROPIC_API_KEY}",
    });
  });

  it("rejects a model api_key that is a literal secret instead of a ${ENV_VAR} placeholder", () => {
    const bad = VALID_FIXTURE_WITH_MODEL.replace(
      "api_key: ${ANTHROPIC_API_KEY}",
      "api_key: sk-ant-literal-secret-value",
    );
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.model.api_key")).toBe(true);
  });

  it("parses an ollama model with no api_key at all (V3, KAN-1112 -- local provider needs no BYOK key)", () => {
    const withOllama = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: ollama\n    name: llama3.1\n",
    );
    const result = parseSpec(withOllama);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.model).toEqual({ provider: "ollama", name: "llama3.1" });
  });

  it("parses an ollama model with an explicit base_url pointing at a non-default host", () => {
    const withOllama = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: ollama\n    name: llama3.1\n    base_url: http://localhost:22222\n",
    );
    const result = parseSpec(withOllama);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.model?.base_url).toBe("http://localhost:22222");
  });

  it("rejects a cloud-provider model missing api_key (finding #2 -- must fail at schema validation, not deep inside the engine)", () => {
    const bad = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n",
    );
    const result = parseSpec(bad);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.model.api_key")).toBe(true);
  });

  it("rejects an openai model missing api_key the same way", () => {
    const bad = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: openai\n    name: gpt-4o-mini\n",
    );
    const result = parseSpec(bad);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.model.api_key")).toBe(true);
  });

  it("parses an openrouter model with a vendor-prefixed name and an api_key placeholder", () => {
    const withOpenRouter = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: openrouter\n    name: anthropic/claude-3.5-haiku\n    api_key: ${OPENROUTER_API_KEY}\n",
    );
    const result = parseSpec(withOpenRouter);
    expect(result.success).toBe(true);
    expect(result.spec?.agent.model).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-3.5-haiku",
      api_key: "${OPENROUTER_API_KEY}",
    });
  });

  it("rejects an openrouter model missing api_key, same as anthropic/openai (it is a cloud provider, not ollama)", () => {
    const bad = VALID_FIXTURE_WITH_MODEL.replace(
      "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
      "  model:\n    provider: openrouter\n    name: anthropic/claude-3.5-haiku\n",
    );
    const result = parseSpec(bad);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.model.api_key")).toBe(true);
  });

  it("rejects an unknown model provider", () => {
    const bad = VALID_FIXTURE_WITH_MODEL.replace("provider: anthropic", "provider: azure");
    const result = parseSpec(bad);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.path.join(".") === "agent.model.provider")).toBe(true);
  });

  it("rejects a YAML syntax error with a line number, not a generic parse failure", () => {
    const bad = 'version: "1.0"\nagent:\n  id: refund-agent\n  tools: [\n';
    const result = parseSpec(bad);

    expect(result.success).toBe(false);
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  });
});
