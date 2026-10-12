import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { generateAgentSpecJsonSchema } from "../../src/json-schema.js";
import { VALID_FIXTURE_BRANCH } from "../fixtures-branch.js";

// KAN-1859 (ADR-0045): the `branch` and `stop` steps, version 1.1 only.

const specWith = (version: string, steps: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.example/"
    - name: risky
      action: http_request
      method: POST
      url: "https://x.example/"
      requires_approval: true
  workflow:
    - step: first
      action: fetch
${steps}`;

const errorsOf = (source: string) => parseSpec(source).errors;
// The text of a 1-based line, so a test says what the error points at instead of counting lines.
const at = (source: string, line: number | undefined) =>
  source.split("\n")[(line ?? 0) - 1]?.trim();
const messages = (source: string) => errorsOf(source).map((e) => e.message);

const ifBranch = (then: string, extra = "") =>
  `    - step: pick\n      branch:\n        if: "first.ok = true"\n        then:\n${then}${extra}`;
const tool = (name: string, indent = 10) =>
  `${" ".repeat(indent)}- step: ${name}\n${" ".repeat(indent)}  type: tool\n${" ".repeat(indent)}  tool: t\n`;

describe("branch: fixture", () => {
  it("parses and re-serializes byte-for-byte", () => {
    const r = parseSpec(VALID_FIXTURE_BRANCH);
    expect(r.errors).toEqual([]);
    expect(toYamlString(r.doc)).toBe(VALID_FIXTURE_BRANCH);
  });

  it("a canvas mutation of a nested field touches one line only", () => {
    const { doc } = parseSpec(VALID_FIXTURE_BRANCH);
    applyPatch(doc, [
      {
        op: "set",
        path: ["agent", "workflow", 1, "branch", "default", 0, "branch", "if"],
        value: "$length(classify.text) > 10",
      },
    ]);
    const out = toYamlString(doc);
    expect(out).toContain("# Triage");
    const before = VALID_FIXTURE_BRANCH.split("\n");
    expect(out.split("\n").filter((l, i) => l !== before[i])).toHaveLength(1);
    expect(parseSpec(out).errors).toEqual([]);
  });

  it("is in the published JSON Schema", () => {
    const schema = JSON.stringify(generateAgentSpecJsonSchema());
    expect(schema).toContain('"branch"');
    expect(schema).toContain('"stop"');
  });
});

describe("branch: shape", () => {
  it("accepts if with and without else, and switch with and without default", () => {
    expect(errorsOf(specWith("1.1", ifBranch(tool("a"))))).toEqual([]);
    expect(errorsOf(specWith("1.1", ifBranch(tool("a"), `        else:\n${tool("b")}`)))).toEqual(
      [],
    );
    const sw = (rest: string) =>
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        switch: "first.kind"\n        cases:\n          one:\n${tool("a", 12)}${rest}`,
      );
    expect(errorsOf(sw(""))).toEqual([]);
    expect(errorsOf(sw(`        default:\n${tool("b", 10)}`))).toEqual([]);
  });

  it("needs version 1.1 for branch and for stop, at their own lines", () => {
    const errors = errorsOf(
      specWith(
        "1.0",
        `${ifBranch(tool("a"))}    - step: halt\n      stop:\n        reason: done\n`,
      ),
    );
    expect(errors.map((e) => e.message)).toEqual([
      'branch needs version "1.1"',
      'stop needs version "1.1"',
    ]);
    expect(errors.map((e) => e.line)).toEqual([22, 29]);
  });

  it("a stop takes an optional reason and a completed or skipped status", () => {
    const stop = (body: string) => specWith("1.1", `    - step: halt\n      stop:${body}\n`);
    expect(errorsOf(stop(" {}"))).toEqual([]);
    expect(errorsOf(stop("\n        reason: nothing to do\n        status: completed"))).toEqual(
      [],
    );
    expect(errorsOf(stop("\n        status: failed")).length).toBeGreaterThan(0);
  });

  it("mixing if and switch is an error at the extra key", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        if: "true"\n        switch: "first.kind"\n        then:\n${tool("a")}`,
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.line).toBeDefined();
  });

  it("a malformed nested step is reported at its own line, not the branch's", () => {
    const src = specWith("1.1", ifBranch("          - step: broken\n            type: tool\n"));
    const errors = errorsOf(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(at(src, errors[0]!.line)).toBe("- step: broken");
  });
});

describe("branch: validation", () => {
  it("rejects an empty then, else, case or default, at the arm's line", () => {
    const emptyThen = errorsOf(specWith("1.1", ifBranch("          []\n")));
    expect(emptyThen.map((e) => e.message)).toEqual([
      expect.stringMatching(/empty branch: "then"/),
    ]);
    expect(emptyThen[0]!.line).toBe(24);

    const emptyElse = errorsOf(specWith("1.1", ifBranch(tool("a"), "        else: []\n")));
    expect(emptyElse.map((e) => e.message)).toEqual([
      expect.stringMatching(/empty branch: "else"/),
    ]);

    const sw = errorsOf(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        switch: "first.kind"\n        cases:\n          one: []\n          two:\n${tool("a", 12)}        default: []\n`,
      ),
    );
    expect(sw.map((e) => e.message)).toEqual([
      expect.stringMatching(/empty branch: "one"/),
      expect.stringMatching(/empty branch: "default"/),
    ]);
  });

  it("rejects a switch with no cases", () => {
    const errors = messages(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        switch: "first.kind"\n        cases: {}\n`,
      ),
    );
    expect(errors).toEqual(["cases needs at least one case"]);
  });

  it('rejects duplicate case values, including 1 and "1" that a switch would read as one', () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        switch: "first.n"\n        cases:\n          1:\n${tool("a", 12)}          "1":\n${tool("b", 12)}`,
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/duplicate case "1"/);
    expect(errors[0]!.line).toBe(28); // the "1" key
  });

  it("rejects a repeated step name across branches and against the workflow", () => {
    const across = errorsOf(specWith("1.1", ifBranch(tool("a"), `        else:\n${tool("a")}`)));
    expect(across.map((e) => e.message)).toEqual([
      expect.stringMatching(/duplicate step name "a"/),
    ]);
    expect(across[0]!.line).toBe(28);
    const outside = messages(specWith("1.1", ifBranch(tool("first"))));
    expect(outside).toEqual([expect.stringMatching(/duplicate step name "first"/)]);
    const reserved = messages(specWith("1.1", ifBranch(tool("trigger"))));
    expect(reserved.join("\n")).toMatch(/reserved name/);
  });

  it("rejects a step after a stop in the same list, and after a branch whose every arm stops", () => {
    const afterStop = errorsOf(
      specWith("1.1", ifBranch(`          - step: halt\n            stop: {}\n${tool("late")}`)),
    );
    expect(afterStop.map((e) => e.message)).toEqual([
      expect.stringMatching(/unreachable step "late".*"halt"/),
    ]);
    expect(afterStop[0]!.line).toBe(26); // the late step

    const stops = (extra: string) =>
      specWith(
        "1.1",
        `${ifBranch("          - step: s1\n            stop: {}\n", "        else:\n          - step: s2\n            stop: {}\n")}${extra}`,
      );
    expect(messages(stops("    - step: after\n      type: tool\n      tool: t\n"))).toEqual([
      expect.stringMatching(/unreachable step "after".*"pick"/),
    ]);
    // Without an else, the branch may fall through, so what follows is reachable.
    expect(
      errorsOf(
        specWith(
          "1.1",
          `${ifBranch("          - step: s1\n            stop: {}\n")}${"    - step: after\n      type: tool\n      tool: t\n"}`,
        ),
      ),
    ).toEqual([]);
  });

  it("rejects an expression that reads a step of a sibling arm, but allows it after the branch", () => {
    const ref = (inElse: string) =>
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        if: "first.ok = true"\n        then:\n          - step: a\n            type: transform\n            set:\n              x: "1"\n        else:\n          - step: b\n            type: transform\n            set:\n              y: "${inElse}"\n    - step: after\n      type: transform\n      set:\n        z: "a.x"\n`,
      );
    expect(errorsOf(ref("2"))).toEqual([]);
    const errors = errorsOf(ref("a.x"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/"a" is a step in another arm of branch "pick"/);
    expect(errors[0]!.line).toBe(32); // the y expression
  });

  it("a branch condition cannot read the steps in its own arms", () => {
    const errors = messages(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        if: "a.ok"\n        then:\n          - step: a\n            type: transform\n            set:\n              x: "1"\n`,
      ),
    );
    expect(errors).toEqual([
      expect.stringMatching(/"a" is a step in another arm of branch "pick"/),
    ]);
  });

  it("checks expressions in a nested step with the line they are on", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        ifBranch(
          '          - step: a\n            type: transform\n            set:\n              x: "nope.field"\n',
        ),
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/"nope" is not something an expression can read/);
    expect(errors[0]!.line).toBe(27); // the x expression
  });

  it("checks the branch's own if and switch expressions", () => {
    const bad = errorsOf(
      specWith(
        "1.1",
        `    - step: pick\n      branch:\n        if: "first.ok ="\n        then:\n${tool("a")}`,
      ),
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]!.line).toBe(22); // the branch if
  });

  it("keeps on_fail: branch rejected, pointing at the branch step", () => {
    const errors = messages(
      specWith(
        "1.1",
        "    - step: check\n      type: validate\n      assert: 'first.ok = true'\n      on_fail: branch\n",
      ),
    );
    expect(errors).toEqual([expect.stringMatching(/on_fail: branch is not supported.*ADR-0045/)]);
  });
});

describe("branch: nesting", () => {
  const loopWith = (inner: string) =>
    specWith(
      "1.1",
      `    - step: each\n      foreach:\n        items: "trigger.list"\n        as: item\n        steps:\n${inner}`,
    );

  it("a foreach inside a branch arm is fine", () => {
    expect(
      errorsOf(
        specWith(
          "1.1",
          ifBranch(
            `          - step: each\n            foreach:\n              items: "trigger.list"\n              as: item\n              steps:\n                - step: inner\n                  type: tool\n                  tool: t\n`,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("a branch inside a foreach body is fine, and a stop there ends only the item", () => {
    expect(
      errorsOf(
        loopWith(
          `          - step: pick\n            branch:\n              if: "item.skip = true"\n              then:\n                - step: halt\n                  stop:\n                    reason: "skip {{ item.id }}"\n              else:\n                - step: inner\n                  type: tool\n                  tool: t\n`,
        ),
      ),
    ).toEqual([]);
  });

  it("a foreach inside a branch inside a foreach is still a nested foreach", () => {
    const errors = messages(
      loopWith(
        `          - step: pick\n            branch:\n              if: "true"\n              then:\n                - step: deep\n                  foreach:\n                    items: "item.xs"\n                    as: x\n                    steps:\n                      - step: z\n                        type: tool\n                        tool: t\n`,
      ),
    );
    expect(errors).toEqual(["a foreach inside a foreach is not supported yet"]);
  });

  it("approvals in a branch inside a foreach body are refused like any in the body", () => {
    const errors = messages(
      loopWith(
        `          - step: pick\n            branch:\n              if: "true"\n              then:\n                - step: ask\n                  type: approval\n                - step: go\n                  type: tool\n                  tool: risky\n`,
      ),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/approval step is not supported inside a foreach body/);
    expect(errors[1]).toMatch(/requires approval/);
  });

  it("approvals in a top-level branch are allowed", () => {
    expect(
      errorsOf(
        specWith(
          "1.1",
          ifBranch(
            `          - step: ask\n            type: approval\n            message: "ok?"\n          - step: go\n            type: tool\n            tool: risky\n`,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("a branch nested in a branch is fine and its names must still be unique", () => {
    const inner = `          - step: deep\n            branch:\n              if: "true"\n              then:\n                - step: a\n                  type: tool\n                  tool: t\n`;
    expect(errorsOf(specWith("1.1", ifBranch(inner)))).toEqual([]);
    expect(messages(specWith("1.1", ifBranch(inner, `        else:\n${tool("a")}`)))).toEqual([
      expect.stringMatching(/duplicate step name "a"/),
    ]);
  });

  it("body step names inside a branch in a loop cannot collide with the loop's names", () => {
    const errors = messages(
      loopWith(
        `          - step: pick\n            branch:\n              if: "true"\n              then:\n                - step: item\n                  type: tool\n                  tool: t\n`,
      ),
    );
    expect(errors).toEqual([
      expect.stringMatching(/"item" cannot be used as a step name inside a foreach/),
    ]);
  });
});
