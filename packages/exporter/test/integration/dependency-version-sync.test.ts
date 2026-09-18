import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_DEPENDENCY_VERSIONS, SERVER_DEPENDENCY_VERSIONS } from "../../src/index.js";

// Finding #4 (post-PR-#8 review): package-json.ts's ENGINE_DEPENDENCY_VERSIONS
// hand-duplicates packages/engine/package.json's real `dependencies` field
// with nothing checking that stays true. Same root problem as finding #3 (a
// vendored-elsewhere copy of packages/engine can silently drift), different
// artifact: pinned dependency *versions* here, vendored *source* there.
//
// KAN-1435 tightened this from "matches packages/engine's declared caret
// range" to "matches the EXACT version this repo's own root
// package-lock.json resolves" -- i.e. the specific version this repo's own
// build/typecheck/test suite has actually exercised and proven compatible.
// The caret-range version of this check missed a real bug: a fresh `npm
// install` of a *standalone* exported project (no lockfile of its own) is
// free to resolve any version satisfying the range, and a newer
// `@mastra/core`/`ai`/`@ai-sdk/*` combination than this repo's lockfile pins
// broke `tsc` (a `MastraModelConfig`/`LanguageModelV4` type mismatch) --
// invisible via `npm start` (tsx transpiles without type-checking) but fatal
// to `npm run build`, which the exported project's Dockerfile (KAN-1435)
// depends on. Comparing against the lockfile's resolved version, instead of
// package.json's declared range, catches that class of drift directly.
//
// Cross-package by nature (reads packages/engine/package.json and the root
// lockfile from packages/exporter's own test suite) -- the integration
// layer, per AGENTS.md's unit-vs-integration split, same reasoning as
// runtime-parity.test.ts.

const ENGINE_PACKAGE_JSON_PATH = fileURLToPath(
  new URL("../../../engine/package.json", import.meta.url),
);
const CLI_PACKAGE_JSON_PATH = fileURLToPath(new URL("../../../cli/package.json", import.meta.url));
const ROOT_LOCKFILE_PATH = fileURLToPath(new URL("../../../../package-lock.json", import.meta.url));

interface PackageJson {
  dependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, { version?: string }>;
}

const rootLockfile = JSON.parse(readFileSync(ROOT_LOCKFILE_PATH, "utf8")) as PackageLock;

/** The exact version this repo's own root package-lock.json resolves a top-level dependency to. */
function resolvedLockVersion(name: string): string | undefined {
  return rootLockfile.packages[`node_modules/${name}`]?.version;
}

const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

describe("ENGINE_DEPENDENCY_VERSIONS stays in sync with this repo's actually-resolved versions", () => {
  const engineDependencies = (
    JSON.parse(readFileSync(ENGINE_PACKAGE_JSON_PATH, "utf8")) as PackageJson
  ).dependencies!;

  it("every dependency ENGINE_DEPENDENCY_VERSIONS declares is an exact version (no ^/~ range) matching the root lockfile's resolved version", () => {
    for (const [name, version] of Object.entries(ENGINE_DEPENDENCY_VERSIONS)) {
      expect(
        EXACT_VERSION_PATTERN.test(version),
        `ENGINE_DEPENDENCY_VERSIONS["${name}"] is "${version}", not an exact version -- a ` +
          `range lets a fresh \`npm install\` in a standalone exported project resolve a newer, ` +
          `possibly-incompatible version this repo's own lockfile hasn't verified (KAN-1435).`,
      ).toBe(true);
      const resolved = resolvedLockVersion(name);
      expect(
        resolved,
        `"${name}" isn't in the root package-lock.json -- run \`npm install\` at the repo root ` +
          `first, or remove it from ENGINE_DEPENDENCY_VERSIONS if it's no longer a real dependency.`,
      ).toBeDefined();
      expect(
        version,
        `ENGINE_DEPENDENCY_VERSIONS["${name}"] is "${version}" but the root package-lock.json ` +
          `resolves "${resolved}" -- re-sync package-json.ts's ENGINE_DEPENDENCY_VERSIONS to that ` +
          `exact version (only after confirming \`npm run build\` still passes for an exported ` +
          `project -- this is exactly the check KAN-1435 added to catch incompatible bumps).`,
      ).toBe(resolved);
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

// KAN-1435: src/server.ts's fastify dependency gets the same exact-pin,
// lockfile-verified treatment as ENGINE_DEPENDENCY_VERSIONS above -- same
// drift risk (a fresh export's `npm install` resolving a version this repo
// never actually tested), same fix.
describe("SERVER_DEPENDENCY_VERSIONS stays in sync with this repo's actually-resolved versions", () => {
  const cliDependencies = (JSON.parse(readFileSync(CLI_PACKAGE_JSON_PATH, "utf8")) as PackageJson)
    .dependencies!;

  it("every dependency SERVER_DEPENDENCY_VERSIONS declares is an exact version matching the root lockfile's resolved version", () => {
    for (const [name, version] of Object.entries(SERVER_DEPENDENCY_VERSIONS)) {
      expect(
        EXACT_VERSION_PATTERN.test(version),
        `SERVER_DEPENDENCY_VERSIONS["${name}"] is "${version}", not an exact version.`,
      ).toBe(true);
      const resolved = resolvedLockVersion(name);
      expect(resolved, `"${name}" isn't in the root package-lock.json.`).toBeDefined();
      expect(
        version,
        `SERVER_DEPENDENCY_VERSIONS["${name}"] is "${version}" but the root package-lock.json ` +
          `resolves "${resolved}" -- re-sync package-json.ts's SERVER_DEPENDENCY_VERSIONS.`,
      ).toBe(resolved);
    }
  });

  it("still declares every dependency packages/cli's serve path (fastify) needs", () => {
    expect(
      Object.hasOwn(SERVER_DEPENDENCY_VERSIONS, "fastify"),
      "packages/cli's serve-server.ts depends on fastify; the exported webhook server does too.",
    ).toBe(true);
    expect(Object.hasOwn(cliDependencies, "fastify")).toBe(true);
  });
});
