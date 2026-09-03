import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { parseSpec } from "../../src/parse.js";
import {
  VALID_FIXTURE,
  VALID_FIXTURE_NO_TOOLS,
  VALID_FIXTURE_WITH_CONDITION,
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
  ])("rejects a fixture the Zod validator would also reject: %s", (_name, candidate) => {
    expect(validate(candidate)).toBe(false);
  });
});
