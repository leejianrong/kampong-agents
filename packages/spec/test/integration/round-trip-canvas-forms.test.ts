import { describe, expect, it } from "vitest";
import {
  applyPatch,
  buildActionStepEdit,
  buildOutputSchemaFromFields,
  buildToolFromForm,
  buildTriggerFromForm,
  buildVarFromForm,
  parseSpec,
  removeVarOps,
  renameVarOps,
  setVarOps,
  toYamlString,
  triggerFormFromSpec,
  triggerOps,
  type PatchOp,
} from "../../src/index.js";
import { VALID_FIXTURE_CANVAS_FORMS } from "../fixtures-canvas-forms.js";
import { VALID_FIXTURE } from "../fixtures.js";

// KAN-1850: the fields the canvas forms write must round-trip like every other edit (ADR-0002/ADR-0007):
// YAML -> form -> patch -> YAML -> re-parse is a fixed point, and a patch touches only what it changes.

function edit(source: string, ops: PatchOp[]): string {
  const { doc, success } = parseSpec(source);
  expect(success).toBe(true);
  applyPatch(doc, ops);
  return toYamlString(doc);
}

function expectValidFixedPoint(source: string): void {
  const parsed = parseSpec(source);
  expect(parsed.errors).toEqual([]);
  expect(toYamlString(parsed.doc)).toBe(source);
}

describe("canvas forms round trip (KAN-1850)", () => {
  it("re-serializes the forms fixture byte-for-byte with zero mutations", () => {
    expectValidFixedPoint(VALID_FIXTURE_CANVAS_FORMS);
  });

  it("editing an action step in place changes only that field and keeps every comment", () => {
    const spec = parseSpec(VALID_FIXTURE_CANVAS_FORMS).spec!;
    const before = spec.agent.workflow[0] as Record<string, unknown>;
    const result = buildActionStepEdit({ version: spec.version }, 0, before, {
      action: "summarise_alerts",
      instructions: "Be brief.",
      model: "small-model",
      temperature: 0.7,
      outputSchema: before["output_schema"] as never,
    });
    const out = edit(VALID_FIXTURE_CANVAS_FORMS, result.ops!);
    const changed = VALID_FIXTURE_CANVAS_FORMS.split("\n").filter(
      (line, i) => line !== out.split("\n")[i],
    );
    expect(changed).toEqual(["      temperature: 0.2"]);
    expect(out).toContain("# how many alerts one run looks at");
    expectValidFixedPoint(out);
    // Doing the same edit again is a no-op.
    const again = parseSpec(out).spec!;
    const redo = buildActionStepEdit(
      { version: again.version },
      0,
      again.agent.workflow[0] as Record<string, unknown>,
      {
        action: "summarise_alerts",
        instructions: "Be brief.",
        model: "small-model",
        temperature: 0.7,
        outputSchema: before["output_schema"] as never,
      },
    );
    expect(redo.ops).toEqual([]);
  });

  it("adds an output_schema built from fields, and removes it again", () => {
    const source = VALID_FIXTURE_CANVAS_FORMS.replace(
      / {6}output_schema:[\s\S]*? {10}- severe\n/,
      "",
    );
    expectValidFixedPoint(source);
    const spec = parseSpec(source).spec!;
    const built = buildOutputSchemaFromFields([
      { name: "summary", type: "string", required: true },
      { name: "severe", type: "boolean", required: true },
    ]);
    const result = buildActionStepEdit(
      { version: spec.version },
      0,
      spec.agent.workflow[0] as Record<string, unknown>,
      {
        action: "summarise_alerts",
        instructions: "Be brief.",
        model: "small-model",
        temperature: 0.2,
        outputSchema: built.schema!,
      },
    );
    const out = edit(source, result.ops!);
    expectValidFixedPoint(out);
    expect(parseSpec(out).spec!.agent.workflow[0]).toMatchObject({ output_schema: built.schema });
    const back = parseSpec(out).spec!;
    const cleared = buildActionStepEdit(
      { version: back.version },
      0,
      back.agent.workflow[0] as Record<string, unknown>,
      {
        action: "summarise_alerts",
        instructions: "Be brief.",
        model: "small-model",
        temperature: 0.2,
      },
    );
    expect(edit(out, cleared.ops!)).toBe(source);
  });

  it("adds, renames and removes vars, rewriting readers, with comments kept", () => {
    const spec = parseSpec(VALID_FIXTURE_CANVAS_FORMS).spec!;
    const added = buildVarFromForm({ name: "limit", type: "number", default: "5" });
    let out = edit(VALID_FIXTURE_CANVAS_FORMS, setVarOps(spec, added.name!, added.var!));
    expectValidFixedPoint(out);
    expect(out).toContain("# how many alerts one run looks at");

    const renamed = renameVarOps(parseSpec(out).spec!, "region", "zone");
    out = edit(out, renamed.ops);
    expectValidFixedPoint(out);
    expect(out).toContain('region: "{{ vars.zone }}"');
    expect(out).not.toContain("vars.region");

    const removed = removeVarOps(parseSpec(out).spec!, "limit");
    out = edit(out, removed.ops);
    expectValidFixedPoint(out);
    expect(parseSpec(out).spec!.vars).not.toHaveProperty("limit");
  });

  it("creates the vars block and raises the version on a 1.0 spec", () => {
    const spec = parseSpec(VALID_FIXTURE).spec!;
    const out = edit(VALID_FIXTURE, setVarOps(spec, "cap", { type: "number", default: 3 }));
    expectValidFixedPoint(out);
    expect(out).toContain('version: "1.1"');
    expect(out).toContain("# Refund processing agent");
  });

  it("changes the trigger key by key, and replaces it with a schedule", () => {
    const spec = parseSpec(VALID_FIXTURE_CANVAS_FORMS).spec!;
    const form = triggerFormFromSpec(spec.agent.trigger);
    if (form.kind !== "webhook") throw new Error("expected a webhook");
    const edited = buildTriggerFromForm({ ...form, respond: "sync" }).trigger!;
    const out = edit(VALID_FIXTURE_CANVAS_FORMS, triggerOps(spec, edited));
    expectValidFixedPoint(out);
    expect(out).toContain("respond: sync");
    const schedule = buildTriggerFromForm({
      kind: "schedule",
      mode: "cron",
      cron: "0 9 * * 1-5",
      tz: "Asia/Singapore",
      overlap: "skip",
    }).trigger!;
    const scheduled = edit(out, triggerOps(parseSpec(out).spec!, schedule));
    expectValidFixedPoint(scheduled);
    expect(parseSpec(scheduled).spec!.agent.trigger).toEqual(schedule);
  });

  it("adds an http_request tool with headers, failure_when, pace and retry", () => {
    const tool = buildToolFromForm({
      name: "lookup",
      method: "GET",
      url: "https://api.example.com/v1/items",
      headers: { Accept: "application/json" },
      query: { apikey: "${ALPHA_KEY}" },
      failureWhen: [{ path: "Note", exists: true, retryable: true }],
      pace: { rps: 1 },
      retry: { max: 2 },
    }).tool!;
    const out = edit(VALID_FIXTURE_CANVAS_FORMS, [
      { op: "add", path: ["agent", "tools"], value: tool },
    ]);
    expectValidFixedPoint(out);
    expect(parseSpec(out).spec!.agent.tools?.[1]).toEqual(tool);
  });
});
