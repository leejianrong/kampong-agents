import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";

// KAN-1865: the market-etl template is a real spec, so it must meet the same bar as every fixture: it
// validates, validates against the published JSON Schema, and survives the canvas round trip.
const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url)),
  "utf8",
);

describe("templates/market-etl/agent.yaml", () => {
  it("validates", () => {
    const { success, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    expect(success).toBe(true);
  });

  it("validates against the published JSON Schema", () => {
    const validate = new Ajv({ strict: false }).compile(generateAgentSpecJsonSchema());
    const { spec } = parseSpec(SOURCE);
    expect(validate(JSON.parse(JSON.stringify(spec))), JSON.stringify(validate.errors)).toBe(true);
  });

  it("re-serializes byte-for-byte with zero mutations", () => {
    const { doc, success } = parseSpec(SOURCE);
    expect(success).toBe(true);
    expect(toYamlString(doc)).toBe(SOURCE);
  });

  it("keeps every comment and untouched line when the canvas edits one value, and the result is a fixed point", () => {
    const { doc } = parseSpec(SOURCE);
    applyPatch(doc, [{ op: "set", path: ["vars", "threshold", "default"], value: 3 }]);
    const edited = toYamlString(doc);
    const before = SOURCE.split("\n");
    const after = edited.split("\n");
    expect(after).toHaveLength(before.length);
    expect(before.filter((line, i) => line !== after[i])).toEqual(["    default: 1.5"]);
    expect(edited.match(/^\s*#.*$/gm)).toEqual(SOURCE.match(/^\s*#.*$/gm));

    const reparsed = parseSpec(edited);
    expect(reparsed.success).toBe(true);
    expect(toYamlString(reparsed.doc)).toBe(edited);
  });
});
