import { describe, expect, it } from "vitest";
import { LAYOUT_MARK, isCurrentLayout, type LayoutMap } from "../../src/layout.js";
import { loadWithLayout, pinNodePositions } from "../../src/repository.js";
import { MemoryRepository } from "./memory-repository.js";

// KAM-186 (ADR-0061): a dragged node is pinned in the layout store. A pin overrides the automatic left-to-right
// position (ADR-0059) and survives a reload; a node with no pin is still laid out automatically.

const SOURCE = `version: "1.1"
agent:
  id: pins
  name: Pins
  role: Test
  goal: Pin things.
  tools:
    - name: wave
      action: http_request
      method: GET
      url: "https://pins.example/wave"
  workflow:
    - step: first
      action: do the first thing
    - step: second
      action: do the second thing
    - step: third
      action: do the third thing
`;

async function fresh() {
  const repo = new MemoryRepository(SOURCE);
  const auto = (await loadWithLayout(repo)).layout;
  return { repo, auto };
}

describe("pinned positions (ADR-0061)", () => {
  it("a file without pins is still laid out automatically and stamped", async () => {
    const { auto } = await fresh();
    expect(isCurrentLayout(auto)).toBe(true);
    expect(auto["workflow:first"]).toEqual({ x: 320, y: 0 });
    expect(auto["workflow:second"]).toEqual({ x: 640, y: 0 });
    expect(Object.values(auto).some((p) => "pinned" in p)).toBe(false);
  });

  it("a pinned node keeps its position on reload while the others stay automatic", async () => {
    const { repo, auto } = await fresh();
    const out = await pinNodePositions(repo, { "workflow:second": { x: 777, y: 333 } });
    expect(out.success).toBe(true);

    const again = (await loadWithLayout(repo)).layout;
    expect(again["workflow:second"]).toEqual({ x: 777, y: 333, pinned: true });
    expect(again["workflow:first"]).toEqual(auto["workflow:first"]);
    expect(again["workflow:third"]).toEqual(auto["workflow:third"]);
    expect(again[LAYOUT_MARK]).toEqual(auto[LAYOUT_MARK]);
    // Reading again is a fixed point.
    expect((await loadWithLayout(repo)).layout).toEqual(again);
  });

  it("ignores unknown ids and the reserved stamp, rounds, and skips non-finite numbers", async () => {
    const { repo, auto } = await fresh();
    await pinNodePositions(repo, {
      "workflow:nope": { x: 1, y: 1 },
      [LAYOUT_MARK]: { x: 9, y: 9 },
      "workflow:first": { x: 10.6, y: 20.4 },
      "workflow:third": { x: Number.NaN, y: 0 },
    });
    const layout = await repo.readLayout();
    expect(layout["workflow:nope"]).toBeUndefined();
    expect(layout[LAYOUT_MARK]).toEqual(auto[LAYOUT_MARK]);
    expect(layout["workflow:first"]).toEqual({ x: 11, y: 20, pinned: true });
    expect(layout["workflow:third"]).toEqual(auto["workflow:third"]);
  });

  it("a null position unpins the node, which goes back to its automatic place", async () => {
    const { repo, auto } = await fresh();
    await pinNodePositions(repo, { "workflow:second": { x: 5, y: 5 } });
    await pinNodePositions(repo, { "workflow:second": null });
    expect((await loadWithLayout(repo)).layout["workflow:second"]).toEqual(auto["workflow:second"]);
  });

  it("pins a tool node as well", async () => {
    const { repo } = await fresh();
    await pinNodePositions(repo, { "tool:wave": { x: 40, y: 900 } });
    expect((await loadWithLayout(repo)).layout["tool:wave"]).toEqual({
      x: 40,
      y: 900,
      pinned: true,
    });
  });

  it("drops the pin of a node that is no longer in the spec", async () => {
    const { repo } = await fresh();
    await pinNodePositions(repo, { "workflow:third": { x: 5, y: 5 } });
    const removed = await repo.applyOpsAndSave([{ op: "step.remove", step: "third" }]);
    expect(removed.success).toBe(true);
    expect((await loadWithLayout(repo)).layout["workflow:third"]).toBeUndefined();
  });

  it("a rename keeps the pin under the new name", async () => {
    const { repo } = await fresh();
    await pinNodePositions(repo, { "workflow:third": { x: 5, y: 6 } });
    await repo.applyOpsAndSave([{ op: "step.rename", step: "third", to: "last" }]);
    expect((await loadWithLayout(repo)).layout["workflow:last"]).toEqual({
      x: 5,
      y: 6,
      pinned: true,
    });
  });

  it("moving a step in the run order unpins it and leaves other pins where they are", async () => {
    const { repo, auto } = await fresh();
    await pinNodePositions(repo, {
      "workflow:first": { x: 111, y: 222 },
      "workflow:third": { x: 333, y: 444 },
    });
    const moved = await repo.applyOpsAndSave([
      { op: "step.move", step: "third", to: { in: "workflow", index: 0 } },
    ]);
    expect(moved.success).toBe(true);
    const layout = (await loadWithLayout(repo)).layout as LayoutMap;
    expect(layout["workflow:first"]).toEqual({ x: 111, y: 222, pinned: true });
    // `third` is first in run order now, so it lands in the first column, unpinned.
    expect(layout["workflow:third"]).toEqual(auto["workflow:first"]);
    expect(layout["workflow:third"]?.pinned).toBeUndefined();
  });

  it("refuses a pin when the spec does not parse, and writes nothing", async () => {
    const repo = new MemoryRepository("not: [valid");
    const out = await pinNodePositions(repo, { "workflow:first": { x: 1, y: 1 } });
    expect(out.success).toBe(false);
    expect(await repo.readLayout()).toEqual({});
  });
});
