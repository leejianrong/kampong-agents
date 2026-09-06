import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  CONTRACT_FIXTURE_SOURCE,
  runSpecRepositoryContractTests,
} from "../../../spec/test/integration/repository-contract.js";
import { SpecStore } from "../../src/spec-store.js";

// KAN-1224: runs the shared `SpecRepository` contract (packages/spec/test/
// integration/repository-contract.ts) against the filesystem-backed
// implementation -- the other half lives in packages/server/test/integration
// against the Postgres-backed one. Proves `SpecStore` didn't just start
// compiling against the new interface, it actually behaves the way the
// interface promises.
//
// Imported by relative path (not `@kampong/spec`'s package entry point) --
// this test-suite-generator function is deliberately not part of that
// package's public `index.ts` barrel (see repository-contract.ts's own
// docstring), the same way packages/spec's own test files import its
// fixtures.ts by relative path rather than through the package entry point.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kampong-spec-repository-contract-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

runSpecRepositoryContractTests({
  createRepository: async () => {
    // A fresh spec file per test invocation (`createRepository` is called
    // once per assertion, see the contract suite's own docstring) --
    // `it.each`/multiple `it()` blocks inside the same `describe` all run
    // within the same `beforeEach`/`afterEach` pair, so give each a distinct
    // filename rather than reusing `agent.yaml` across calls within one test
    // run of the temp dir's lifetime.
    const specPath = join(dir, `agent-${Math.random().toString(36).slice(2)}.yaml`);
    const layoutPath = join(dir, "layout.json");
    writeFileSync(specPath, CONTRACT_FIXTURE_SOURCE);
    return new SpecStore(specPath, layoutPath);
  },
});
