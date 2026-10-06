import { describe, expect, it } from "vitest";
import { parseComponentManifest } from "../../src/component.js";

// KAN-1836 (ADR-0032): a secret slot may name a read-only probe op that `kampong doctor --probe` calls
// to prove the credential is accepted. The manifest check keeps a probe honest.

const REST = (probe: string, ops = "") => `kind: rest
id: acme/api
version: 1.0.0
permissions: { egress: [api.example.test] }
auth:
  slots:
    token:
      env: ACME_TOKEN
      hosts: [api.example.test]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
      probe: ${probe}
ops:
  whoami:
    effect: read
    request: { method: GET, url: "https://api.example.test/whoami" }
  create:
    effect: write
    request: { method: POST, url: "https://api.example.test/things" }
  lookup:
    effect: read
    input: { type: object, required: [id], properties: { id: { type: string } } }
    request: { method: GET, url: "https://api.example.test/things/{{ input.id }}" }
${ops}`;

const errors = (text: string) => {
  const result = parseComponentManifest(text);
  return result.success ? [] : result.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
};

describe("slot probe", () => {
  it("accepts a read op that sends the slot", () => {
    expect(errors(REST("{ op: whoami }"))).toEqual([]);
  });

  it("accepts a probe op whose required input is given under with", () => {
    expect(errors(REST("{ op: lookup, with: { id: abc } }"))).toEqual([]);
  });

  it("rejects an op the component does not have", () => {
    expect(errors(REST("{ op: nope }")).join("\n")).toContain("which this component does not have");
  });

  it("rejects a probe that is not a read op, so checking a credential can never change anything", () => {
    expect(errors(REST("{ op: create }")).join("\n")).toContain("must have effect: read");
  });

  it("rejects a probe that needs input it was not given", () => {
    expect(errors(REST("{ op: lookup }")).join("\n")).toContain('needs input "id"');
  });

  it("rejects a rest probe op that does not send the slot, since it would prove nothing", () => {
    const manifest = REST("{ op: whoami }").replace(
      'request: { method: GET, url: "https://api.example.test/whoami" }',
      'request: { method: GET, url: "https://api.example.test/whoami" }\n    slots: []',
    );
    expect(errors(manifest).join("\n")).toContain("does not send slot");
  });

  it("rejects unknown keys inside probe", () => {
    expect(errors(REST("{ op: whoami, run: x }")).length).toBeGreaterThan(0);
  });

  it("rejects a rest probe op that calls a host the slot is not bound to", () => {
    const manifest = REST("{ op: whoami }").replace(
      'url: "https://api.example.test/whoami"',
      'url: "https://other.example.test/whoami"',
    );
    expect(errors(manifest).join("\n")).toContain("is not bound to");
  });

  it("accepts refused_when reasons", () => {
    expect(errors(REST("{ op: whoami, refused_when: [invalid_auth] }"))).toEqual([]);
    expect(errors(REST("{ op: whoami, refused_when: [''] }")).length).toBeGreaterThan(0);
  });
});
