import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAN-1859 (ADR-0045): a branch node lists its arms with their steps, read-only, and a stop node says how it ends.
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
  id: triage
  name: Triage
  role: R
  goal: G
  tools:
    - name: reply
      action: http_request
      method: POST
      url: "https://x.example/reply"
  workflow:
    - step: route
      branch:
        switch: "trigger.kind"
        cases:
          bug:
            - step: answer
              type: tool
              tool: reply
          dup:
            - step: ignore
              stop:
                reason: duplicate
        default:
          - step: nested
            branch:
              if: "true"
              then:
                - step: deep
                  type: tool
                  tool: reply
    - step: halt
      stop:
        status: completed
        reason: all done
`;

describe("Canvas branch node", () => {
  afterEach(cleanup);

  it("shows the switch, each arm's heading and steps, and a stop node's status and reason", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    const graph = specToGraph(spec!);
    const layout = Object.fromEntries(
      graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
    );
    render(<Canvas graph={graph} layout={layout} />);
    expect(screen.getByText("Branch: route")).toBeTruthy();
    expect(screen.getByText("switch trigger.kind")).toBeTruthy();
    const headings = [...document.querySelectorAll(".md3-branch__arm")].map((h) => h.textContent);
    expect(headings).toEqual(["case bug", "case dup", "default"]);
    const items = [...document.querySelectorAll(".md3-foreach__steps li")].map(
      (li) => li.textContent,
    );
    expect(items).toEqual(["Tool step: answer", "Stop: ignore", "Branch: nested"]);
    expect(screen.getByText("Stop: halt")).toBeTruthy();
    expect(screen.getByText(/ends the run as completed: all done/)).toBeTruthy();
  });
});

describe("WorkflowStepForm branch and stop", () => {
  afterEach(cleanup);

  it("builds an if/else branch of tool steps", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "route" } });
    fireEvent.change(screen.getByLabelText("If (expression that gives true or false)"), {
      target: { value: "triage.ok = true" },
    });
    fireEvent.change(screen.getByLabelText("Then (one tool per line, step: tool)"), {
      target: { value: "answer: reply" },
    });
    fireEvent.change(screen.getByLabelText("Else (optional, one tool per line)"), {
      target: { value: "escalate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    expect(onSubmit).toHaveBeenCalledWith({
      step: "route",
      branch: {
        if: "triage.ok = true",
        then: [{ step: "answer", type: "tool", tool: "reply" }],
        else: [{ step: "escalate", type: "tool", tool: "escalate" }],
      },
    });
  });

  it("shows an error for an empty then", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "route" } });
    fireEvent.change(screen.getByLabelText("If (expression that gives true or false)"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Add at least one then step/)).toBeTruthy();
  });

  it("builds a stop with a reason and a status", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "halt" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "nothing to do" } });
    fireEvent.change(screen.getByLabelText("Ends the run as"), { target: { value: "completed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    expect(onSubmit).toHaveBeenCalledWith({
      step: "halt",
      stop: { reason: "nothing to do", status: "completed" },
    });
  });
});
