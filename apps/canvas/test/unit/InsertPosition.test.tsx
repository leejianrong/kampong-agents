import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addTargets, parseSpec, specToGraph, type SpecOp } from "@kampong/spec";
import { App } from "../../src/App.js";
import { Canvas } from "../../src/Canvas.js";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";
import { chooseFromMenu } from "./menu.js";

// KAM-173: the Position choice of Add Workflow Step, the insertion marker on the canvas, and the flash on the new
// node. The market-etl template (each_symbol and its anomaly branch) is the fixture.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SOURCE = readFileSync(
  resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"),
  "utf8",
);
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const optionLabels = (select: HTMLElement) =>
  [...select.querySelectorAll("option")].map((o) => o.textContent);

describe("WorkflowStepForm: Position", () => {
  afterEach(cleanup);

  it("offers the end, the start and each step by name, and follows the chosen list", () => {
    const { spec } = parseSpec(SOURCE);
    render(
      <WorkflowStepForm
        targets={addTargets(spec!)}
        workflowSteps={["each_symbol", "report"]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(optionLabels(screen.getByLabelText("Position"))).toEqual([
      "At the end of the workflow",
      "At the start of the workflow",
      "After each_symbol",
      "After report",
    ]);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "anomaly/then" } });
    expect(optionLabels(screen.getByLabelText("Position"))).toEqual([
      "At the end of anomaly (then)",
      "At the start of anomaly (then)",
      "After summarize",
      "After alert",
    ]);
  });

  it("hands over the place with the index of the chosen position", async () => {
    const { spec } = parseSpec(SOURCE);
    const onSubmit = vi.fn();
    render(
      <WorkflowStepForm
        targets={addTargets(spec!)}
        workflowSteps={["each_symbol", "report"]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each_symbol/steps" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "after:0" } });
    click("Stop");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "halt" } });
    click("Save step");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![1]).toEqual({
      in: { step: "each_symbol", slot: "steps" },
      index: 1,
    });
  });

  it("goes to the workflow by index only when the position is not the end", async () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm workflowSteps={["a", "b"]} onSubmit={onSubmit} onCancel={() => {}} />);
    click("Stop");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "s1" } });
    click("Save step");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "start" } });
    click("Save step");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]![1]).toEqual({ in: "workflow", index: 0 });
  });

  it("reports the placement as it changes, and null when it closes", () => {
    const seen: unknown[] = [];
    const { unmount } = render(
      <WorkflowStepForm
        workflowSteps={["a", "b"]}
        onPlacementChange={(p) => seen.push(p)}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "after:0" } });
    unmount();
    expect(seen).toEqual([{ steps: ["a", "b"] }, { steps: ["a", "b"], index: 1 }, null]);
  });
});

describe("Canvas: marker and flash", () => {
  afterEach(cleanup);
  const graph = specToGraph(parseSpec(SOURCE).spec!);
  const layout = Object.fromEntries(
    graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
  );

  it("draws the marker beside its anchor", () => {
    render(
      <Canvas
        graph={graph}
        layout={layout}
        marker={{ anchor: "workflow:check", side: "above", label: "New step goes here" }}
      />,
    );
    expect(screen.getByText("New step goes here")).toBeTruthy();
    expect(document.querySelector(".md3-node--marker")).toBeTruthy();
  });

  it("flashes the focused node", () => {
    render(<Canvas graph={graph} layout={layout} focus={{ id: "workflow:check", nonce: 1 }} />);
    expect(
      document.querySelector('[data-id="workflow:check"]')!.classList.contains("md3-node--flash"),
    ).toBe(true);
    expect(document.querySelectorAll(".md3-node--flash")).toHaveLength(1);
  });
});

describe("App: choosing where a step goes", () => {
  afterEach(cleanup);

  function open() {
    const sent: SpecOp[][] = [];
    const { spec } = parseSpec(SOURCE);
    const api = {
      loadSpec: async () => ({ success: true, spec, errors: [], layout: {}, source: SOURCE }),
      applyPatch: async () => ({ success: true }),
      applyOps: async (ops: SpecOp[]) => (sent.push(ops), { success: true }),
      subscribeToEvents: () => () => {},
      startRun: async () => ({ success: true }),
      approveRun: async () => ({ success: true }),
      subscribeToRunEvents: () => () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<App api={api as any} />);
    return sent;
  }

  it("shows the marker while choosing, then inserts at the index and flashes the new step", async () => {
    const sent = open();
    await waitFor(() => expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy());
    chooseFromMenu("Add Workflow Step");
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each_symbol/steps" } });
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "after:0" } });
    expect(screen.getByText("New step goes here")).toBeTruthy();
    click("Transform");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "noted" } });
    fireEvent.change(screen.getByLabelText("Values (one per line, name: expression)"), {
      target: { value: "note: 'x'" },
    });
    click("Save step");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      {
        op: "step.insert",
        place: { in: { step: "each_symbol", slot: "steps" }, index: 1 },
        step: { step: "noted", type: "transform", set: { note: "'x'" } },
      },
    ]);
    // The form closes with the save, and the marker with it.
    await waitFor(() => expect(screen.queryByText("New step goes here")).toBeNull());
  });
});
