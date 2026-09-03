import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Finding #3 (post-PR-#8 review): docs/adr/0010-exported-runtime-is-
// vendored-not-retemplated.md justifies vendoring packages/engine's source
// into every export specifically on the grounds that it guarantees
// behavioral equivalence with the real engine -- vendored code is "the same
// code that packages/engine/test/unit and test/integration already
// exercise, not a parallel reimplementation." Nothing enforced that claim:
// a bug fix landing only in packages/engine/src/workflow.ts would silently
// never reach a future `kampong export`.
//
// This is a cross-package check by nature (it reads packages/engine/src
// from packages/exporter's own test suite) -- the integration layer, per
// AGENTS.md's "test/unit: no infra, runs everywhere" vs. "test/integration:
// cross-module behavior" split.
//
// "Byte-identical" is too strict a bar in practice: ADR-0010 itself
// documents that http-tool.ts/workflow.ts/model.ts have their `@kampong/spec`
// type-only import rewritten to the local ./spec-types.js (ADR-0010's
// "lightly adapted"), and every vendored file also carries a header comment
// explaining the vendoring (absent from the source) plus trimmed
// PLAN.md/SLICES.md/KAN-*/ADR-* cross-references that wouldn't make sense
// outside this repo. None of that is the kind of drift this check exists to
// catch. So each pair is compared after `ts.transpileModule` with
// `removeComments: true` -- comments vanish, and a type-only `import type
// {...} from "..."` is erased entirely regardless of which module specifier
// it names, which is exactly what makes the documented @kampong/spec ->
// ./spec-types.js adaptation a non-issue here. What's left standing after
// that -- actual code -- must match exactly; if it doesn't, packages/engine
// changed and the vendored copy didn't (or vice versa).

const RUNTIME_DIR = fileURLToPath(new URL("../../templates/runtime", import.meta.url));
const ENGINE_SRC_DIR = fileURLToPath(new URL("../../../engine/src", import.meta.url));

// Every vendored file that has a 1:1 counterpart in packages/engine/src
// (ADR-0010's condition/guardrail/http-tool/workflow/model/run.ts list) and
// is expected to be functionally identical to it, modulo comments and
// type-only imports (see above).
const VENDORED_FROM_ENGINE = [
  "condition.ts",
  "guardrail.ts",
  "http-tool.ts",
  "workflow.ts",
  "model.ts",
  "run.ts",
];

// Vendored files with NO source-of-truth counterpart in packages/engine/src
// -- i.e. hand-authored specifically for the exported project, not copied.
// Exempt from the functional-diff check below, but only when the file
// itself carries a marker comment documenting *why* it's hand-vendored, so
// this list can't silently grow into "skip everything." Get a new entry
// wrong (or add a file to templates/runtime/ without updating either list)
// and the "every vendored file is accounted for" check below fails loudly.
const HAND_VENDORED_EXEMPTIONS: Record<string, RegExp> = {
  // ADR-0010: the exported project never re-validates a spec at runtime (it's
  // an already-validated literal baked in at export time), so this carries
  // only the plain-TypeScript *shape* of AgentSpec -- no Zod, no validator --
  // deliberately, not as an oversight.
  "spec-types.ts": /never re-validates a spec at runtime/,
};

function transpileStrippingCommentsAndTypeImports(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
}

describe("vendored runtime stays in sync with packages/engine/src (docs/adr/0010)", () => {
  const vendoredFiles = readdirSync(RUNTIME_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("every file under templates/runtime/ is accounted for by either the parity check or a documented exemption", () => {
    const accountedFor = new Set([
      ...VENDORED_FROM_ENGINE,
      ...Object.keys(HAND_VENDORED_EXEMPTIONS),
    ]);
    for (const name of vendoredFiles) {
      expect(
        accountedFor.has(name),
        `templates/runtime/${name} is neither in VENDORED_FROM_ENGINE nor ` +
          `HAND_VENDORED_EXEMPTIONS in this test -- add it to whichever applies.`,
      ).toBe(true);
    }
    // And the reverse: nothing in the lists above is stale (a file removed
    // from templates/runtime/ but left dangling in this test).
    for (const name of accountedFor) {
      expect(vendoredFiles, `${name} is listed in this test but no longer exists`).toContain(name);
    }
  });

  for (const name of VENDORED_FROM_ENGINE) {
    it(`${name} is functionally identical to packages/engine/src/${name}`, () => {
      const enginePath = join(ENGINE_SRC_DIR, name);
      const vendoredPath = join(RUNTIME_DIR, name);

      const engineSource = readFileSync(enginePath, "utf8");
      const vendoredSource = readFileSync(vendoredPath, "utf8");

      const engineCode = transpileStrippingCommentsAndTypeImports(engineSource);
      const vendoredCode = transpileStrippingCommentsAndTypeImports(vendoredSource);

      expect(
        vendoredCode,
        `templates/runtime/${name} has drifted from packages/engine/src/${name} ` +
          `(a difference beyond comments/type-only imports). If packages/engine's ` +
          `behavior changed intentionally, re-vendor this file; if the vendored ` +
          `copy was intentionally hand-adapted, this is the wrong place for that ` +
          `-- add it to HAND_VENDORED_EXEMPTIONS instead, with a marker comment ` +
          `in the file explaining why.`,
      ).toBe(engineCode);
    });
  }

  for (const [name, marker] of Object.entries(HAND_VENDORED_EXEMPTIONS)) {
    it(`${name} documents why it's hand-vendored (no packages/engine/src counterpart)`, () => {
      const vendoredSource = readFileSync(join(RUNTIME_DIR, name), "utf8");
      expect(
        marker.test(vendoredSource),
        `templates/runtime/${name} is exempt from the parity check but no longer ` +
          `carries the marker comment this test expects (${marker}) -- update ` +
          `either the file's explanation or this test's marker.`,
      ).toBe(true);
    });
  }
});
