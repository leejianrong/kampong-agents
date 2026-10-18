import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAN-1860: the version 1.1 data steps in the "Add Workflow Step" form.
describe("WorkflowStepForm data steps", () => {
  afterEach(() => {
    cleanup();
  });

  it("builds a transform step from name: expression lines", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "shape" } });
    fireEvent.change(screen.getByLabelText("Values (one per line, name: expression)"), {
      target: { value: "change: (a.close - a.open) / a.open * 100\nsize: $abs(a.close - a.open)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));

    expect(onSubmit).toHaveBeenCalledWith({
      step: "shape",
      type: "transform",
      set: { change: "(a.close - a.open) / a.open * 100", size: "$abs(a.close - a.open)" },
    });
  });

  it("builds a validate step and offers only fail and skip", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "check" } });
    fireEvent.change(screen.getByLabelText("Assert (expression that must be true)"), {
      target: { value: "a.open > 0" },
    });
    const onFail = screen.getByLabelText("On fail") as HTMLSelectElement;
    expect([...onFail.options].map((o) => o.value)).toEqual(["fail", "skip"]);
    fireEvent.change(onFail, { target: { value: "skip" } });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));

    expect(onSubmit).toHaveBeenCalledWith({
      step: "check",
      type: "validate",
      assert: "a.open > 0",
      on_fail: "skip",
    });
  });

  it("builds a dedupe step and shows an error for a missing key", () => {
    const onSubmit = vi.fn();
    render(<WorkflowStepForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Dedupe" }));
    fireEvent.change(screen.getByLabelText("Step ID"), { target: { value: "seen" } });
    fireEvent.change(screen.getByLabelText("Remember for (e.g. 24h, 7d)"), {
      target: { value: "24h" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Key (expression)"), {
      target: { value: "trigger.id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save step" }));
    expect(onSubmit).toHaveBeenCalledWith({
      step: "seen",
      type: "dedupe",
      once: { key: "trigger.id", ttl: "24h" },
    });
  });
});
