import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { StepsPanel } from "../../src/StepsPanel.js";
import { renameErrorWords, type RenameOutcome } from "../../src/DeleteControl.js";

// KAM-172: Rename on the step and tool rows of the Edit Steps panel.

const spec = {
  version: "1.1",
  agent: {
    id: "a",
    name: "A",
    role: "R",
    goal: "G",
    tools: [{ name: "lookup", action: "http_request", method: "GET", url: "https://x.example/" }],
    workflow: [
      { step: "fetch", action: "get" },
      { step: "gate", type: "validate", assert: "fetch.ok = true and fetch.n > 0" },
      {
        step: "each",
        foreach: {
          items: "trigger.items",
          as: "item",
          steps: [{ step: "inner", type: "tool", tool: "lookup" }],
        },
      },
      {
        step: "pick",
        branch: { if: "fetch.ok = true", then: [{ step: "arm", action: "x" }] },
      },
    ],
  },
} as unknown as AgentSpec;

const ok: RenameOutcome = { success: true };

function setup(onRename = vi.fn(async (_op: unknown): Promise<RenameOutcome> => ok)) {
  render(
    <StepsPanel
      spec={spec}
      onPatch={vi.fn(async () => true)}
      onEditTool={vi.fn()}
      onRename={onRename}
    />,
  );
  return { onRename };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("New name"), { target: { value } });

describe("StepsPanel rename", () => {
  afterEach(cleanup);

  it("says how many places will be updated and renames by name", async () => {
    const { onRename } = setup();
    click("Rename step fetch");
    // `gate`'s assert (one field, read twice), `pick`'s condition: two places.
    expect(screen.getByText("2 places will be updated to the new name.")).toBeTruthy();
    type("get_price");
    fireEvent.click(screen.getByRole("button", { name: "Rename step" }));
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith({ op: "step.rename", step: "fetch", to: "get_price" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("New name")).toBeNull());
  });

  it("works for a step in a foreach body and one in a branch arm, and says when nothing uses the name", async () => {
    const { onRename } = setup();
    for (const name of ["inner", "arm"]) {
      click(`Rename step ${name}`);
      expect(screen.getByText("Nothing else uses this step's name.")).toBeTruthy();
      type(`${name}_2`);
      fireEvent.click(screen.getByRole("button", { name: "Rename step" }));
      await waitFor(() =>
        expect(onRename).toHaveBeenCalledWith({ op: "step.rename", step: name, to: `${name}_2` }),
      );
    }
  });

  it("renames a tool and counts the steps that use it", async () => {
    const { onRename } = setup();
    click("Rename tool lookup");
    expect(screen.getByText("1 place will be updated to the new name.")).toBeTruthy();
    type("find_order");
    fireEvent.click(screen.getByRole("button", { name: "Rename tool" }));
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith({
        op: "tool.rename",
        tool: "lookup",
        to: "find_order",
      }),
    );
  });

  it("keeps the typed name and shows a refusal in words next to the field", async () => {
    setup(
      vi.fn(async () => ({
        success: false as const,
        messages: [renameErrorWords({ code: "name_taken", message: "x" }, "step", "gate")],
      })),
    );
    click("Rename step fetch");
    type("gate");
    fireEvent.click(screen.getByRole("button", { name: "Rename step" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      'The name "gate" is already used by another step. Pick a different name.',
    );
    expect((screen.getByLabelText("New name") as HTMLInputElement).value).toBe("gate");
    // Typing again clears the message so the next try starts clean.
    type("gate2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes without calling when the name is unchanged, and Cancel leaves everything alone", () => {
    const { onRename } = setup();
    click("Rename step fetch");
    fireEvent.click(screen.getByRole("button", { name: "Rename step" }));
    expect(screen.queryByLabelText("New name")).toBeNull();
    click("Rename step fetch");
    type("other");
    click("Cancel");
    expect(screen.queryByLabelText("New name")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("has no Rename buttons when the host does not offer renaming", () => {
    render(<StepsPanel spec={spec} onPatch={vi.fn(async () => true)} onEditTool={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
  });

  it("puts each refusal code in plain words", () => {
    expect(
      renameErrorWords(
        { code: "invalid_name", message: '"trigger" is a reserved name' },
        "step",
        "trigger",
      ),
    ).toContain("cannot be used as a name");
    expect(
      renameErrorWords({ code: "unrewritable", message: "step f is read..." }, "step", "x"),
    ).toContain("Change it by hand");
    expect(renameErrorWords({ message: "bad" }, "tool", "x")).toContain("no longer be valid");
  });
});
