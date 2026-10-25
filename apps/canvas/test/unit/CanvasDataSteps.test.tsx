import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";

// KAM-152: transform, validate and dedupe nodes say what they do under their title.
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
  id: d
  name: D
  role: R
  goal: G
  workflow:
    - step: shape
      type: transform
      set:
        title: trigger.title
        price: trigger.price
    - step: check
      type: validate
      assert: $exists(shape.title) and shape.price > 0 and shape.price < 1000000000
      on_fail: skip
    - step: once
      type: dedupe
      once:
        key: shape.title
        ttl: 24h
`;

describe("Canvas data-step nodes", () => {
  afterEach(cleanup);

  it("summarises each step under its title, clipping a long assertion", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    const graph = specToGraph(spec!);
    const layout = Object.fromEntries(
      graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
    );
    render(<Canvas graph={graph} layout={layout} />);
    expect(screen.getByText("shape")).toBeTruthy();
    expect(screen.getByText("sets title, price")).toBeTruthy();
    expect(screen.getByText("check")).toBeTruthy();
    const validate = screen.getByText(/^asserts \$exists/);
    expect(validate.textContent).toMatch(/….*· on fail skip$/);
    expect(screen.getByText("once")).toBeTruthy();
    expect(screen.getByText("once per shape.title for 24h")).toBeTruthy();
  });
});
