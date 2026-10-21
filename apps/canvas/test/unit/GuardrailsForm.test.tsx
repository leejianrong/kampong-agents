import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardrailsForm, thresholdProblemOf } from "../../src/GuardrailsForm.js";

// KAM-180: the guardrails form checks the threshold inline, in the page's style, and says what each field does.

describe("thresholdProblemOf", () => {
  it("accepts blank and 0 to 1, and says what is wrong with anything else", () => {
    for (const ok of ["", "  ", "0", "0.8", "1", "0.05", ".5"])
      expect(thresholdProblemOf(ok), ok).toBeNull();
    expect(thresholdProblemOf("1.5")).toBe(
      "the threshold must be from 0 to 1, and 1.5 is above that.",
    );
    expect(thresholdProblemOf("-0.1")).toBe(
      "the threshold must be from 0 to 1, and -0.1 is below that.",
    );
    expect(thresholdProblemOf("abc")).toMatch(/must be a number/);
    expect(thresholdProblemOf("Infinity")).toMatch(/must be a number/);
  });
});

describe("GuardrailsForm", () => {
  afterEach(cleanup);

  const threshold = () => screen.getByLabelText("Confidence threshold") as HTMLInputElement;

  it("explains both fields, tied to them for a screen reader", () => {
    render(<GuardrailsForm onSubmit={() => {}} onCancel={() => {}} />);
    const help = document.getElementById(
      threshold().getAttribute("aria-describedby")!.split(" ")[0]!,
    )!;
    expect(help.textContent).toMatch(/less sure than this/);
    expect(help.textContent).toMatch(/0 to 1/);
    const fallback = screen.getByLabelText("Fallback action");
    const fallbackHelp = document.getElementById(fallback.getAttribute("aria-describedby")!)!;
    expect(fallbackHelp.textContent).toMatch(/waits for a person/);
  });

  it("shows an out-of-range value inline as you type, not as a browser bubble, and blocks the save", () => {
    const onSubmit = vi.fn();
    render(<GuardrailsForm onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.queryByTestId("threshold-error")).toBeNull();

    fireEvent.change(threshold(), { target: { value: "1.5" } });
    const error = screen.getByTestId("threshold-error");
    expect(error.textContent).toBe(
      "Problem: the threshold must be from 0 to 1, and 1.5 is above that.",
    );
    expect(error.getAttribute("role")).toBe("alert");
    expect(threshold().getAttribute("aria-invalid")).toBe("true");
    expect(threshold().getAttribute("aria-describedby")).toContain(error.id);
    // No native validation in the way: the form is novalidate and the input has no min/max to trip.
    expect(screen.getByRole("form", { name: "Set Guardrails" }).hasAttribute("novalidate")).toBe(
      true,
    );
    expect(threshold().hasAttribute("max")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save guardrails" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(threshold());

    fireEvent.change(threshold(), { target: { value: "0.9" } });
    expect(screen.queryByTestId("threshold-error")).toBeNull();
    expect(threshold().getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save guardrails" }));
    expect(onSubmit).toHaveBeenCalledWith({
      confidence_threshold: 0.9,
      fallback_action: "escalate_to_human",
    });
  });

  it("saves a blank threshold as no threshold, and a step such as 0.05 is fine", () => {
    const onSubmit = vi.fn();
    render(<GuardrailsForm onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(threshold(), { target: { value: "0.33" } });
    expect(screen.queryByTestId("threshold-error")).toBeNull();
    fireEvent.change(threshold(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save guardrails" }));
    expect(onSubmit).toHaveBeenCalledWith({ fallback_action: "escalate_to_human" });
  });
});
