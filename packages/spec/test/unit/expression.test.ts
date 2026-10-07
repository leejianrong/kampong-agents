import { describe, expect, it } from "vitest";
import {
  expressionPaths,
  MAX_EXPRESSION_LENGTH,
  parseExpression,
  templateExpressions,
} from "../../src/expression.js";

// KAN-1840: the parse-time rules for an expression (ADR-0027, spike result).

const ok = (source: string) => {
  const parsed = parseExpression(source);
  if (!parsed.ok)
    throw new Error(`expected "${source}" to parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.ast;
};
const errorsOf = (source: string) => {
  const parsed = parseExpression(source);
  return parsed.ok ? [] : parsed.errors;
};

describe("parseExpression", () => {
  it.each([
    "alerts[0].labels.alertname",
    "$abs(change) >= vars.threshold",
    "$count(plan.specialists) = 0",
    "$sort(series, function($a,$b){$a.t < $b.t})[-1]",
    "$sum(items.(price * qty))",
    "($x := a + 1; $x * 2)",
  ])("accepts %s", (source) => {
    expect(parseExpression(source).ok).toBe(true);
  });

  it("refuses an empty expression and one that is too long", () => {
    expect(errorsOf("   ")[0]!.message).toMatch(/empty/);
    expect(errorsOf("1+".repeat(MAX_EXPRESSION_LENGTH))[0]!.message).toMatch(/limit is 4000/);
  });

  it.each(["now", "millis", "random", "shuffle", "eval"])(
    "refuses $%s, which is not a function of the input alone",
    (name) => {
      const found = errorsOf(`$${name}()`);
      expect(found.some((e) => e.code === "E0003" && e.message.includes(`$${name}`))).toBe(true);
    },
  );

  it("refuses them however they are reached: aliased, passed as a value, or inside a lambda", () => {
    for (const source of [
      "($f := $now; $f())",
      "$map([1,2], $random)",
      "$map(a, function($v){ $shuffle([$v]) })",
      "a.$millis()",
    ]) {
      expect(
        errorsOf(source).some((e) => e.code === "E0003"),
        source,
      ).toBe(true);
    }
  });

  it("refuses a regular expression, which cannot be interrupted", () => {
    const found = errorsOf("$match(body, /fix (\\d+)/)");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "E0004" });
    expect(found[0]!.position).toBeGreaterThan(0);
  });

  it("reports a syntax error with its code, a position, and a line and column", () => {
    const [error] = errorsOf("a +\n  b +\n  )");
    expect(error).toMatchObject({ code: "S0211", position: 13, line: 3, column: 4 });
  });

  it("returns a plain error object, never a thrown value", () => {
    for (const source of ["$count(items", "a + * b", '"unterminated', ")"]) {
      const found = errorsOf(source);
      expect(found.length, source).toBeGreaterThan(0);
      expect(found[0]!.code, source).toMatch(/^S\d+/);
      expect(typeof found[0]!.message).toBe("string");
    }
  });

  it("does not throw on the deeply nested source that overflows the parser", () => {
    const deep = "(".repeat(2500) + "1" + ")".repeat(2500);
    expect(() => parseExpression(deep)).not.toThrow();
    expect(parseExpression(deep).ok).toBe(false);
  });
});

describe("expressionPaths", () => {
  const paths = (source: string) => expressionPaths(ok(source));

  it("lists what an expression reads from the root", () => {
    expect(paths("$abs(trigger.change) >= vars.threshold")).toEqual([
      ["trigger", "change"],
      ["vars", "threshold"],
    ]);
  });

  it("sees a step id as the root, and follows the names through an index", () => {
    expect(paths("review.findings[0].title")).toEqual([["review", "findings", "title"]]);
  });

  it("does not take names inside a filter, a lambda or a .(…) step for reads of the root", () => {
    expect(paths("items[price > limit].name")).toEqual([["items", "name"]]);
    expect(paths("$map(files, function($f){ $f.path & suffix })")).toEqual([["files"]]);
    expect(paths("$sum(items.(price * qty))")).toEqual([["items"]]);
  });

  it("does not take names inside a transform for reads of the root", () => {
    expect(paths("trigger ~> | items | {'x': 1} |")).toEqual([["trigger"]]);
    expect(paths("trigger.a ~> | nope | {}, ['gone'] |")).toEqual([["trigger", "a"]]);
  });

  it("finds reads in a condition, an object constructor and function arguments alike", () => {
    expect(paths('{"n": $count(a.b), "ok": c = 1}')).toEqual([["a", "b"], ["c"]]);
  });
});

describe("templateExpressions", () => {
  it("finds each {{ }} span and where its expression starts", () => {
    expect(templateExpressions("a {{ x.y }} b {{z}}")).toEqual([
      { expression: " x.y ", offset: 4 },
      { expression: "z", offset: 16 },
    ]);
  });

  it("reads a nested object constructor and a string holding }} whole", () => {
    expect(templateExpressions("x {{ {'a':{'b':1}}.a }} y").map((t) => t.expression)).toEqual([
      " {'a':{'b':1}}.a ",
    ]);
    expect(templateExpressions("{{ 'a}}b' }} and {{ \"c}}\" }}").map((t) => t.expression)).toEqual([
      " 'a}}b' ",
      ' "c}}" ',
    ]);
    expect(templateExpressions("{{ 'it\\'s }}' }}").map((t) => t.expression)).toEqual([
      " 'it\\'s }}' ",
    ]);
  });

  it("treats an opening {{ with no end as plain text, and keeps reading after one that closes", () => {
    expect(templateExpressions("a {{ b")).toEqual([]);
    expect(templateExpressions("{{ a }} then {{ b")).toEqual([{ expression: " a ", offset: 2 }]);
  });

  it("finds none in text without them, or in a single-brace placeholder or a secret", () => {
    expect(templateExpressions("{x.y} ${TOKEN} plain")).toEqual([]);
  });
});
