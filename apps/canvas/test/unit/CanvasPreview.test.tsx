import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSpec, planPreview, planToOps, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";

// KAM-206: a plan on show is drawn on the canvas with what it adds, changes and removes marked, in words.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SOURCE = `version: "1.1"
agent:
  id: demo
  name: Demo
  role: R
  goal: G
  workflow:
    - step: one
      type: transform
      set: { a: "1" }
    - step: two
      type: transform
      set: { b: "2" }
    - step: three
      type: transform
      set: { c: "3" }
`;

describe("Canvas: a plan on show", () => {
  afterEach(cleanup);

  it("marks added, changed and removed cards with a word, and draws what the plan removes", () => {
    const planned = planToOps(SOURCE, {
      summary: "s",
      edits: [
        { kind: "add_step", step: { step: "four", type: "transform", set: { d: "4" } } },
        {
          kind: "replace_step",
          step: "two",
          with: { step: "two", type: "transform", set: { b: "9" } },
        },
        { kind: "remove_step", step: "three" },
      ],
    });
    if (!planned.success) throw new Error(planned.errors.join("; "));
    const preview = planPreview(parseSpec(SOURCE).spec!, planned.spec, planned.diff);
    render(<Canvas graph={preview.graph} layout={preview.layout} marks={preview.marks} />);
    const mark = (id: string) =>
      document.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="card-mark"]`)
        ?.textContent;
    expect(mark("workflow:four")).toBe("Add");
    expect(mark("workflow:two")).toBe("Change");
    expect(mark("workflow:three")).toBe("Remove");
    expect(mark("workflow:one")).toBeUndefined();
    const removed = document.querySelector('.react-flow__node[data-id="workflow:three"]')!;
    expect(removed.classList.contains("md3-node--preview-remove")).toBe(true);
    expect(removed.getAttribute("aria-label")).toContain("The plan would remove this");
  });

  it("draws no marks when no plan is on show", () => {
    const graph = specToGraph(parseSpec(SOURCE).spec!);
    render(<Canvas graph={graph} layout={{}} />);
    expect(document.querySelectorAll('[data-testid="card-mark"]')).toHaveLength(0);
  });
});
