import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("each_symbol")).toBeTruthy();
    expect(screen.getByText(/over vars\.symbols as symbol/)).toBeTruthy();
    expect(screen.getByText(/on_error continue/)).toBeTruthy();
    // Ten steps are more than a loop shows by default (KAM-239): it opens as one card, and its button opens it.
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(0);
    fireEvent.click(document.querySelector<HTMLElement>('[data-id="group:workflow:each_symbol"]')!);
    expect(screen.getByTestId("loop-toggle")).toBeTruthy();
    const items = [...document.querySelectorAll(".md3-node--nested")].map((node) =>
      node.getAttribute("data-id")?.replace("workflow:", ""),
    );
    // The branch's then arm (summarize, alert) is nodes too, in run order after the branch.
    expect(items).toEqual([
      "fetch",
      "check",
      "shape",
      "sane",
      "delta",
      "row",
      "write",
      "anomaly",
      "summarize",
      "alert",
    ]);
    expect(screen.getByText(/report/)).toBeTruthy();
  });
});
