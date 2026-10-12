import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";

// KAN-1865: the market-etl template opens on the canvas with no import step (ADR-0008).
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// jsdom has no file URL for import.meta, so the path is from the repo root vitest runs in.
const SOURCE = readFileSync(
  resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"),
  "utf8",
);

describe("the market-etl template on the canvas", () => {
  afterEach(cleanup);

  it("renders the loop over the symbols, its body steps, and the report step after it", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    const graph = specToGraph(spec!);
    const layout = Object.fromEntries(
      graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
    );
    render(<Canvas graph={graph} layout={layout} />);
    expect(screen.getByText("Foreach: each_symbol")).toBeTruthy();
    expect(screen.getByText(/over vars\.symbols as symbol/)).toBeTruthy();
    expect(screen.getByText(/on_error continue/)).toBeTruthy();
    const items = [...document.querySelectorAll(".md3-foreach__steps li")].map(
      (li) => li.textContent,
    );
    expect(items.map((text) => text?.split(":")[1]?.trim())).toEqual([
      "fetch",
      "check",
      "shape",
      "sane",
      "delta",
      "row",
      "write",
      "anomaly",
    ]);
    expect(screen.getByText(/report/)).toBeTruthy();
  });
});
