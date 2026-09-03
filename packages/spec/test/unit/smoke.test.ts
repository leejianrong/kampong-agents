import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../../src/index.js";

// Scaffolding smoke test: proves the unit-test layer is wired for this
// package. Replace with the real schema/validator tests in SLICES.md V1
// (round-trip property tests, field-level error reporting).
describe("@kampong/spec scaffolding", () => {
  it("resolves the package entry point", () => {
    expect(PACKAGE_NAME).toBe("@kampong/spec");
  });
});
