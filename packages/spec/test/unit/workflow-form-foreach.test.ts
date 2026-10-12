import { describe, expect, it } from "vitest";
import { buildWorkflowStepFromForm } from "../../src/workflow-form.js";

// KAN-1858: the "Add Workflow Step" form builds a foreach whose body is a list of tool steps.
describe("buildWorkflowStepFromForm: foreach", () => {
  it("builds a foreach with the default policy and tool steps from `step: tool` lines", () => {
    const r = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "each",
      items: "trigger.symbols",
      as: "symbol",
      body: "fetch: fetch_price\nstore_row",
    });
    expect(r.errors).toBeUndefined();
    expect(r.step).toEqual({
      step: "each",
      foreach: {
        items: "trigger.symbols",
        as: "symbol",
        steps: [
          { step: "fetch", type: "tool", tool: "fetch_price" },
          { step: "store_row", type: "tool", tool: "store_row" },
        ],
      },
    });
  });

  it("carries concurrency and an on_error policy, with retry as a count", () => {
    const r = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "each",
      items: "x",
      as: "i",
      body: "t",
      concurrency: 4,
      onError: "retry",
      retryCount: 2,
    });
    expect(r.step).toMatchObject({ foreach: { concurrency: 4, on_error: { retry: { n: 2 } } } });
    const c = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "each",
      items: "x",
      as: "i",
      body: "t",
      onError: "continue",
    });
    expect(c.step).toMatchObject({ foreach: { on_error: "continue" } });
  });

  it("reports an empty body and invalid numbers as errors", () => {
    expect(
      buildWorkflowStepFromForm({ kind: "foreach", step: "e", items: "x", as: "i", body: " \n " })
        .errors,
    ).toEqual(["Add at least one body step as a tool name (or step: tool)"]);
    const bad = buildWorkflowStepFromForm({
      kind: "foreach",
      step: "e",
      items: "x",
      as: "i",
      body: "t",
      concurrency: 0,
    });
    expect(bad.success).toBe(false);
  });
});
