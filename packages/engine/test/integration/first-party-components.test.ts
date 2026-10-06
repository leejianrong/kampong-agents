import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DirectoryComponentRegistry } from "../../src/component-registry.js";

// KAN-1834 (ADR-0025): the repository's own components/ folder is first-party. Every manifest in it
// must sit at its canonical path, be loadable, and declare the repository's licence.

const ROOT = fileURLToPath(new URL("../../../../components", import.meta.url));

describe("repository components/ folder", () => {
  const registry = new DirectoryComponentRegistry(ROOT, { firstParty: true });

  it("has no manifest that fails to load or sits at the wrong path", async () => {
    expect(await registry.problems()).toEqual([]);
  });

  it("declares Apache-2.0 on every component", async () => {
    for (const summary of await registry.list()) {
      const { manifest } = await registry.resolve(summary.id, summary.version);
      expect(manifest.license, `${summary.id}@${summary.version}`).toBe("Apache-2.0");
    }
  });
});
