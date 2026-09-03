import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { parseSpec } from "../../src/parse.js";
import {
  VALID_FIXTURE,
  VALID_FIXTURE_NO_TOOLS,
  VALID_FIXTURE_WITH_CONDITION,
  VALID_FIXTURE_WITH_MODEL,
} from "../fixtures.js";

// The published JSON Schema (S7) is what external editors and agentic
// coding tools validate against, not our Zod validator directly — it needs
// its own direct test rather than indirect coverage via the in-app
// validator (SLICES.md V1).
describe("generateAgentSpecJsonSchema", () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(generateAgentSpecJsonSchema());

  it.each([
    ["single tool, no conditionals", VALID_FIXTURE],
    ["two tools with a conditional step", VALID_FIXTURE_WITH_CONDITION],
    ["no tools", VALID_FIXTURE_NO_TOOLS],
    ["model + BYOK api_key placeholder + confidence_gate", VALID_FIXTURE_WITH_MODEL],
    [
      "openrouter model with a vendor-prefixed name",
      VALID_FIXTURE_WITH_MODEL.replace(
        "  model:\n    provider: anthropic\n    name: claude-3-5-haiku-latest\n    api_key: ${ANTHROPIC_API_KEY}\n",
        "  model:\n    provider: openrouter\n    name: anthropic/claude-3.5-haiku\n    api_key: ${OPENROUTER_API_KEY}\n",
      ),
    ],
  ])("accepts a fixture the Zod validator accepts: %s", (_name, source) => {
    const { spec, success } = parseSpec(source);
    expect(success).toBe(true);
    expect(validate(spec)).toBe(true);
  });

  it.each([
    ["missing required fields", { version: "1.0", agent: { id: "x" } }],
    [
      "invalid HTTP method",
      {
        version: "1.0",
        agent: {
          id: "x",
          name: "x",
          role: "x",
          goal: "x",
          tools: [{ name: "t", action: "http_request", method: "FETCH", url: "https://x" }],
          workflow: [{ step: "s", action: "a" }],
        },
      },
    ],
    ["not an object at all", "not-a-spec"],
    [
      "a fallback_action the engine doesn't implement",
      {
        version: "1.0",
        agent: {
          id: "x",
          name: "x",
          role: "x",
          goal: "x",
          guardrails: { confidence_threshold: 0.85, fallback_action: "retry_automatically" },
          workflow: [{ step: "s", action: "a" }],
        },
      },
    ],
    [
      "a literal secret instead of an ${ENV_VAR} placeholder",
      {
        version: "1.0",
        agent: {
          id: "x",
          name: "x",
          role: "x",
          goal: "x",
          model: {
            provider: "anthropic",
            name: "claude-3-5-haiku-latest",
            api_key: "sk-ant-literal-secret",
          },
          workflow: [{ step: "s", action: "a" }],
        },
      },
    ],
    [
      "an unknown model provider",
      {
        version: "1.0",
        agent: {
          id: "x",
          name: "x",
          role: "x",
          goal: "x",
          model: { provider: "azure", name: "gpt-4o", api_key: "${AZURE_API_KEY}" },
          workflow: [{ step: "s", action: "a" }],
        },
      },
    ],
  ])("rejects a fixture the Zod validator would also reject: %s", (_name, candidate) => {
    expect(validate(candidate)).toBe(false);
  });
});
