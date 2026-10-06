import { describe, expect, it } from "vitest";
import { parseComponentManifest } from "../../src/component.js";
import { parseSpec } from "../../src/parse.js";
import {
  buildComponentToolFromForm,
  buildOpInput,
  catalogEntryFromManifest,
  outputReferenceOptions,
  parseWithYaml,
  planOpForm,
} from "../../src/component-form.js";
import type { SchemaNode } from "../../src/component.js";

// KAN-1885: canvas forms generated from an op's input schema. The logic is here, not in React, so it
// is testable without a DOM and shared with any headless tooling.

const obj = (properties: Record<string, SchemaNode>, required?: string[]): SchemaNode => ({
  type: "object",
  properties,
  ...(required && { required }),
});

describe("planOpForm", () => {
  it("plans no fields for an op without input", () => {
    expect(planOpForm(undefined)).toEqual({ supported: true, fields: [] });
  });

  it("maps each supported shape to a field kind, carrying title, description, default and required", () => {
    const plan = planOpForm(
      obj(
        {
          channel: { type: "string", title: "Channel", description: "Where to post" },
          text: { type: "string", format: "multiline" },
          count: { type: "integer", default: 3 },
          ratio: { type: "number" },
          urgent: { type: "boolean", default: false },
          level: { type: "string", enum: ["low", "high"], default: "low" },
          tags: { type: "array", items: { type: "string" } },
          meta: obj({ a: { type: "string" }, b: { type: "boolean" } }, ["a"]),
        },
        ["channel"],
      ),
    );
    expect(plan.supported).toBe(true);
    const by = Object.fromEntries(plan.fields.map((f) => [f.name, f]));
    expect(by.channel).toMatchObject({
      kind: "text",
      label: "Channel",
      description: "Where to post",
      required: true,
    });
    expect(by.text).toMatchObject({ kind: "multiline", label: "text", required: false });
    expect(by.count).toMatchObject({ kind: "integer", default: 3 });
    expect(by.ratio?.kind).toBe("number");
    expect(by.urgent).toMatchObject({ kind: "boolean", default: false });
    expect(by.level).toMatchObject({ kind: "enum", options: ["low", "high"], default: "low" });
    expect(by.tags?.kind).toBe("text_list");
    expect(by.meta?.kind).toBe("object");
    expect(by.meta?.children?.map((c) => [c.name, c.kind, c.required])).toEqual([
      ["a", "text", true],
      ["b", "boolean", false],
    ]);
  });

  it.each([
    [
      "an array of objects",
      obj({ blocks: { type: "array", items: { type: "object" } } }),
      "blocks",
    ],
    ["an array with no item type", obj({ xs: { type: "array" } }), "xs"],
    ["an object nested two levels", obj({ a: obj({ b: obj({ c: { type: "string" } }) }) }), "a.b"],
    ["an array of numbers", obj({ n: { type: "array", items: { type: "number" } } }), "n"],
  ])("falls back to raw YAML for %s, naming the property", (_n, schema, name) => {
    const plan = planOpForm(schema);
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain(name);
    expect(plan.fields).toEqual([]);
  });
});

describe("buildOpInput", () => {
  const plan = planOpForm(
    obj(
      {
        channel: { type: "string" },
        count: { type: "integer" },
        ratio: { type: "number" },
        urgent: { type: "boolean", default: false },
        level: { type: "string", enum: ["low", "high"] },
        code: { type: "integer", enum: [1, 2] },
        tags: { type: "array", items: { type: "string" } },
        meta: obj({ a: { type: "string" }, b: { type: "boolean" } }),
      },
      ["channel"],
    ),
  );

  it("coerces values to the schema's types and omits what was left empty", () => {
    const out = buildOpInput(plan, {
      channel: "#ops",
      count: "4",
      ratio: "0.5",
      urgent: true,
      level: "high",
      code: "2",
      tags: "a\n\n b \n",
      meta: { a: "x", b: false },
    });
    expect(out.errors).toEqual([]);
    expect(out.input).toEqual({
      channel: "#ops",
      count: 4,
      ratio: 0.5,
      urgent: true,
      level: "high",
      code: 2,
      tags: ["a", "b"],
      meta: { a: "x" },
    });
  });

  it("omits optional fields that were not filled in, and a boolean left at its default", () => {
    const out = buildOpInput(plan, { channel: "#ops", urgent: false });
    expect(out.input).toEqual({ channel: "#ops" });
  });

  it("treats an untouched boolean as its default, whichever way the default points", () => {
    const p = planOpForm(
      obj({ on: { type: "boolean", default: true }, off: { type: "boolean", default: false } }),
    );
    expect(buildOpInput(p, {}).input).toEqual({});
    expect(buildOpInput(p, { on: false }).input).toEqual({ on: false });
    expect(buildOpInput(p, { off: true }).input).toEqual({ off: true });
    expect(buildOpInput(p, { on: true }).input).toEqual({});
  });

  it("reports a missing required field by label", () => {
    expect(buildOpInput(plan, {}).errors).toEqual(["channel is required"]);
    expect(buildOpInput(plan, { channel: "   " }).errors).toEqual(["channel is required"]);
  });

  it("keeps a {{ reference }} in a numeric field as text so the run can fill it in", () => {
    const out = buildOpInput(plan, { channel: "c", count: "{{ triage.priority }}" });
    expect(out.errors).toEqual([]);
    expect(out.input.count).toBe("{{ triage.priority }}");
  });

  it("rejects text that is not a number, and a fractional integer", () => {
    expect(buildOpInput(plan, { channel: "c", count: "abc" }).errors).toEqual([
      "count must be a number",
    ]);
    expect(buildOpInput(plan, { channel: "c", count: "1.5" }).errors).toEqual([
      "count must be an integer",
    ]);
    expect(buildOpInput(plan, { channel: "c", ratio: "Infinity" }).errors).toEqual([
      "ratio must be a number",
    ]);
  });

  it("rejects a value outside an enum", () => {
    expect(buildOpInput(plan, { channel: "c", level: "medium" }).errors).toEqual([
      "level must be one of: low, high",
    ]);
  });

  it("reports a missing required property inside an object once any part of it is filled in", () => {
    const p = planOpForm(
      obj({ meta: obj({ a: { type: "string" }, b: { type: "string" } }, ["a"]) }),
    );
    expect(buildOpInput(p, { meta: { b: "x" } }).errors).toEqual(["meta.a is required"]);
    expect(buildOpInput(p, {}).errors).toEqual([]);
  });

  it("keeps a property named __proto__ as plain data, never as a prototype", () => {
    const p = planOpForm(
      obj(JSON.parse('{"__proto__": {"type": "string"}}') as Record<string, SchemaNode>),
    );
    const values = JSON.parse('{"__proto__": "x"}') as Record<string, string>;
    const out = buildOpInput(p, values);
    expect(Object.getPrototypeOf(out.input)).toBe(Object.prototype);
    expect(Object.hasOwn(out.input, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(out.input))).toEqual(JSON.parse('{"__proto__": "x"}'));
  });

  it("does not let a property named constructor reach the prototype", () => {
    const p = planOpForm(obj({ constructor: { type: "string" } }));
    const out = buildOpInput(p, { constructor: "x" });
    expect(Object.getPrototypeOf(out.input)).toBe(Object.prototype);
    expect(Object.hasOwn(out.input, "constructor")).toBe(true);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe("buildComponentToolFromForm", () => {
  const base = { name: "post", use: "acme/slack@1.0.0", op: "post_message" };

  it("builds a valid component tool and drops empty optional parts", () => {
    const result = buildComponentToolFromForm({
      ...base,
      with: {},
      config: {},
      secrets: { token: "" },
    });
    expect(result.errors).toBeUndefined();
    expect(result.tool).toEqual({ name: "post", action: "component", use: base.use, op: base.op });
  });

  it("keeps with, config, secrets, approval and extract", () => {
    const result = buildComponentToolFromForm({
      ...base,
      with: { channel: "#ops" },
      config: { region: "eu" },
      secrets: { token: "${SLACK_TOKEN}" },
      requiresApproval: false,
      extract: "ts",
    });
    expect(result.tool).toMatchObject({
      with: { channel: "#ops" },
      config: { region: "eu" },
      secrets: { token: "${SLACK_TOKEN}" },
      requires_approval: false,
      extract: "ts",
    });
  });

  it("rejects a literal secret and an unpinned version, with the schema's messages", () => {
    expect(buildComponentToolFromForm({ ...base, secrets: { token: "xoxb-1" } }).success).toBe(
      false,
    );
    expect(buildComponentToolFromForm({ ...base, use: "acme/slack@^1.0.0" }).success).toBe(false);
  });
});

describe("parseWithYaml", () => {
  it("parses a mapping", () => {
    expect(parseWithYaml("a: 1\nb:\n  - x\n").value).toEqual({ a: 1, b: ["x"] });
  });
  it("treats empty text as an empty mapping", () => {
    expect(parseWithYaml("  \n").value).toEqual({});
  });
  it.each(["- a\n- b", "just text", "a: [", "null"])("rejects %j", (text) => {
    const result = parseWithYaml(text);
    expect(result.value).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
  it("rejects aliases rather than expanding them", () => {
    expect(parseWithYaml("a: &x 1\nb: *x\n").error).toBeTruthy();
  });
});

const MANIFEST = `kind: rest
id: acme/tickets
version: 1.0.0
title: Tickets
permissions: { egress: [tickets.example.test] }
auth:
  slots:
    token:
      env: TICKETS_TOKEN
      hosts: [tickets.example.test]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
config:
  region: { type: string, default: eu }
ops:
  get:
    title: Get a ticket
    effect: read
    input: { type: object, required: [id], properties: { id: { type: string } } }
    output:
      type: object
      properties:
        status: { type: string }
        priority: { type: integer }
        owner: { type: object, properties: { name: { type: string } } }
    request: { method: GET, url: "https://tickets.example.test/{{ config.region }}/{{ input.id }}" }
  purge:
    effect: destructive
    request: { method: DELETE, url: "https://tickets.example.test/all" }
`;

describe("catalogEntryFromManifest", () => {
  const manifest = parseComponentManifest(MANIFEST).manifest!;
  const entry = catalogEntryFromManifest(manifest, "sha256:abc");

  it("carries what a form needs and nothing that executes", () => {
    expect(entry).toMatchObject({
      id: "acme/tickets",
      version: "1.0.0",
      title: "Tickets",
      digest: "sha256:abc",
      slots: [{ name: "token", env: "TICKETS_TOKEN" }],
      config: [{ name: "region", default: "eu" }],
    });
    expect(entry.ops.get).toMatchObject({ title: "Get a ticket", effect: "read" });
    expect(entry.ops.purge?.effect).toBe("destructive");
    expect(JSON.stringify(entry)).not.toContain("tickets.example.test/all");
  });
});

describe("outputReferenceOptions", () => {
  const manifest = parseComponentManifest(MANIFEST).manifest!;
  const catalog = [catalogEntryFromManifest(manifest, "sha256:abc")];
  const spec = (extra = "") =>
    parseSpec(`version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: lookup
      action: component
      use: acme/tickets@1.0.0
      op: get
      with: { id: "1" }${extra}
  workflow:
    - step: fetch
      type: tool
      tool: lookup
`).spec!;

  it("offers the scalar top-level output fields of earlier component steps, as the engine can resolve them", () => {
    expect(outputReferenceOptions(spec(), catalog)).toEqual([
      { reference: "{{ fetch.status }}", label: "fetch.status (string)" },
      { reference: "{{ fetch.priority }}", label: "fetch.priority (integer)" },
    ]);
  });

  it("offers nothing when extract changes the output shape, or the component is not in the catalog", () => {
    expect(outputReferenceOptions(spec("\n      extract: status"), catalog)).toEqual([]);
    expect(outputReferenceOptions(spec(), [])).toEqual([]);
  });
});
