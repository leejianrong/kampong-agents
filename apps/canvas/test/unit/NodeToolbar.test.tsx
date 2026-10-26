import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";

// KAM-245: the selected card carries a small floating toolbar for Duplicate and Delete. It belongs to steps and
// tools, shows only on the selected card, and hands the action to the app (which asks before deleting).

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const SOURCE = `version: "1.1"
agent:
  id: t
  name: T
  role: R
  goal: G
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://x.example/a"
  workflow:
    - step: shape
      type: transform
      set:
        n: "1"
`;

function graphOf() {
  const { spec } = parseSpec(SOURCE);
  const graph = specToGraph(spec!);
  const layout = Object.fromEntries(
    graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
  );
  return { graph, layout };
}

describe("floating card toolbar", () => {
  it("shows Duplicate and Delete on the selected step only, and hands the action over", () => {
    const { graph, layout } = graphOf();
    const onNodeAction = vi.fn();
    const { rerender } = render(
      <Canvas
        graph={graph}
        layout={layout}
        selectedId="workflow:shape"
        onNodeAction={onNodeAction}
      />,
    );
    const bar = screen.getByRole("toolbar", { name: "Actions for step shape" });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(onNodeAction).toHaveBeenLastCalledWith("duplicate", "workflow:shape");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onNodeAction).toHaveBeenLastCalledWith("delete", "workflow:shape");
    expect(bar.querySelectorAll("button")).toHaveLength(2);

    // A tool has one too; the trigger and guardrails have nothing to duplicate or delete here.
    rerender(
      <Canvas graph={graph} layout={layout} selectedId="tool:lookup" onNodeAction={onNodeAction} />,
    );
    expect(screen.getByRole("toolbar", { name: "Actions for tool lookup" })).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Actions for step shape" })).toBeNull();
    rerender(
      <Canvas graph={graph} layout={layout} selectedId={`agent:t`} onNodeAction={onNodeAction} />,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("is absent without a handler", () => {
    const { graph, layout } = graphOf();
    render(<Canvas graph={graph} layout={layout} selectedId="workflow:shape" />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
