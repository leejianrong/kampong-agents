import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec, PatchOp } from "@kampong/spec";
import { StepsPanel } from "../../src/StepsPanel.js";

// KAM-162: the step editor. The form logic is tested in packages/spec (step-edit.test.ts); this covers the
// list, the in-place form, the output schema tree and the version gate.

const spec = (version = "1.1", extra: Record<string, unknown> = {}): AgentSpec =>
  ({
    version,
    agent: {
      id: "a",
      name: "A",
      role: "R",
      goal: "G",
      workflow: [
        { step: "classify", action: "classify", temperature: 0.2, ...extra },
        { step: "pay", type: "approval" },
        {
          step: "each",
          foreach: {
            items: "trigger.items",
            as: "item",
            steps: [{ step: "inner", action: "sum" }],
          },
        },
      ],
    },
  }) as unknown as AgentSpec;

function setup(s: AgentSpec = spec()) {
  const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
  render(<StepsPanel spec={s} onPatch={onPatch} />);
  return { onPatch };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });

describe("StepsPanel", () => {
  afterEach(cleanup);

  it("lists every step, nested ones with their parent, and edits only action steps", () => {
    setup();
    const list = screen.getByTestId("steps-list");
    expect(within(list).getByText("classify")).toBeTruthy();
    expect(within(list).getByText("approval")).toBeTruthy();
    expect(within(list).getByText("action in each")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit classify" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit inner" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit pay" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit each" })).toBeNull();
  });

  it("opens a step with its values and saves a patch of only what changed", async () => {
    const { onPatch } = setup();
    click("Edit classify");
    expect((screen.getByLabelText("Temperature") as HTMLInputElement).value).toBe("0.2");
    change("Model", "gpt-x");
    change("Instructions", "Be brief.");
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "set", path: ["agent", "workflow", 0, "instructions"], value: "Be brief." },
        { op: "set", path: ["agent", "workflow", 0, "model"], value: "gpt-x" },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  });

  it("edits a nested step at its own path", async () => {
    const { onPatch } = setup();
    click("Edit inner");
    change("Model", "m");
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "set", path: ["agent", "workflow", 2, "foreach", "steps", 0, "model"], value: "m" },
      ]),
    );
  });

  it("clears a field and says what is wrong with a bad one", async () => {
    const { onPatch } = setup();
    click("Edit classify");
    change("Temperature", "");
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "remove", path: ["agent", "workflow", 0, "temperature"] },
      ]),
    );
    click("Edit classify");
    change("Temperature", "9");
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain("must be a number from 0 to 2");
  });

  it("builds an output schema with nested properties", async () => {
    const { onPatch } = setup();
    click("Edit inner");
    click("Add output schema");
    click("Add property to output_schema");
    change("output_schema property 1 name", "label");
    change("output_schema.label allowed values", "spam, ham");
    fireEvent.click(screen.getByLabelText("output_schema.label required"));
    click("Add property to output_schema");
    change("output_schema property 2 name", "detail");
    change("output_schema.detail type", "object");
    click("Add property to output_schema.detail");
    change("output_schema.detail property 1 name", "why");
    click("Save step");
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0]![0]).toEqual([
      {
        op: "set",
        path: ["agent", "workflow", 2, "foreach", "steps", 0, "output_schema"],
        value: {
          type: "object",
          properties: {
            label: { type: "string", enum: ["spam", "ham"] },
            detail: { type: "object", properties: { why: { type: "string" } } },
          },
          required: ["label"],
        },
      },
    ]);
  });

  it("an array declares its items; an empty object is refused", () => {
    const { onPatch } = setup();
    click("Edit classify");
    click("Add output schema");
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain("must list its properties");
    click("Add property to output_schema");
    change("output_schema property 1 name", "tags");
    change("output_schema.tags type", "array");
    expect(screen.getByLabelText("output_schema.tags[] type", { exact: false })).toBeTruthy();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("edits an existing schema and removes it", async () => {
    const { onPatch } = setup(
      spec("1.1", {
        output_schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      }),
    );
    click("Edit classify");
    expect((screen.getByLabelText("output_schema property 1 name") as HTMLInputElement).value).toBe(
      "a",
    );
    click("Remove output schema");
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "remove", path: ["agent", "workflow", 0, "output_schema"] },
      ]),
    );
  });

  it("keeps the form and says so when the save fails", async () => {
    const { onPatch } = setup();
    onPatch.mockResolvedValueOnce(false);
    click("Edit classify");
    change("Model", "x");
    click("Save step");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not save"));
    expect(screen.getByRole("form", { name: "Edit classify" })).toBeTruthy();
  });

  it("is gated on a 1.0 spec, with no upgrade offer", () => {
    setup(spec("1.0"));
    expect(screen.getByRole("status").textContent).toContain('"1.1"');
    expect(
      (screen.getByRole("button", { name: "Edit classify" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  describe("data steps (KAM-152)", () => {
    const dataSpec = (version = "1.1"): AgentSpec =>
      ({
        version,
        vars: { limit: { type: "number" } },
        agent: {
          id: "a",
          name: "A",
          role: "R",
          goal: "G",
          workflow: [
            { step: "fetch", action: "fetch" },
            { step: "shape", type: "transform", set: { title: "fetch.title" } },
            { step: "check", type: "validate", assert: "$exists(shape.title)", on_fail: "skip" },
            { step: "once", type: "dedupe", once: { key: "shape.title", ttl: "24h" } },
            {
              step: "each",
              foreach: {
                items: "trigger.items",
                as: "row",
                steps: [{ step: "inner", type: "validate", assert: "row.ok" }],
              },
            },
          ],
        },
      }) as unknown as AgentSpec;

    it("offers Edit on transform, validate and dedupe steps, filled with their values", () => {
      setup(dataSpec());
      for (const name of ["shape", "check", "once", "inner"]) {
        expect(screen.getByRole("button", { name: `Edit ${name}` })).toBeTruthy();
      }
      click("Edit shape");
      expect((screen.getByLabelText("Value 1 name") as HTMLInputElement).value).toBe("title");
      expect((screen.getByLabelText("Value 1 expression") as HTMLTextAreaElement).value).toBe(
        "fetch.title",
      );
    });

    it("saves a transform's values as a patch", async () => {
      const { onPatch } = setup(dataSpec());
      click("Edit shape");
      click("Add value");
      change("Value 2 name", "max");
      change("Value 2 expression", "vars.limit");
      click("Save step");
      await waitFor(() =>
        expect(onPatch).toHaveBeenCalledWith([
          { op: "set", path: ["agent", "workflow", 1, "set", "max"], value: "vars.limit" },
        ]),
      );
    });

    it("checks expressions as you type and refuses an unknown name on save", () => {
      const { onPatch } = setup(dataSpec());
      click("Edit shape");
      change("Value 1 expression", "vars.nope");
      expect(screen.getByText(/vars.nope is not declared in vars/)).toBeTruthy();
      click("Save step");
      expect(screen.getByRole("alert").textContent).toContain("vars.nope is not declared");
      expect(onPatch).not.toHaveBeenCalled();
    });

    it("saves validate and dedupe edits", async () => {
      const { onPatch } = setup(dataSpec());
      click("Edit check");
      change("Assert", "$exists(shape.title) and true");
      change("On fail", "fail");
      click("Save step");
      await waitFor(() =>
        expect(onPatch).toHaveBeenCalledWith([
          {
            op: "set",
            path: ["agent", "workflow", 2, "assert"],
            value: "$exists(shape.title) and true",
          },
          { op: "set", path: ["agent", "workflow", 2, "on_fail"], value: "fail" },
        ]),
      );
      click("Edit once");
      change("TTL", "soon");
      click("Save step");
      expect(screen.getByRole("alert").textContent).toMatch(/^ttl: /);
    });

    it("lets a step in a foreach read the loop variable", async () => {
      const { onPatch } = setup(dataSpec());
      click("Edit inner");
      change("Assert", "row.ok = true");
      expect(screen.queryByText(/not something an expression can read/)).toBeNull();
      click("Save step");
      await waitFor(() =>
        expect(onPatch).toHaveBeenCalledWith([
          {
            op: "set",
            path: ["agent", "workflow", 4, "foreach", "steps", 0, "assert"],
            value: "row.ok = true",
          },
        ]),
      );
    });

    it("is gated on a 1.0 spec", () => {
      setup(dataSpec("1.0"));
      expect(
        (screen.getByRole("button", { name: "Edit shape" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  // KAM-165: a transform's values are rows, so a multi-line expression is one value.
  it("edits a transform one value at a time, a multi-line one included", async () => {
    const withTransform = {
      version: "1.1",
      agent: {
        id: "a",
        name: "A",
        role: "R",
        goal: "G",
        workflow: [
          { step: "pull", action: "fetch" },
          {
            step: "shape",
            type: "transform",
            set: { latest: "pull.x", total: "$sum([1,\n2])" },
          },
        ],
      },
    } as unknown as AgentSpec;
    const { onPatch } = setup(withTransform);
    click("Edit shape");
    expect((screen.getByLabelText("Value 2 expression") as HTMLTextAreaElement).value).toBe(
      "$sum([1,\n2])",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".md3-expression__problems")).toBeNull();
    change("Value 1 expression", "pull.y");
    click("Add value");
    change("Value 3 name", "extra");
    change("Value 3 expression", "1 + 1");
    click("Remove value 2");
    click("Save step");
    await waitFor(() => expect(onPatch).toHaveBeenCalledTimes(1));
    expect(onPatch.mock.calls[0]![0]).toEqual([
      { op: "remove", path: ["agent", "workflow", 1, "set", "total"] },
      { op: "set", path: ["agent", "workflow", 1, "set", "latest"], value: "pull.y" },
      { op: "set", path: ["agent", "workflow", 1, "set", "extra"], value: "1 + 1" },
    ]);
  });
});
