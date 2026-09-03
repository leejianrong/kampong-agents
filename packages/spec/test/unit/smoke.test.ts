import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, parseYamlDocument } from "../../src/index.js";

describe("@kampong/spec scaffolding", () => {
  it("resolves the package entry point", () => {
    expect(PACKAGE_NAME).toBe("@kampong/spec");
  });

  it("preserves comments on parse (ADR-0007: yaml over js-yaml)", () => {
    const doc = parseYamlDocument("# a hand-written comment\nname: refund-agent\n");
    expect(String(doc)).toContain("# a hand-written comment");
  });
});
