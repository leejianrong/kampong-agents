import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStepForm } from "../../src/WorkflowStepForm.js";

// KAM-176: each step kind says what it does, with an example, when selected; Condition is for 1.0 specs only.

const open = (version?: string) =>
  render(
    <WorkflowStepForm {...(version && { version })} onSubmit={() => {}} onCancel={() => {}} />,
  );
const help = () => screen.getByTestId("step-kind-help").textContent ?? "";

describe("Add Workflow Step kind help", () => {
  afterEach(cleanup);

  it.each([
    ["Action", /Ask the model/],
    ["Tool", /Call one of the tools/],
    ["Approval", /Wait for a person/],
    ["Condition", /only if a condition is true/],
    ["Transform", /Work out new values/],
    ["Validate", /Check that the data/],
    ["Dedupe", /Skip anything already handled/],
    ["Foreach", /Repeat the steps inside for each item/],
    ["Branch", /Choose between groups of steps/],
    ["Stop", /End the run here/],
  ])("%s explains itself, with an example, once selected", (kind, what) => {
    open("1.0");
    fireEvent.click(screen.getByRole("button", { name: kind }));
    expect(help()).toMatch(what);
    expect(help()).toContain("Example:");
  });

  it("offers Condition on a 1.0 spec and hides it on 1.1", () => {
    open("1.0");
    expect(screen.getByRole("button", { name: "Condition" })).toBeTruthy();
    cleanup();
    open("1.1");
    expect(screen.queryByRole("button", { name: "Condition" })).toBeNull();
    expect(screen.getByRole("button", { name: "Branch" })).toBeTruthy();
  });
});
