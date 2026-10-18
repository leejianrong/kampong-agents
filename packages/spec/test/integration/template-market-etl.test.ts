import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { buildComponentToolFromForm, buildOpInput, planOpForm } from "../../src/component-form.js";
import { buildSimpleStepEdit, listSteps, simpleStepToEditInput } from "../../src/step-edit.js";
import { mergeWith, toolEditPatch, withToFormValues } from "../../src/tool-edit.js";
import type { Tool } from "../../src/schema.js";

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

  // KAM-175: a tool and a tool step, edited as the forms do, change only their own line.
  it("edits a component tool's input and a tool step with a one-line change each, comments kept", () => {
    const { doc, spec } = parseSpec(SOURCE);
    const index = spec!.agent.tools!.findIndex((t) => t.name === "post_alert");
    const tool = spec!.agent.tools![index] as Extract<Tool, { action: "component" }>;
    const plan = planOpForm({
      type: "object",
      required: ["channel", "text"],
      properties: { channel: { type: "string" }, text: { type: "string" } },
    });
    const seeded = withToFormValues(plan, tool.with);
    if (!("values" in seeded)) throw new Error(seeded.reason);
    const built = buildOpInput(plan, { ...seeded.values, channel: "#ops" });
    const rebuilt = buildComponentToolFromForm({
      name: tool.name,
      use: tool.use,
      op: tool.op,
      with: mergeWith(plan, tool, built.input),
    });
    const toolOps = toolEditPatch(["agent", "tools", index], tool, rebuilt.tool!);
    expect(toolOps).toHaveLength(1);

    const write = listSteps(spec!).find((r) => r.name === "write")!;
    const stepEdit = buildSimpleStepEdit(
      { kind: "tool", tool: "post_alert" },
      write as typeof write & { step: Parameters<typeof simpleStepToEditInput>[0] },
      "1.1",
      spec!.agent.tools!.map((t) => t.name),
    );
    if (!stepEdit.success) throw new Error(stepEdit.errors.join());

    applyPatch(doc, [...toolOps, ...stepEdit.patch]);
    const edited = toYamlString(doc);
    const before = SOURCE.split("\n");
    const after = edited.split("\n");
    expect(after).toHaveLength(before.length);
    expect(before.filter((line, i) => line !== after[i])).toEqual([
      '        channel: "{{ vars.slack_channel }}"',
      "            tool: upsert_price",
    ]);
    expect(edited.match(/^\s*#.*$/gm)).toEqual(SOURCE.match(/^\s*#.*$/gm));
    const reparsed = parseSpec(edited);
    expect(reparsed.success).toBe(true);
    expect(toYamlString(reparsed.doc)).toBe(edited);
  });
});
