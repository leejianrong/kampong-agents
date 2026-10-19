import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, type PatchOp, type SpecOp } from "@kampong/spec";
import { App } from "../../src/App.js";
import { StepsPanel } from "../../src/StepsPanel.js";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAM-153: the loop is editable in place, and a step of any kind can be added inside one. The market-etl template
// (each_symbol, a foreach over an eight-step body) is the fixture.

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

describe("StepsPanel: editing a foreach", () => {
  afterEach(cleanup);

  it("opens the loop with its values and saves a patch of what changed", async () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit each_symbol");
    expect((screen.getByLabelText("Loop variable") as HTMLInputElement).value).toBe("symbol");
    expect((screen.getByLabelText("On error") as HTMLSelectElement).value).toBe("continue");
    fireEvent.change(screen.getByLabelText("Concurrency"), { target: { value: "3" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "set", path: ["agent", "workflow", 0, "foreach", "concurrency"], value: 3 },
      ]),
    );
  });

  it("keeps the form open and says why when the loop variable is not a name", () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async () => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit each_symbol");
    fireEvent.change(screen.getByLabelText("Loop variable"), { target: { value: "1x" } });
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain("loop variable");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("edits a nested step at its own path", async () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit fetch");
    fireEvent.change(screen.getByLabelText("Tool"), { target: { value: "upsert_price" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        {
          op: "set",
          path: ["agent", "workflow", 0, "foreach", "steps", 0, "tool"],
          value: "upsert_price",
        },
      ]),
    );
  });
});

describe("WorkflowStepForm: Add to a loop", () => {
  afterEach(cleanup);

  it("offers the loops, and hands the step and the loop to onSubmit", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<WorkflowStepForm loops={["each"]} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each" } });
    click("Stop");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "halt" } });
    click("Save step");
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ step: "halt", stop: { status: "skipped" } }, "each"),
    );
  });

  it("shows what the save refused", async () => {
    const onSubmit = vi.fn(async () => ["an approval cannot go in a loop"]);
    render(<WorkflowStepForm loops={["each"]} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each" } });
    click("Approval");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "ask" } });
    click("Save step");
    expect((await screen.findByRole("alert")).textContent).toContain("an approval cannot go");
  });

  it("has no Add to choice when there is no loop", () => {
    render(<WorkflowStepForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(screen.queryByLabelText("Add to")).toBeNull();
  });
});

describe("App: adding a step inside a foreach", () => {
  afterEach(cleanup);

  function open(refuse = false) {
    const sent: SpecOp[][] = [];
    const { spec } = parseSpec(SOURCE);
    const api = {
      loadSpec: async () => ({ success: true, spec, errors: [], layout: {}, source: SOURCE }),
      applyPatch: async () => ({ success: true }),
      applyOps: async (ops: SpecOp[]) => {
        sent.push(ops);
        return refuse
          ? {
              success: false,
              errors: [
                {
                  path: [],
                  message: "an approval cannot go in a foreach body",
                  code: "approval_in_foreach",
                },
              ],
            }
          : { success: true };
      },
      subscribeToEvents: () => () => {},
      startRun: async () => ({ success: true }),
      approveRun: async () => ({ success: true }),
      subscribeToRunEvents: () => () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<App api={api as any} />);
    return sent;
  }
  const start = async () => {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Workflow Step" })).toBeTruthy(),
    );
    click("Add Workflow Step");
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each_symbol" } });
  };

  it("sends a step.insert at the loop's body", async () => {
    const sent = open();
    await start();
    click("Stop");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "halt" } });
    click("Save step");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      {
        op: "step.insert",
        place: { in: { step: "each_symbol", slot: "steps" } },
        step: { step: "halt", stop: { status: "skipped" } },
      },
    ]);
  });

  it("shows a refusal in the form and keeps it open", async () => {
    open(true);
    await start();
    click("Approval");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "ask" } });
    click("Save step");
    expect((await screen.findByRole("alert")).textContent).toContain("approval cannot go");
    expect(screen.getByRole("form", { name: "Add Workflow Step" })).toBeTruthy();
  });
});
