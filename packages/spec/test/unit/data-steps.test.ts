import { describe, expect, it } from "vitest";
import { applyPatch } from "../../src/mutate.js";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { VALID_FIXTURE_DATA_STEPS } from "../fixtures.js";

// KAN-1860: `transform`, `validate` and `dedupe` steps, version 1.1 only.

const specWith = (version: string, steps: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: fetch
      action: fetch_prices
${steps}`;

const errorsOf = (source: string) => parseSpec(source).errors;

describe("data steps: fixture", () => {
  it("parses and re-serializes the version 1.1 fixture byte-for-byte", () => {
    const result = parseSpec(VALID_FIXTURE_DATA_STEPS);
    expect(result.errors).toEqual([]);
    expect(toYamlString(result.doc)).toBe(VALID_FIXTURE_DATA_STEPS);
  });
});

describe("data steps: a canvas mutation", () => {
  it("changes one expression, keeps comments and the rest byte-identical, and re-parses", () => {
    const { doc } = parseSpec(VALID_FIXTURE_DATA_STEPS);
    applyPatch(doc, [
      {
        op: "set",
        path: ["agent", "workflow", 3, "set", "label"],
        value: "$join(fetch.tags, '/')",
      },
    ]);
    const out = toYamlString(doc);
    expect(out).toContain("# Nightly price move report");
    const before = VALID_FIXTURE_DATA_STEPS.split("\n");
    const after = out.split("\n");
    expect(after.filter((line, i) => line !== before[i])).toHaveLength(1);
    expect(parseSpec(out).errors).toEqual([]);
  });
});

describe("transform", () => {
  it("accepts a map of names to expressions", () => {
    const r = parseSpec(
      specWith(
        "1.1",
        `    - step: shape
      type: transform
      set:
        change: "(fetch.close - fetch.open) / fetch.open * 100"
        top: "$sort(fetch.items, function($a, $b) { $a.n > $b.n })[[0..1]]"
`,
      ),
    );
    expect(r.errors).toEqual([]);
  });

  it("needs version 1.1", () => {
    const errors = errorsOf(
      specWith("1.0", "    - step: shape\n      type: transform\n      set:\n        a: '1'\n"),
    );
    expect(errors.map((e) => e.message)).toEqual(['transform needs version "1.1"']);
    expect(errors[0]!.line).toBe(11);
  });

  it("refuses an empty set and a name that is not an identifier", () => {
    const empty = errorsOf(
      specWith("1.1", "    - step: shape\n      type: transform\n      set: {}\n"),
    );
    expect(empty.length).toBeGreaterThan(0);
    const bad = errorsOf(
      specWith("1.1", "    - step: shape\n      type: transform\n      set:\n        'a-b': '1'\n"),
    );
    expect(bad[0]!.message).toMatch(/"a-b" is not a valid name/);
    expect(bad[0]!.line).toBe(13);
  });

  it("reports a bad expression with its line and the character in it", () => {
    const errors = errorsOf(
      specWith("1.1", "    - step: shape\n      type: transform\n      set:\n        x: '1 +'\n"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/set\.x/);
    expect(errors[0]!.message).toMatch(/character/);
    expect(errors[0]!.line).toBe(13);
  });

  it("checks that a name an expression reads exists", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        "    - step: shape\n      type: transform\n      set:\n        x: 'fetchh.close'\n",
      ),
    );
    expect(errors[0]!.message).toMatch(/"fetchh" is not something an expression can read/);
    expect(errors[0]!.line).toBe(13);
  });
});

describe("validate", () => {
  it("accepts assert with on_fail fail or skip, and a message", () => {
    for (const onFail of ["fail", "skip"]) {
      const r = parseSpec(
        specWith(
          "1.1",
          `    - step: check
      type: validate
      assert: "fetch.close > 0"
      on_fail: ${onFail}
      message: "close must be positive"
`,
        ),
      );
      expect(r.errors, onFail).toEqual([]);
    }
  });

  it("defaults on_fail to fail (the field is optional)", () => {
    const r = parseSpec(
      specWith("1.1", "    - step: check\n      type: validate\n      assert: 'fetch.close > 0'\n"),
    );
    expect(r.errors).toEqual([]);
  });

  it("rejects on_fail: branch as not yet supported, at the field's line", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        "    - step: check\n      type: validate\n      assert: 'fetch.close > 0'\n      on_fail: branch\n",
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/on_fail: branch is not yet supported/);
    expect(errors[0]!.message).toMatch(/KAN-1859/);
    expect(errors[0]!.line).toBe(13);
  });

  it("rejects an unknown on_fail value", () => {
    const errors = errorsOf(
      specWith(
        "1.1",
        "    - step: check\n      type: validate\n      assert: 'fetch.close > 0'\n      on_fail: explode\n",
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("needs version 1.1", () => {
    const errors = errorsOf(
      specWith("1.0", "    - step: check\n      type: validate\n      assert: 'true'\n"),
    );
    expect(errors.map((e) => e.message)).toEqual(['validate needs version "1.1"']);
  });

  it("reports a bad assert expression with its line", () => {
    const errors = errorsOf(
      specWith("1.1", "    - step: check\n      type: validate\n      assert: '(1'\n"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/assert/);
    expect(errors[0]!.line).toBe(12);
  });
});

describe("dedupe", () => {
  const dedupe = (once: string) =>
    specWith("1.1", `    - step: seen\n      type: dedupe\n      once:\n${once}`);

  it("accepts a key expression and a ttl", () => {
    const r = parseSpec(dedupe("        key: \"trigger.id & '-' & vars.day\"\n        ttl: 24h\n"));
    // vars.day is not declared: only the declared-ness error is expected here.
    expect(r.errors.map((e) => e.message).join(" ")).toMatch(/vars\.day is not declared/);
    const ok = parseSpec(
      dedupe("        key: \"trigger.id & '-' & fetch.day\"\n        ttl: 24h\n"),
    );
    expect(ok.errors).toEqual([]);
  });

  it("needs version 1.1", () => {
    const source = dedupe("        key: 'trigger.id'\n        ttl: 1h\n").replace('"1.1"', '"1.0"');
    expect(errorsOf(source).map((e) => e.message)).toEqual(['dedupe needs version "1.1"']);
  });

  it("requires a key and a ttl", () => {
    expect(errorsOf(dedupe("        ttl: 1h\n")).length).toBeGreaterThan(0);
    expect(errorsOf(dedupe("        key: 'trigger.id'\n")).length).toBeGreaterThan(0);
  });

  it("validates the ttl as a duration and says what is wrong, on the ttl's line", () => {
    for (const ttl of ["tomorrow", "0s", "500ms", "-1h"]) {
      const errors = errorsOf(dedupe(`        key: 'trigger.id'\n        ttl: ${ttl}\n`));
      expect(errors, ttl).toHaveLength(1);
      expect(errors[0]!.message, ttl).toMatch(/ttl/);
      expect(errors[0]!.line, ttl).toBe(14);
    }
  });

  it("accepts s, m, h and d units", () => {
    for (const ttl of ["30s", "15m", "6h", "7d"]) {
      expect(errorsOf(dedupe(`        key: 'trigger.id'\n        ttl: ${ttl}\n`)), ttl).toEqual([]);
    }
  });

  it("reports a bad key expression with its line", () => {
    const errors = errorsOf(dedupe("        key: 'trigger.'\n        ttl: 1h\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/once\.key/);
    expect(errors[0]!.line).toBe(13);
  });
});
