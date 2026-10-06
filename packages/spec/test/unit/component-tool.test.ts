import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import {
  componentManifestJsonSchemaFilename,
  generateComponentManifestJsonSchema,
} from "../../src/json-schema.js";
import { parseComponentManifest } from "../../src/component.js";

// KAN-1884 (ADR-0029): the `action: component` tool variant and the published manifest JSON Schema.

function specWithTool(toolYaml: string): string {
  return `version: "1.0"
agent:
  id: caller
  name: "Caller"
  role: "Poster"
  goal: "Post."
  tools:
${toolYaml
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  workflow:
    - step: post
      type: tool
      tool: post
`;
}

const parse = (tool: string) => parseSpec(specWithTool(tool));

const BASE = `- name: post
  action: component
  use: acme/slack@1.2.3
  op: post_message
  with:
    channel: "#ops"
    text: "{{ input }}"`;

describe("action: component", () => {
  it("accepts the minimal shape", () => {
    const result = parse(BASE);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("accepts config, secrets, requires_approval and extract", () => {
    const result = parse(`${BASE}
  config:
    project: abc
  secrets:
    token: "\${SLACK_TOKEN}"
  requires_approval: false
  extract: ts`);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it.each([
    "acme/slack",
    "acme/slack@^1.2.3",
    "acme/slack@1.2",
    "acme/slack@latest",
    "Slack@1.0.0",
  ])("rejects use: %s (exact id@version only)", (use) => {
    const result = parse(BASE.replace("acme/slack@1.2.3", use));
    expect(result.success).toBe(false);
  });

  it("rejects a literal secret", () => {
    const result = parse(`${BASE}
  secrets:
    token: xoxb-literal`);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields and a missing op", () => {
    expect(parse(`${BASE}\n  bogus: 1`).success).toBe(false);
    expect(parse(BASE.replace("  op: post_message\n", "")).success).toBe(false);
  });
});

describe("component manifest JSON Schema", () => {
  it("is named by the manifest version", () => {
    expect(componentManifestJsonSchemaFilename()).toMatch(
      /^component-manifest\.v.+\.schema\.json$/,
    );
  });

  it("describes both manifest kinds", () => {
    const schema = JSON.stringify(generateComponentManifestJsonSchema());
    expect(schema).toContain('"rest"');
    expect(schema).toContain('"module"');
  });

  it("agrees with the parser about a minimal manifest", () => {
    const source = `kind: rest
id: acme/echo
version: 1.0.0
permissions:
  egress: [echo.example.test]
ops:
  ping:
    title: Ping
    effect: read
    request:
      method: GET
      url: "https://echo.example.test/ping"
`;
    expect(parseComponentManifest(source).errors).toEqual([]);
  });
});
