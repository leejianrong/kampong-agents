import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_DEPENDENCY_VERSIONS } from "../../src/index.js";

// Finding #4 (post-PR-#8 review): package-json.ts's ENGINE_DEPENDENCY_VERSIONS
// hand-duplicates packages/engine/package.json's real `dependencies` field
// (its own comment already says so -- "keep this in sync by hand if
// packages/engine/package.json's versions change") with nothing checking
// that stays true. Same root problem as finding #3 (a vendored-elsewhere
// copy of packages/engine can silently drift), different artifact: pinned
// dependency *versions* here, vendored *source* there. If packages/engine
// bumps e.g. @mastra/core for a security fix, every future `kampong export`
// would otherwise keep silently pinning the stale version.
//
// Cross-package by nature (reads packages/engine/package.json from
// packages/exporter's own test suite) -- the integration layer, per
// AGENTS.md's unit-vs-integration split, same reasoning as
// runtime-parity.test.ts.
//
// The exporter is allowed to declare a *subset* of packages/engine's
// dependencies (it doesn't need e.g. a dependency packages/engine uses only
// for its own dev-server/CLI-adjacent code, if that ever happens) -- but
// whatever subset it does declare must match packages/engine's version for
// that package exactly, and every package ENGINE_DEPENDENCY_VERSIONS
// declares must still exist in packages/engine's dependencies at all (so a
// dependency packages/engine has since dropped doesn't linger here forever).

const ENGINE_PACKAGE_JSON_PATH = fileURLToPath(
  new URL("../../../engine/package.json", import.meta.url),
);

interface PackageJson {
  dependencies?: Record<string, string>;
}

describe("ENGINE_DEPENDENCY_VERSIONS stays in sync with packages/engine/package.json", () => {
  const engineDependencies = (
    JSON.parse(readFileSync(ENGINE_PACKAGE_JSON_PATH, "utf8")) as PackageJson
  ).dependencies!;

  it("every dependency ENGINE_DEPENDENCY_VERSIONS declares exists in packages/engine's dependencies, with the exact same version", () => {
    for (const [name, version] of Object.entries(ENGINE_DEPENDENCY_VERSIONS)) {
      expect(
        engineDependencies[name],
        `ENGINE_DEPENDENCY_VERSIONS declares "${name}" but packages/engine/package.json's ` +
          `dependencies no longer does -- remove it from ENGINE_DEPENDENCY_VERSIONS.`,
      ).toBeDefined();
      expect(
        version,
        `ENGINE_DEPENDENCY_VERSIONS["${name}"] is "${version}" but packages/engine/package.json ` +
          `pins "${engineDependencies[name]}" -- re-sync package-json.ts's ENGINE_DEPENDENCY_VERSIONS.`,
      ).toBe(engineDependencies[name]);
    }
  });

  it("still declares every @kampong/* runtime dependency packages/engine has (only @kampong/spec is expected to be absent -- ADR-0002's zero-lock-in)", () => {
    const nonKampongEngineDeps = Object.keys(engineDependencies).filter(
      (name) => !name.startsWith("@kampong/"),
    );
    for (const name of nonKampongEngineDeps) {
      expect(
        Object.hasOwn(ENGINE_DEPENDENCY_VERSIONS, name),
        `packages/engine/package.json now depends on "${name}", which ENGINE_DEPENDENCY_VERSIONS ` +
          `doesn't declare -- an exported project's vendored runtime (docs/adr/0010) needs every ` +
          `non-@kampong dependency packages/engine itself needs.`,
      ).toBe(true);
    }
  });
});
