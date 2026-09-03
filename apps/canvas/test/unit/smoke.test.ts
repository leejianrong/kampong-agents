import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../../src/index.js";

describe("@kampong/canvas-app scaffolding", () => {
  it("resolves the package entry point", () => {
    expect(PACKAGE_NAME).toBe("@kampong/canvas-app");
  });
});
