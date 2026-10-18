import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";
import { diffLines, previewUpgradeTo11 } from "../../src/upgrade.js";
import { applyPatchToSource } from "../../src/repository.js";

// KAM-199: upgrading a version 1.0 spec to 1.1 keeps its meaning (placeholders and conditions are rewritten),
// shows a diff first, and refuses to produce a spec that would not load.

const V10 = `# my spec
version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://x.example/orders/{classify.label}?q={{ input }}"
    - name: refund
      action: http_request
      method: POST
      url: "https://x.example/refunds"
  workflow:
    - step: classify
      action: classify
      inputs: [input]
    - step: gate
      type: condition
      if: 'classify.label == "refund"'
      then: execute_tool(refund)
      else: request_human_approval
`;

describe("previewUpgradeTo11", () => {
  it("rewrites a placeholder and a condition so they keep their meaning, and the result loads as 1.1", () => {
    const r = previewUpgradeTo11(V10);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.source).toContain('version: "1.1"');
    expect(r.source).toContain("orders/{{ classify.label }}?q={{ input }}");
    expect(r.source).toContain(`if: 'classify.label = "refund"'`);
    expect(r.source.startsWith("# my spec\n")).toBe(true);
    expect(parseSpec(r.source).errors).toEqual([]);
    expect(r.notes.map((n) => n.message)).toEqual([
      'Condition "gate": classify.label == "refund" becomes classify.label = "refund"',
      'Tool "lookup".url: {classify.label} becomes {{ … }}',
    ]);
  });

  it("returns the ops, and applying them is the same as the previewed source", () => {
    const r = previewUpgradeTo11(V10);
    if (!r.success) throw new Error("expected success");
    const applied = applyPatchToSource(V10, r.ops);
    expect(applied.success && applied.source).toBe(r.source);
  });

  it("shows the changed lines with context, and nothing else", () => {
    const r = previewUpgradeTo11(V10);
    if (!r.success) throw new Error("expected success");
    const changed = r.diff.filter((l) => l.kind !== "same");
    expect(changed.map((l) => `${l.kind}:${l.text.trim()}`)).toEqual([
      'del:version: "1.0"',
      'add:version: "1.1"',
      'del:url: "https://x.example/orders/{classify.label}?q={{ input }}"',
      'add:url: "https://x.example/orders/{{ classify.label }}?q={{ input }}"',
      `del:if: 'classify.label == "refund"'`,
      `add:if: 'classify.label = "refund"'`,
    ]);
  });

  it("upgrades a spec that only needs the version changed with a one-line diff", () => {
    const r = previewUpgradeTo11(`version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: s
      action: write
`);
    if (!r.success) throw new Error("expected success");
    expect(r.notes).toEqual([]);
    expect(r.diff.filter((l) => l.kind !== "same")).toEqual([
      { kind: "del", text: 'version: "1.0"' },
      { kind: "add", text: 'version: "1.1"' },
    ]);
  });

  it("refuses when the spec would not load as 1.1, and says where", () => {
    const r = previewUpgradeTo11(V10.replace('classify.label == "refund"', "nosuch.label == 1"));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errors[0]!.message).toMatch(/nosuch/);
    expect(r.errors[0]!.line).toBeGreaterThan(0);
  });

  it("refuses a bare {name} placeholder, which 1.1 cannot resolve, and names it", () => {
    const r = previewUpgradeTo11(V10.replace("{classify.label}", "{order_id}"));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.errors[0]!.message).toMatch(/order_id/);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("refuses a condition that is not the old grammar instead of guessing", () => {
    const r = previewUpgradeTo11(V10.replace('classify.label == "refund"', "is it a refund"));
    expect(r.success).toBe(false);
  });

  it("says a 1.1 spec is already upgraded, and passes on a spec that does not parse", () => {
    const up = previewUpgradeTo11(V10.replace('version: "1.0"', 'version: "1.1"'));
    expect(up.success).toBe(false);
    expect(!up.success && up.errors[0]!.message).toMatch(/already version "1.1"/);
    expect(previewUpgradeTo11("version: [").success).toBe(false);
  });
});

describe("diffLines", () => {
  it("is empty of changes for equal text", () => {
    expect(diffLines("a\nb", "a\nb").some((l) => l.kind !== "same")).toBe(false);
  });
  it("keeps two lines of context around a change", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const after = ["1", "2", "3", "X", "5", "6", "7"].join("\n");
    expect(diffLines(before, after).map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:2",
      "same:3",
      "del:4",
      "add:X",
      "same:5",
      "same:6",
    ]);
  });
});
