import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { autoLayoutGraph, parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";
import { applyCollapse, groupBox, loopGroups } from "../../src/loopGroups.js";

// KAM-239 (ADR-0059): a loop is a group around its steps, and collapses to a card.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const body = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `          - step: s${i + 1}\n            type: transform\n            set:\n              a: "1"`,
  ).join("\n");

const spec = (n: number) => `version: "1.1"
agent:
  id: loop
  name: Loop
  role: R
  goal: G
  workflow:
    - step: before
      type: transform
      set:
        a: "1"
    - step: each
      foreach:
        items: "trigger.symbols"
        as: symbol
        steps:
${body(n)}
    - step: after
      type: transform
      set:
        a: "1"
`;

function graphOf(n: number) {
  const { spec: parsed, errors } = parseSpec(spec(n));
  expect(errors).toEqual([]);
  const graph = specToGraph(parsed!);
  return { graph, layout: autoLayoutGraph(graph) };
}

describe("loop groups", () => {
  afterEach(cleanup);

  it("finds a group per foreach, with the steps in its body", () => {
    const { graph } = graphOf(3);
    const [g] = loopGroups(graph);
    expect(g!.label).toBe("each symbol");
    expect(g!.members).toEqual(["workflow:s1", "workflow:s2", "workflow:s3"]);
  });

  it("draws the outline round the body with room for a header", () => {
    const { graph, layout } = graphOf(2);
    const [g] = loopGroups(graph);
    const box = groupBox(g!, layout, {})!;
    const s1 = layout["workflow:s1"]!;
    const s2 = layout["workflow:s2"]!;
    expect(box.x).toBeLessThan(s1.x);
    expect(box.y).toBeLessThan(Math.min(s1.y, s2.y) - 40);
    expect(box.x + box.width).toBeGreaterThan(s2.x + 240);
  });

  it("collapses to one card: lines run into and out of it, and later steps close up", () => {
    const { graph, layout } = graphOf(3);
    const groups = loopGroups(graph);
    const view = applyCollapse(graph, layout, groups, () => true);
    expect(view.graph.nodes.map((n) => n.id)).toEqual([
      "agent:loop",
      "workflow:before",
      "workflow:each",
      "workflow:after",
    ]);
    expect(view.graph.edges.map((e) => `${e.source}>${e.target}`)).toContain(
      "workflow:each>group:workflow:each",
    );
    expect(view.graph.edges.map((e) => `${e.source}>${e.target}`)).toContain(
      "group:workflow:each>workflow:after",
    );
    // The card sits in the first body column; `after` follows it directly instead of leaving the body's width empty.
    expect(view.layout["group:workflow:each"]!.x).toBe(layout["workflow:s1"]!.x);
    expect(view.layout["workflow:after"]!.x).toBe(view.layout["group:workflow:each"]!.x + 320);
  });

  it("does not fail on a tool the layout has no position for yet", () => {
    const { graph, layout } = graphOf(3);
    graph.nodes.push({ id: "tool:late", kind: "tool", column: 0, data: { name: "late" } });
    for (const empty of [layout, {}]) {
      const view = applyCollapse(graph, empty, loopGroups(graph), () => true);
      expect(view.graph.nodes.map((n) => n.id)).toContain("tool:late");
      expect(view.layout["tool:late"]).toBeUndefined();
    }
  });

  it("opens a small loop as a group and collapses it with its button, by keyboard or click", () => {
    const { graph, layout } = graphOf(3);
    render(<Canvas graph={graph} layout={layout} />);
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(3);
    const toggle = screen.getByTestId("loop-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(0);
    const card = document.querySelector('[data-id="group:workflow:each"]')!;
    expect(card.getAttribute("aria-label")).toMatch(/Loop each symbol, collapsed, 3 steps/);
    expect(card.textContent).toMatch(/3 steps/);
  });

  it("opens a loop of more than four steps collapsed", () => {
    const { graph, layout } = graphOf(5);
    render(<Canvas graph={graph} layout={layout} />);
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(0);
    expect(document.querySelector('[data-id="group:workflow:each"]')).toBeTruthy();
  });

  it("opens a collapsed loop with Enter on its card", () => {
    const { graph, layout } = graphOf(5);
    render(<Canvas graph={graph} layout={layout} />);
    const card = document.querySelector('[data-id="group:workflow:each"]')!;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(5);
  });

  it("opens a closed loop when a step inside it is selected", () => {
    const { graph, layout } = graphOf(5);
    const { rerender } = render(<Canvas graph={graph} layout={layout} />);
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(0);
    rerender(<Canvas graph={graph} layout={layout} selectedId="workflow:s4" />);
    expect(document.querySelectorAll(".md3-node--nested")).toHaveLength(5);
    expect(document.querySelector('[data-id="workflow:s4"]')?.classList.contains("selected")).toBe(
      true,
    );
  });
});
