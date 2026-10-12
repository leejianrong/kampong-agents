import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAN-1858 (ADR-0043): a foreach node reads as a loop with its nested steps listed inside it.
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
  id: loop
  name: Loop
  role: R
  goal: G
  tools:
    - name: fetch_price
      action: http_request
      method: GET
      url: "https://x.example/{{ symbol }}"
  workflow:
    - step: each
      foreach:
        items: "trigger.symbols"
        as: symbol
        concurrency: 2
        on_error: continue
        steps:
          - step: fetch
            type: tool
            tool: fetch_price
          - step: shape
            type: transform
            set:
              label: "symbol"
    - step: after
      action: summarise
`;

describe("Canvas foreach node", () => {
  afterEach(cleanup);

  it("shows the loop's items, variable, policy and each nested step", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    const graph = specToGraph(spec!);
    const layout = Object.fromEntries(
      graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
    );
    render(<Canvas graph={graph} layout={layout} />);
    expect(screen.getByText("Foreach: each")).toBeTruthy();
    expect(screen.getByText(/over trigger\.symbols as symbol/)).toBeTruthy();
    expect(screen.getByText(/on_error continue/)).toBeTruthy();
    expect(screen.getByText(/concurrency 2/)).toBeTruthy();
    const items = [...document.querySelectorAll(".md3-foreach__steps li")].map(
      (li) => li.textContent,
    );
    expect(items).toEqual(["Tool step: fetch", "Transform: shape"]);
    // A step after the loop still renders.
    expect(screen.getByText("Workflow: after")).toBeTruthy();
  });
});

describe("WorkflowStepForm foreach", () => {
  afterEach(cleanup);

  it("builds a foreach step from the minimal form", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Foreach" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "each" } });
    fireEvent.change(screen.getByLabelText("Items (expression that gives a list)"), {
      target: { value: "trigger.symbols" },
    });
    fireEvent.change(screen.getByLabelText("Loop variable"), { target: { value: "symbol" } });
    fireEvent.change(screen.getByLabelText("Concurrency"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("On error"), { target: { value: "continue" } });
    fireEvent.change(screen.getByLabelText("Body (one tool per line, step: tool)"), {
      target: { value: "fetch: fetch_price" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));
    expect(onSubmit).toHaveBeenCalledWith({
      step: "each",
      foreach: {
        items: "trigger.symbols",
        as: "symbol",
        concurrency: 3,
        on_error: "continue",
        steps: [{ step: "fetch", type: "tool", tool: "fetch_price" }],
      },
    });
  });

  it("shows an error for an empty body", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Foreach" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "each" } });
    fireEvent.change(screen.getByLabelText("Items (expression that gives a list)"), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByLabelText("Loop variable"), { target: { value: "i" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Step" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Add at least one body step/)).toBeTruthy();
  });
});
