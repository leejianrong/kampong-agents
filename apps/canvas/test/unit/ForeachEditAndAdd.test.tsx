import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyOpsToSource, parseSpec, type PatchOp, type SpecOp } from "@kampong/spec";
import type { RemoveOutcome } from "../../src/DeleteControl.js";
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

const PLACE = { in: { step: "each", slot: "steps" as const } };
const TARGETS = [
  {
    id: "each/steps",
    label: "Inside each (the loop's body)",
    place: PLACE,
    where: "each",
    steps: ["a", "b"],
    scope: { vars: [], steps: [], trigger: [] },
  },
];

describe("WorkflowStepForm: Add to a loop", () => {
  afterEach(cleanup);

  it("offers the loops, and hands the step and the loop to onSubmit", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<WorkflowStepForm targets={TARGETS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each/steps" } });
    click("Stop");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "halt" } });
    click("Save step");
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ step: "halt", stop: { status: "skipped" } }, PLACE),
    );
  });

  it("shows what the save refused", async () => {
    const onSubmit = vi.fn(async () => ["an approval cannot go in a loop"]);
    render(<WorkflowStepForm targets={TARGETS} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each/steps" } });
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
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "each_symbol/steps" } });
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

describe("StepsPanel: Delete on a foreach body step (market-etl)", () => {
  afterEach(cleanup);

  // Runs the real ops layer on the template, as the server would.
  function setup() {
    const { spec } = parseSpec(SOURCE);
    let source = SOURCE;
    const onRemove = vi.fn(async (op: SpecOp): Promise<RemoveOutcome> => {
      const res = applyOpsToSource(source, [op]);
      if (res.success) {
        source = res.source;
        return { success: true };
      }
      return {
        success: false,
        blocked: res.errors.some((e) => e.code === "has_references"),
        messages: res.errors.map((e) => e.message),
        references: res.errors.flatMap((e) => e.references ?? []),
      };
    });
    render(<StepsPanel spec={spec!} onPatch={vi.fn(async () => true)} onRemove={onRemove} />);
    return { onRemove, now: () => source };
  }
  const confirm = (name: string) => {
    click(`Delete step ${name}`);
    fireEvent.click(
      within(screen.getByRole("group", { name: `Delete step ${name}?` })).getByRole("button", {
        name: "Delete step",
      }),
    );
  };

  it("deletes a body step nothing reads, and the spec stays valid", async () => {
    const { onRemove, now } = setup();
    confirm("alert");
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    expect(now()).not.toContain("tool: post_alert");
    expect(parseSpec(now()).errors).toEqual([]);
  });

  it("blocks a body step a later body step reads, and lists the readers", async () => {
    const { now } = setup();
    confirm("shape");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("cannot be deleted yet");
    expect(alert.textContent).toContain('step "delta"');
    expect(now()).toBe(SOURCE);
  });
});
