import { describe, expect, it } from "vitest";
import { ensurePragma, hasPragma } from "../../src/pragma.js";

describe("yaml-language-server pragma", () => {
  it("prepends the pragma to a spec with none", () => {
    const out = ensurePragma('version: "1.0"\n', "./agent-spec.v1.0.schema.json");

    expect(out.startsWith("# yaml-language-server: $schema=./agent-spec.v1.0.schema.json")).toBe(
      true,
    );
    expect(hasPragma(out)).toBe(true);
  });

  it("replaces an existing pragma rather than duplicating it", () => {
    const withOld = ensurePragma('version: "1.0"\n', "./old.json");
    const updated = ensurePragma(withOld, "./new.json");

    expect(updated.match(/yaml-language-server/g)).toHaveLength(1);
    expect(updated).toContain("$schema=./new.json");
  });
});
