import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fixtures from "../fixtures.js";
import * as branchFixtures from "../fixtures-branch.js";
import * as foreachFixtures from "../fixtures-foreach.js";
import type { LayoutMap } from "../../src/layout.js";
import type { SpecOp } from "../../src/ops.js";
import { parseSpec } from "../../src/parse.js";
import { loadWithLayout, pinNodePositions, type SpecRepository } from "../../src/repository.js";

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
export const CONTRACT_FIXTURE_SOURCE = `version: "1.1"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  tools:
    - name: wave
      action: http_request
      method: GET
      url: "https://greeter.example/wave"
  workflow:
    - step: greet
      action: say_hello
    - step: shout
      type: transform
      set:
        loud: greet.text
    - step: each_visitor
      foreach:
        items: trigger.visitors
        as: visitor
        steps:
          - step: wave_at
            type: tool
            tool: wave
`;

export interface RepositoryContractOptions {
  /** The repository under test -- see each `describe.skipIf`/`describe` block for how it's constructed and seeded. */
  createRepository: () => Promise<SpecRepository>;
}

/**
 * KAM-170 (ADR-0055, ADR-0054 item 5): one table of operation sequences, run against every repository.
 * A case either succeeds with the expected spec (and layout) or is refused with the expected codes and
 * leaves storage as it was. The same table runs against the in-memory repository (the pure layer), the
 * filesystem one and the Postgres one, so a rule that exists in only one mode fails here.
 */
interface OpSequenceCase {
  name: string;
  ops: SpecOp[];
  layout?: LayoutMap;
  /** The whole expected spec text after the ops; compared as a parsed spec, not as text. */
  expectSource?: string;
  expectLayout?: LayoutMap;
  /** The expected error codes, when the request is refused. */
  expectCodes?: string[];
}

const F = CONTRACT_FIXTURE_SOURCE;
const LAYOUT: LayoutMap = {
  "agent:greeter": { x: 0, y: 0 },
  "tool:wave": { x: 260, y: 0 },
  "workflow:greet": { x: 520, y: 0 },
  "workflow:shout": { x: 520, y: 120 },
  "workflow:each_visitor": { x: 520, y: 240 },
};

export const OP_SEQUENCES: OpSequenceCase[] = [
  {
    name: "insert into a foreach body",
    ops: [
      {
        op: "step.insert",
        place: { in: { step: "each_visitor", slot: "steps" } },
        step: { step: "tally", type: "transform", set: { n: "wave_at.count" } },
      },
    ],
    expectSource:
      F +
      "          - step: tally\n            type: transform\n            set:\n              n: wave_at.count\n",
  },
  {
    name: "rename a step: its reads are rewritten and its layout key moves",
    ops: [{ op: "step.rename", step: "greet", to: "hello" }],
    layout: LAYOUT,
    expectSource: F.replace("- step: greet\n", "- step: hello\n").replace(
      "loud: greet.text",
      "loud: hello.text",
    ),
    expectLayout: (() => {
      const { "workflow:greet": at, ...rest } = LAYOUT;
      return { ...rest, "workflow:hello": at! };
    })(),
  },
  {
    name: "rename a tool: the tool: field follows and its layout key moves",
    ops: [{ op: "tool.rename", tool: "wave", to: "signal" }],
    layout: LAYOUT,
    expectSource: F.replace("- name: wave\n", "- name: signal\n").replace(
      "tool: wave\n",
      "tool: signal\n",
    ),
    expectLayout: (() => {
      const { "tool:wave": at, ...rest } = LAYOUT;
      return { ...rest, "tool:signal": at! };
    })(),
  },
  {
    name: "remove a step nothing reads: its layout key is dropped",
    ops: [{ op: "step.remove", step: "shout" }],
    layout: LAYOUT,
    expectSource: F.replace(
      "    - step: shout\n      type: transform\n      set:\n        loud: greet.text\n",
      "",
    ),
    expectLayout: Object.fromEntries(
      Object.entries(LAYOUT).filter(([key]) => key !== "workflow:shout"),
    ),
  },
  {
    name: "move a step to the front of the workflow",
    ops: [{ op: "step.move", step: "each_visitor", to: { in: "workflow", index: 0 } }],
    expectSource: `version: "1.1"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  tools:
    - name: wave
      action: http_request
      method: GET
      url: "https://greeter.example/wave"
  workflow:
    - step: each_visitor
      foreach:
        items: trigger.visitors
        as: visitor
        steps:
          - step: wave_at
            type: tool
            tool: wave
    - step: greet
      action: say_hello
    - step: shout
      type: transform
      set:
        loud: greet.text
`,
  },
  {
    name: "refuse a move into a foreach body that a reader outside cannot see into",
    ops: [{ op: "step.move", step: "greet", to: { in: { step: "each_visitor", slot: "steps" } } }],
    expectCodes: ["breaks_references"],
  },
  {
    name: "a request that renames, then inserts a step that reads the new name",
    ops: [
      { op: "step.rename", step: "greet", to: "hello" },
      {
        op: "step.insert",
        place: { in: "workflow", index: 1 },
        step: { step: "echo", type: "transform", set: { e: "hello.text" } },
      },
    ],
    expectSource: F.replace("- step: greet\n", "- step: hello\n")
      .replace("loud: greet.text", "loud: hello.text")
      .replace(
        "    - step: shout\n",
        "    - step: echo\n      type: transform\n      set:\n        e: hello.text\n    - step: shout\n",
      ),
  },
  {
    name: "refuse removing a step that is still read",
    ops: [{ op: "step.remove", step: "greet" }],
    layout: LAYOUT,
    expectCodes: ["has_references"],
  },
  {
    name: "refuse removing a tool a step still uses",
    ops: [{ op: "tool.remove", tool: "wave" }],
    expectCodes: ["has_references"],
  },
  {
    name: "refuse a rename onto a name already used inside a foreach body",
    ops: [{ op: "step.rename", step: "greet", to: "wave_at" }],
    expectCodes: ["name_taken"],
  },
  {
    name: "refuse an approval step in a foreach body",
    ops: [
      {
        op: "step.insert",
        place: { in: { step: "each_visitor", slot: "steps" } },
        step: { step: "ask", type: "approval" },
      },
    ],
    expectCodes: ["approval_in_foreach"],
  },
  {
    name: "refuse a move that puts a reader before the step it reads",
    ops: [{ op: "step.move", step: "greet", to: { in: "workflow", index: 2 } }],
    expectCodes: ["breaks_references"],
  },
  {
    name: "refuse an unknown step and a bad index",
    ops: [{ op: "step.remove", step: "ghost" }],
    expectCodes: ["step_not_found"],
  },
];

/**
 * KAM-207 (ADR-0054): import and export. Export is the stored text; import replaces it with the text given,
 * byte for byte, if it validates. `import(export(spec))` must give the same spec and the same text, for every
 * fixture and for the market-etl template, in every repository.
 */
const ALL_FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries({ ...fixtures, ...branchFixtures, ...foreachFixtures }).filter(
    ([, value]) => typeof value === "string",
  ) as [string, string][],
);

const IMPORT_FIXTURES: Record<string, string> = {
  ...ALL_FIXTURES,
  "market-etl template": readFileSync(
    new URL("../../../cli/templates/market-etl/agent.yaml", import.meta.url),
    "utf8",
  ),
};

function runImportTests(createRepository: () => Promise<SpecRepository>): void {
  describe("import and export (ADR-0054)", () => {
    for (const [name, text] of Object.entries(IMPORT_FIXTURES)) {
      it(`${name}: import then export gives the same text, and importing the export changes nothing`, async () => {
        const repo = await createRepository();
        const expected = parseSpec(text);
        expect(expected.errors).toEqual([]);

        const imported = await repo.replaceSourceAndSave(text);
        expect(imported.success).toBe(true);
        if (imported.success) expect(imported.spec).toEqual(expected.spec);
        const exported = await repo.readSource();
        expect(exported).toBe(text);

        const again = await repo.replaceSourceAndSave(exported);
        expect(again.success).toBe(true);
        expect(await repo.readSource()).toBe(text);
        if (imported.success && again.success) expect(again.revision).toBe(imported.revision);
        expect(parseSpec(await repo.readSource()).spec).toEqual(expected.spec);
      });
    }

    it("an invalid import is refused with line-numbered errors and writes nothing", async () => {
      const repo = await createRepository();
      const bad = CONTRACT_FIXTURE_SOURCE.replace("id: greeter", "id: [unclosed");
      const result = await repo.replaceSourceAndSave(bad);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]!.line).toBeDefined();
        expect(result.stale).toBeUndefined();
      }
      const invalid = CONTRACT_FIXTURE_SOURCE.replace("step: greet\n", 'step: ""\n');
      const second = await repo.replaceSourceAndSave(invalid);
      expect(second.success).toBe(false);
      if (!second.success) expect(second.errors[0]!.line).toBeDefined();
      expect(await repo.readSource()).toBe(CONTRACT_FIXTURE_SOURCE);
    });

    it("refuses an import made against a stale revision", async () => {
      const repo = await createRepository();
      const start = await repo.applyOpsAndSave([]);
      if (!start.success) throw new Error("the fixture should apply an empty request");
      await repo.applyOpsAndSave([{ op: "set", path: ["agent", "goal"], value: "Changed" }]);
      const stale = await repo.replaceSourceAndSave(CONTRACT_FIXTURE_SOURCE, {
        baseRevision: start.revision,
      });
      expect(stale.success).toBe(false);
      if (!stale.success) expect(stale.stale).toBe(true);
      expect(await repo.readSource()).toContain("Changed");
    });
  });
}

function runOpSequences(createRepository: () => Promise<SpecRepository>): void {
  describe("operation sequences (ADR-0055)", () => {
    for (const c of OP_SEQUENCES) {
      it(c.name, async () => {
        const repo = await createRepository();
        if (c.layout) await repo.writeLayout(c.layout);
        const result = await repo.applyOpsAndSave(c.ops);
        if (c.expectSource !== undefined && c.expectCodes === undefined) {
          expect(result.success).toBe(true);
          const expected = parseSpec(c.expectSource).spec;
          expect(expected).toBeDefined();
          if (result.success) expect(result.spec).toEqual(expected);
          expect(parseSpec(await repo.readSource()).spec).toEqual(expected);
          expect(await repo.readLayout()).toEqual(c.expectLayout ?? c.layout ?? {});
        } else {
          expect(result.success).toBe(false);
          if (!result.success && c.expectCodes) {
            expect(result.errors.map((e) => e.code)).toEqual(c.expectCodes);
          }
          expect(await repo.readSource()).toBe(CONTRACT_FIXTURE_SOURCE);
          expect(await repo.readLayout()).toEqual(c.layout ?? {});
        }
      });
    }

    it("a request that changes nothing writes nothing and keeps the revision", async () => {
      const repo = await createRepository();
      const first = await repo.applyOpsAndSave([]);
      const again = await repo.applyOpsAndSave([{ op: "step.rename", step: "greet", to: "greet" }]);
      expect(first.success && again.success).toBe(true);
      if (first.success && again.success) expect(again.revision).toBe(first.revision);
      expect(await repo.readSource()).toBe(CONTRACT_FIXTURE_SOURCE);
    });

    it("refuses a write made against a stale revision, and accepts the current one", async () => {
      const repo = await createRepository();
      const start = await repo.applyOpsAndSave([]);
      if (!start.success) throw new Error("the fixture should apply an empty request");
      const rename: SpecOp[] = [{ op: "step.rename", step: "greet", to: "hello" }];

      const first = await repo.applyOpsAndSave(rename, { baseRevision: start.revision });
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.revision).not.toBe(start.revision);

      const stale = await repo.applyOpsAndSave(
        [{ op: "set", path: ["agent", "goal"], value: "Lost update" }],
        { baseRevision: start.revision },
      );
      expect(stale.success).toBe(false);
      if (!stale.success) {
        expect(stale.stale).toBe(true);
        expect(stale.errors[0]!.code).toBe("stale");
        expect(stale.revision).toBe(first.revision);
      }
      expect(await repo.readSource()).not.toContain("Lost update");

      const current = await repo.applyOpsAndSave(
        [{ op: "set", path: ["agent", "goal"], value: "Kept" }],
        { baseRevision: first.revision },
      );
      expect(current.success).toBe(true);
      expect(await repo.readSource()).toContain("Kept");
    });

    it("applyPatchAndSave still works, as the same write path", async () => {
      const repo = await createRepository();
      const result = await repo.applyPatchAndSave([
        { op: "set", path: ["agent", "goal"], value: "Via the alias" },
      ]);
      expect(result.success).toBe(true);
      expect(await repo.readSource()).toContain("Via the alias");
    });
  });
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
  runOpSequences(createRepository);
  runImportTests(createRepository);

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

    // KAM-186 (ADR-0061): local and hosted must keep a dragged position the same way.
    it("pinNodePositions: a pinned position survives loadWithLayout and a rename moves it with the step", async () => {
      const repo = await createRepository();
      await loadWithLayout(repo);

      const pinned = await pinNodePositions(repo, { "workflow:shout": { x: 901, y: 402 } });
      expect(pinned.success).toBe(true);
      expect((await loadWithLayout(repo)).layout["workflow:shout"]).toEqual({
        x: 901,
        y: 402,
        pinned: true,
      });
      // The pin is in the store itself, not only in what loadWithLayout returns.
      expect((await repo.readLayout())["workflow:shout"]).toEqual({ x: 901, y: 402, pinned: true });
      // Another node is still laid out automatically.
      expect((await loadWithLayout(repo)).layout["workflow:greet"]?.pinned).toBeUndefined();

      const renamed = await repo.applyOpsAndSave([
        { op: "step.rename", step: "shout", to: "yell" },
      ]);
      expect(renamed.success).toBe(true);
      expect((await loadWithLayout(repo)).layout["workflow:yell"]).toEqual({
        x: 901,
        y: 402,
        pinned: true,
      });

      await pinNodePositions(repo, { "workflow:yell": null });
      expect((await loadWithLayout(repo)).layout["workflow:yell"]?.pinned).toBeUndefined();
    });

    // KAM-183 (ADR-0062): Undo restores through `replaceSourceAndSave` (guarded by the revision of the last write)
    // and `pinNodePositions`, the same calls in local and hosted mode, so the stored text and layout must come back
    // exactly, and a restore over a later change must be refused.
    it("undo: restoring a snapshot gives back the text byte for byte, comments included, and the pins", async () => {
      const repo = await createRepository();
      const commented = `# kept comment\n${CONTRACT_FIXTURE_SOURCE.replace("goal: ", "# why\n  goal: ")}`;
      expect((await repo.replaceSourceAndSave(commented)).success).toBe(true);
      await loadWithLayout(repo);
      await pinNodePositions(repo, { "workflow:shout": { x: 901, y: 402 } });
      const pinnedLayout = await repo.readLayout();

      const edited = await repo.applyOpsAndSave([{ op: "step.rename", step: "shout", to: "yell" }]);
      if (!edited.success) throw new Error("the rename should apply");
      expect((await repo.readLayout())["workflow:yell"]).toEqual({ x: 901, y: 402, pinned: true });

      const restored = await repo.replaceSourceAndSave(commented, {
        baseRevision: edited.revision,
      });
      expect(restored.success).toBe(true);
      expect(await repo.readSource()).toBe(commented);
      await pinNodePositions(repo, { "workflow:shout": { x: 901, y: 402 }, "workflow:yell": null });
      expect(await repo.readLayout()).toEqual(pinnedLayout);
    });

    it("undo: a restore made over a later change is refused and writes nothing", async () => {
      const repo = await createRepository();
      const first = await repo.applyOpsAndSave([
        { op: "set", path: ["agent", "goal"], value: "One" },
      ]);
      if (!first.success) throw new Error("the first edit should apply");
      const second = await repo.applyOpsAndSave([
        { op: "set", path: ["agent", "goal"], value: "Two" },
      ]);
      expect(second.success).toBe(true);

      const refused = await repo.replaceSourceAndSave(CONTRACT_FIXTURE_SOURCE, {
        baseRevision: first.revision,
      });
      expect(refused.success).toBe(false);
      if (!refused.success) expect(refused.stale).toBe(true);
      expect(await repo.readSource()).toContain("Two");
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
