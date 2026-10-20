import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, type PatchOp, type SpecOp } from "@kampong/spec";
import { App } from "../../src/App.js";
import { StepsPanel } from "../../src/StepsPanel.js";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";
import { chooseFromMenu } from "./menu.js";

// KAM-154: the branch's own field is editable in place, a switch can be built in the Add form, and a step of any
// kind can be added to an arm. The market-etl template (the `anomaly` branch inside the loop) is the fixture.

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

describe("StepsPanel: editing a branch", () => {
  afterEach(cleanup);

  it("opens the condition and saves a patch of it, at the branch's own path", async () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit anomaly");
    const field = screen.getByLabelText("Go this way when this is true");
    expect((field as HTMLInputElement).value).toContain("vars.threshold");
    fireEvent.change(field, { target: { value: "$abs(delta.change_pct) >= 5" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        {
          op: "set",
          path: ["agent", "workflow", 0, "foreach", "steps", 7, "branch", "if"],
          value: "$abs(delta.change_pct) >= 5",
        },
      ]),
    );
  });

  it("says why a condition does not parse and keeps the form open", () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async () => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit anomaly");
    fireEvent.change(screen.getByLabelText("Go this way when this is true"), {
      target: { value: "a +" },
    });
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain("if:");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("edits a step inside an arm at its own path", async () => {
    const { spec } = parseSpec(SOURCE);
    const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
    render(<StepsPanel spec={spec!} onPatch={onPatch} />);
    click("Edit alert");
    fireEvent.change(screen.getByLabelText("Tool to call"), { target: { value: "upsert_price" } });
    click("Save step");
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    const [ops] = onPatch.mock.calls[0]!;
    expect(ops).toEqual([
      {
        op: "set",
        path: ["agent", "workflow", 0, "foreach", "steps", 7, "branch", "then", 1, "tool"],
        value: "upsert_price",
      },
    ]);
  });
});

describe("WorkflowStepForm: a switch branch", () => {
  afterEach(cleanup);

  it("builds one from a value, cases and a default", async () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={() => {}} />);
    click("Branch");
    fireEvent.change(screen.getByLabelText("Branch on"), { target: { value: "switch" } });
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "route" } });
    fireEvent.change(screen.getByLabelText("Switch on (expression that gives the value)"), {
      target: { value: "trigger.kind" },
    });
    fireEvent.change(screen.getByLabelText("Cases (one per line, value: step: tool)"), {
      target: { value: "bug: send_bug: reply\nbilling: send_bill: reply" },
    });
    fireEvent.change(screen.getByLabelText("Default (optional, one tool per line)"), {
      target: { value: "other: reply" },
    });
    click("Save step");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      step: "route",
      branch: {
        switch: "trigger.kind",
        cases: {
          bug: [{ step: "send_bug", type: "tool", tool: "reply" }],
          billing: [{ step: "send_bill", type: "tool", tool: "reply" }],
        },
        default: [{ step: "other", type: "tool", tool: "reply" }],
      },
    });
  });

  it("shows a message for a case line with no step", () => {
    render(<WorkflowStepForm onSubmit={() => {}} onCancel={() => {}} />);
    click("Branch");
    fireEvent.change(screen.getByLabelText("Branch on"), { target: { value: "switch" } });
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "r" } });
    fireEvent.change(screen.getByLabelText("Switch on (expression that gives the value)"), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByLabelText("Cases (one per line, value: step: tool)"), {
      target: { value: "bug" },
    });
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain('is not "value: step: tool"');
  });
});

describe("App: adding a step to a branch arm", () => {
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy());
    chooseFromMenu("Add Workflow Step");
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "anomaly/else" } });
  };

  it("offers each arm, and sends a step.insert at the arm's place (an else that is not there yet)", async () => {
    const sent = open();
    await start();
    click("Transform");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "calm" } });
    fireEvent.change(screen.getByLabelText("Values (one per line, name: expression)"), {
      target: { value: "note: 'quiet'" },
    });
    click("Save step");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      {
        op: "step.insert",
        place: { in: { step: "anomaly", slot: "else" } },
        step: { step: "calm", type: "transform", set: { note: "'quiet'" } },
      },
    ]);
  });

  it("shows a refusal in the form", async () => {
    open(true);
    await start();
    click("Approval");
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "ask" } });
    click("Save step");
    expect((await screen.findByRole("alert")).textContent).toContain("approval cannot go");
  });
});
