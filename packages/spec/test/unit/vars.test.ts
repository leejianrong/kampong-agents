import { describe, expect, it } from "vitest";
import { parseVarText, resolveVars } from "../../src/vars.js";
import type { SpecVars } from "../../src/schema.js";

// KAN-1840: what `vars.x` holds is a pure function of the declaration, the environment and overrides.

const vars: SpecVars = {
  threshold: { type: "number", default: 5 },
  region: { type: "string", default: "${REGION}" },
  tickers: { type: "list", default: ["AAPL", "MSFT"] },
  limits: { type: "list", items: "number", default: "${LIMITS}" },
  required: { type: "string" },
};

describe("resolveVars", () => {
  it("uses a literal default, and reads ${ENV} defaults from the environment", () => {
    const { values, errors } = resolveVars(
      vars,
      { REGION: "eu-west-1", LIMITS: "1, 2.5,3" },
      { required: "x" },
    );
    expect(errors).toEqual([]);
    expect(values).toEqual({
      threshold: 5,
      region: "eu-west-1",
      tickers: ["AAPL", "MSFT"],
      limits: [1, 2.5, 3],
      required: "x",
    });
  });

  it("names the environment variable when a ${ENV} default is unset or empty", () => {
    for (const env of [{}, { REGION: "" }]) {
      const { errors } = resolveVars({ region: vars.region! }, env);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(
        "vars.region: environment variable REGION is not set (it is this var's default)",
      );
    }
  });

  it("fails a var with no default and no value, rather than guessing", () => {
    const { errors, values } = resolveVars({ required: vars.required! });
    expect(values).toEqual({});
    expect(errors[0]!.message).toContain("vars.required: no value");
  });

  it("lets an override win, as text parsed like the environment or already typed", () => {
    const { values, errors } = resolveVars(
      vars,
      { REGION: "x", LIMITS: "1" },
      {
        threshold: "7.5",
        tickers: "GOOG,AMZN",
        required: "r",
      },
    );
    expect(errors).toEqual([]);
    expect(values.threshold).toBe(7.5);
    expect(values.tickers).toEqual(["GOOG", "AMZN"]);
    expect(resolveVars({ n: { type: "number" } }, {}, { n: 3 }).values.n).toBe(3);
  });

  it("rejects an override of the wrong type, and an unparseable value, naming the var and the source", () => {
    const a = resolveVars({ n: { type: "number" } }, {}, { n: true });
    expect(a.errors[0]!.message).toBe("vars.n: the value given for it is not a number");
    const b = resolveVars({ n: { type: "number", default: "${N}" } }, { N: "lots" });
    expect(b.errors[0]!.message).toBe(
      'vars.n: environment variable N: "lots" is not a number (expected a number)',
    );
  });

  it("does not treat a ${ENV} string given as an override as a placeholder", () => {
    const { values } = resolveVars({ s: { type: "string" } }, { X: "leaked" }, { s: "${X}" });
    expect(values.s).toBe("${X}");
  });

  it("holds values with no prototype, so a var named toString or constructor is just a var", () => {
    const { values } = resolveVars({ constructor: { type: "number", default: 1 } });
    expect(values.constructor).toBe(1);
    expect(Object.getPrototypeOf(values)).toBeNull();
  });

  it("is empty for a spec with no vars", () => {
    expect(resolveVars(undefined)).toEqual({ values: {}, errors: [] });
  });
});

describe("parseVarText", () => {
  const list = { type: "list" as const };
  it("reads a list as comma-separated text or a JSON array, dropping blanks", () => {
    expect(parseVarText(list, "a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(parseVarText(list, '["a", "b"]')).toEqual(["a", "b"]);
    expect(parseVarText({ ...list, items: "number" }, "[1, 2]")).toEqual([1, 2]);
  });

  it("rejects what is not the declared type", () => {
    expect(parseVarText({ ...list, items: "number" }, "1,x")).toEqual({
      error: '"x" in the list is not a number',
    });
    expect(parseVarText(list, "[1")).toEqual({ error: '"[1" is not a valid JSON list' });
    expect(parseVarText({ type: "number" }, "")).toEqual({ error: '"" is not a number' });
    expect(parseVarText({ type: "number" }, "Infinity")).toEqual({
      error: '"Infinity" is not a number',
    });
  });
});
