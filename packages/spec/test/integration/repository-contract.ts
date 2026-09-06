import { describe, expect, it } from "vitest";
import type { SpecRepository } from "../../src/repository.js";

// KAN-1224 (ADR-0014's "both implementations pass the same round-trip
// property test suite" test plan item, SLICES.md V5 integration test plan):
// one behavioral contract, run against BOTH the filesystem-backed
// (`packages/cli`) and Postgres-backed (`packages/server`) `SpecRepository`
// implementations. This is what actually proves the abstraction is honest --
// two implementations that happen to both compile against the same
// TypeScript interface could still behave differently; running the exact
// same assertions against both is what rules that out.
//
// NOT exported from this package's public entry point (index.ts) --
// deliberately a test-only helper, imported directly by path from each
// consumer's own test suite (packages/cli/test/integration/... and
// packages/server/test/integration/...), the same way packages/spec's own
// fixtures.ts is imported by its own test files. Neither consumer package's
// tsc build (`include: ["src"]`) reaches into `test/`, so this cross-package
// import is a test-time-only dependency, not a runtime/build one.

/** The exact spec source every implementation's fixture must be seeded with -- see each consumer's own setup (`createRepository`) for how it gets there. */
export const CONTRACT_FIXTURE_SOURCE = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

export interface RepositoryContractOptions {
  /** The repository under test -- see each `describe.skipIf`/`describe` block for how it's constructed and seeded. */
  createRepository: () => Promise<SpecRepository>;
}

/**
 * Runs the shared `SpecRepository` behavioral contract against whatever `createRepository()`
 * hands back. Each call must return a FRESH repository, already seeded with exactly
 * `CONTRACT_FIXTURE_SOURCE` as its spec source and an empty (not-yet-written) layout -- the same
 * starting state `packages/cli`'s own former `spec-store.test.ts` unit tests assumed.
 */
export function runSpecRepositoryContractTests({
  createRepository,
}: RepositoryContractOptions): void {
  describe("SpecRepository contract", () => {
    it("readSource returns the seeded spec source, byte for byte", async () => {
      const repo = await createRepository();
      expect(await repo.readSource()).toBe(CONTRACT_FIXTURE_SOURCE);
    });

    it("readLayout returns an empty object before any layout has been written", async () => {
      const repo = await createRepository();
      expect(await repo.readLayout()).toEqual({});
    });

    it("writeLayout persists a layout that a subsequent readLayout returns unchanged", async () => {
      const repo = await createRepository();
      const layout = { "agent:greeter": { x: 10, y: 20 }, "workflow:greet": { x: 270, y: 20 } };

      await repo.writeLayout(layout);

      expect(await repo.readLayout()).toEqual(layout);
    });

    it("writeLayout is idempotent -- writing twice leaves the same layout readable", async () => {
      const repo = await createRepository();
      const layoutA = { "agent:greeter": { x: 0, y: 0 } };
      const layoutB = { "agent:greeter": { x: 5, y: 5 } };

      await repo.writeLayout(layoutA);
      await repo.writeLayout(layoutB);

      expect(await repo.readLayout()).toEqual(layoutB);
    });

    it("applyPatchAndSave applies a valid patch and persists the result", async () => {
      const repo = await createRepository();

      const result = await repo.applyPatchAndSave([
        { op: "set", path: ["agent", "goal"], value: "Updated goal" },
      ]);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.source).toContain("Updated goal");
      }
      expect(await repo.readSource()).toContain("Updated goal");
    });

    it("applyPatchAndSave never persists an invalid mutation", async () => {
      const repo = await createRepository();
      const before = await repo.readSource();

      const result = await repo.applyPatchAndSave([
        { op: "set", path: ["agent", "workflow", 0, "step"], value: "" }, // violates min(1)
      ]);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
      expect(await repo.readSource()).toBe(before);
    });

    it("list() includes at least the seeded spec", async () => {
      const repo = await createRepository();

      const specs = await repo.list();

      expect(specs.length).toBeGreaterThan(0);
      for (const summary of specs) {
        expect(typeof summary.id).toBe("string");
        expect(typeof summary.name).toBe("string");
      }
    });
  });
}
