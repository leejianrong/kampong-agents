import { describe, expect, it } from "vitest";
import {
  DENIED_FUNCTIONS as SPEC_DENIED,
  parseExpression,
  templateExpressions,
} from "@kampong/spec";
import {
  DEFAULT_EXPRESSION_LIMITS,
  DENIED_FUNCTIONS,
  evaluateCondition,
  evaluateExpression,
  ExpressionError,
  resolveTemplate,
  resolveTemplatesDeep,
  templateSpans,
} from "../../src/expressions.js";

// KAN-1841: the evaluator contract the JSONata spike (KAN-1839) set out: pure, bounded, located.

const errorOf = async (source: string, data: unknown = {}, limits = {}) => {
  const err = await evaluateExpression(source, data, limits).catch((e) => e);
  expect(err, source).toBeInstanceOf(ExpressionError);
  return err as ExpressionError;
};

describe("evaluating", () => {
  const data = {
    trigger: { alerts: [{ labels: { alertname: "HighCPU" } }], change: -7 },
    vars: { threshold: 5 },
    review: { findings: [{ title: "a" }, { title: "b" }] },
  };

  it("reads paths, indexes, arithmetic and functions over the data", async () => {
    expect(await evaluateExpression("trigger.alerts[0].labels.alertname", data)).toBe("HighCPU");
    expect(await evaluateExpression("$abs(trigger.change) >= vars.threshold", data)).toBe(true);
    expect(await evaluateExpression("$count(review.findings) * 2", data)).toBe(4);
    expect(await evaluateExpression("review.findings.title", data)).toEqual(["a", "b"]);
    expect(await evaluateExpression("$sum([1,2,3]) & ' items'", data)).toBe("6 items");
  });

  it("gives undefined, not an error, for a path that finds nothing", async () => {
    expect(await evaluateExpression("trigger.missing.deeper", data)).toBeUndefined();
  });

  it("is repeatable: the same expression and data give the same result every time", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        evaluateExpression("$sort(review.findings.title, function($a,$b){$a < $b})", data),
      ),
    );
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("cannot reach the host: no prototype, no global", async () => {
    for (const source of [
      "$.constructor",
      '$."__proto__"',
      "constructor",
      "$process",
      "$globalThis",
    ]) {
      const value = await evaluateExpression(source, { a: {} }).catch(() => undefined);
      expect(value, source).toBeUndefined();
    }
  });

  it("refuses an expression that evaluates to a function", async () => {
    expect((await errorOf("function($x){$x}")).code).toBe("K0007");
  });
});

describe("what is refused", () => {
  it.each(["now", "millis", "random", "shuffle", "eval"])(
    "$%s, however it is reached",
    async (name) => {
      for (const source of [`$${name}()`, `($f := $${name}; $f())`, `$map([1], $${name})`]) {
        expect((await errorOf(source)).code, source).toBe("K0003");
      }
    },
  );

  it("regular expressions, which cannot be interrupted", async () => {
    const err = await errorOf('$match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", /^(a+)+$/)');
    expect(err.code).toBe("K0004");
  });

  it("an empty expression and one over the length limit", async () => {
    expect((await errorOf("  ")).code).toBe("K0001");
    expect((await errorOf("1+".repeat(3000))).code).toBe("K0002");
  });

  it("keeps its list of denied built-ins in step with the validator's", () => {
    expect([...DENIED_FUNCTIONS]).toEqual([...SPEC_DENIED]);
    expect(DEFAULT_EXPRESSION_LIMITS.sourceChars).toBe(4000);
  });
});

describe("limits", () => {
  it("stops an infinite recursion", async () => {
    const err = await errorOf("($f := function($x){$f($x+1)}; $f(0))", {}, { timeoutMs: 200 });
    expect(["D1011", "D1012"]).toContain(err.code);
  });

  it("stops a non-tail recursion at the depth limit", async () => {
    const err = await errorOf(
      "($f := function($x){$x < 5000 ? 1 + $f($x+1) : 0}; $f(0))",
      {},
      { stack: 100 },
    );
    expect(err.code).toBe("D1011");
  });

  it("stops work that runs too long", async () => {
    const err = await errorOf(
      "$count($map([1..4000], function($v){ $count($map([1..4000], function($w){$w})) }))",
      {},
      { timeoutMs: 100 },
    );
    expect(err.code).toBe("D1012");
  });

  it("stops work that takes too many steps", async () => {
    const err = await errorOf(
      "$reduce([1..100000], function($a,$b){$a+$b})",
      {},
      { steps: 1000, timeoutMs: 10_000 },
    );
    expect(err.code).toBe("K0005");
  });

  it("refuses a list or a string larger than the limit, before it can grow further", async () => {
    expect((await errorOf("[1..300000]", {}, { listItems: 1000 })).code).toBe("K0006");
    expect(
      (
        await errorOf(
          '$join($map([1..2000], function($v){"xxxxxxxxxx"}))',
          {},
          { stringChars: 1000 },
        )
      ).code,
    ).toBe("K0006");
  });

  it("caps $pad up front, because it allocates before any hook can see the result", async () => {
    const err = await errorOf('$pad("x", 400000000)');
    expect(err.code).toBe("K0006");
  });
});

describe("errors say where", () => {
  it("a syntax error carries its code, character, line and column, and the expression", async () => {
    const err = await errorOf("a +\n  b +\n  )");
    expect(err).toMatchObject({ code: "S0211", position: 13, line: 3, column: 4 });
    expect(err.expression).toBe("a +\n  b +\n  )");
    expect(err.message).toContain("(character 13)");
  });

  it("a run-time error carries its code and character", async () => {
    expect(await errorOf('"a" + 1')).toMatchObject({ code: "T2001", position: 5 });
    expect(await errorOf("$nope(1)")).toMatchObject({ code: "T1006" });
  });

  it("is always an ExpressionError, never a bare thrown object", async () => {
    for (const source of ["$count(items", '"unterminated', ")", "$count(1,2,3)"]) {
      expect(await errorOf(source, { items: [] }), source).toBeInstanceOf(Error);
    }
  });
});

describe("conditions", () => {
  it("accept a boolean", async () => {
    expect(await evaluateCondition("a > 1", { a: 2 })).toBe(true);
    expect(await evaluateCondition("a > 1", { a: 0 })).toBe(false);
  });

  it("fail on nothing, and on anything that is not true or false", async () => {
    expect((await evaluateCondition("a.missing", { a: {} }).catch((e) => e)).code).toBe("K0008");
    expect((await evaluateCondition("a", { a: 1 }).catch((e) => e)).code).toBe("K0009");
    expect((await evaluateCondition("a", { a: [true] }).catch((e) => e)).message).toMatch(
      /not a list|list/,
    );
  });

  it("let $boolean say what truthiness is meant", async () => {
    expect(await evaluateCondition("$boolean(a)", { a: "x" })).toBe(true);
    expect(await evaluateCondition("$exists(a.missing)", { a: {} })).toBe(false);
    // JSONata's $boolean of nothing is nothing, so a missing name is still an error there.
    expect((await evaluateCondition("$boolean(a.missing)", { a: {} }).catch((e) => e)).code).toBe(
      "K0008",
    );
  });
});

describe("templates", () => {
  const data = { n: 3, ok: true, list: [1, 2], obj: { k: "v" }, s: "hi", trigger: { id: "A1" } };

  it("find each span, and read nested braces and strings holding }} whole", () => {
    expect(templateSpans("a {{ x }} b {{ y }}").map((t) => t.expression)).toEqual([" x ", " y "]);
    expect(templateSpans("{{ {'a':{'b':1}}.a }}").map((t) => t.expression)).toEqual([
      " {'a':{'b':1}}.a ",
    ]);
    expect(templateSpans("{{ 'a}}b' }}")).toHaveLength(1);
    expect(templateSpans("a {{ b")).toEqual([]);
  });

  it("agree with the validator's scanner on every string", () => {
    for (const text of [
      "a {{ x.y }} b {{z}}",
      "{{ {'a':{'b':1}}.a }}",
      "{{ 'a}}b' }} and {{ \"c}}\" }}",
      "a {{ b",
      "{{ a }} then {{ b",
      "{x.y} ${TOKEN} plain",
      "",
    ]) {
      expect(
        templateSpans(text).map((t) => ({ expression: t.expression, offset: t.offset })),
        text,
      ).toEqual(templateExpressions(text));
    }
  });

  it("keep the type when the string is exactly one span", async () => {
    expect(await resolveTemplate("{{ n }}", data)).toBe(3);
    expect(await resolveTemplate("{{ ok }}", data)).toBe(true);
    expect(await resolveTemplate("{{ list }}", data)).toEqual([1, 2]);
    expect(await resolveTemplate("{{ obj }}", data)).toEqual({ k: "v" });
  });

  it("build text around spans: strings as they are, numbers and booleans as text, the rest as JSON", async () => {
    expect(await resolveTemplate("id={{ trigger.id }}&n={{ n }}&ok={{ ok }}", data)).toBe(
      "id=A1&n=3&ok=true",
    );
    expect(await resolveTemplate("v={{ list }} {{ obj }}", data)).toBe('v=[1,2] {"k":"v"}');
  });

  it("fail, naming the expression, when a span selects nothing", async () => {
    for (const text of ["{{ nope }}", "x {{ trigger.nope }} y"]) {
      const err = await resolveTemplate(text, data).catch((e) => e);
      expect(err, text).toBeInstanceOf(ExpressionError);
      expect(err.message).toMatch(/evaluated to nothing/);
    }
  });

  it("leave text without spans alone, and resolve every string of a structure but not its keys or skipped values", async () => {
    expect(await resolveTemplate("plain {x} ${T}", data)).toBe("plain {x} ${T}");
    const out = await resolveTemplatesDeep(
      {
        url: "u/{{ trigger.id }}",
        n: "{{ n }}",
        list: ["{{ s }}", 7],
        keep: "{{ untouched }}",
        nested: { a: "{{ ok }}" },
        k: null,
      },
      data,
      { skip: new Set(["keep"]) },
    );
    expect(out).toEqual({
      url: "u/A1",
      n: 3,
      list: ["hi", 7],
      keep: "{{ untouched }}",
      nested: { a: true },
      k: null,
    });
  });
});

describe("validator and evaluator agree", () => {
  it("on what to refuse at parse time", async () => {
    for (const source of ["$now()", "$match(a, /x/)", "a + * b", ""]) {
      const parsed = parseExpression(source);
      const err = await evaluateExpression(source, {}).catch((e) => e);
      expect(parsed.ok, source).toBe(false);
      expect(err, source).toBeInstanceOf(ExpressionError);
    }
  });
});
