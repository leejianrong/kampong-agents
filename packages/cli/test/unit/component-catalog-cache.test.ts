import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// KAM-226: /api/components is hit every time the canvas opens the tool form. The first-party components
// never change within a process, so scanning and hashing them per request made the form slow under load
// and flaked the live-server integration test.
const resolveAll = vi.fn();

vi.mock("@kampong/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@kampong/engine")>();
  return {
    ...real,
    createFirstPartyRegistry: () => {
      const registry = real.createFirstPartyRegistry();
      const original = registry.resolveAll.bind(registry);
      registry.resolveAll = (...args: Parameters<typeof original>) => {
        resolveAll();
        return original(...args);
      };
      return registry;
    },
  };
});

describe("componentCatalogFor", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("scans the first-party components once, however many times the catalog is requested", async () => {
    const { componentCatalogFor } = await import("../../src/components.js");
    const dir = mkdtempSync(join(tmpdir(), "kampong-catalog-"));
    dirs.push(dir);
    const specPath = join(dir, "agent.yaml");
    const first = await componentCatalogFor(specPath);
    const second = await componentCatalogFor(specPath);
    expect(first.components.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(resolveAll).toHaveBeenCalledTimes(1);
  });
});
