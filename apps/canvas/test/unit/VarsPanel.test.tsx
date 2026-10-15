import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpecVar } from "@kampong/spec";
import { VarsPanel } from "../../src/VarsPanel.js";

// KAM-159: the Spec vars panel. The form logic itself is tested in packages/spec (vars-form.test.ts); this
// covers what the panel adds: the list, the add/edit/remove flow, and the version gate.

const VARS: Record<string, SpecVar> = {
  symbols: { type: "list", default: ["AAPL", "MSFT"], description: "Tickers" },
  threshold: { type: "number", default: 1.5 },
};

function setup(props: Partial<React.ComponentProps<typeof VarsPanel>> = {}) {
  const onSave = vi.fn(async () => true);
  const onRemove = vi.fn(async () => true);
  render(<VarsPanel version="1.1" vars={VARS} onSave={onSave} onRemove={onRemove} {...props} />);
  return { onSave, onRemove };
}
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });

describe("VarsPanel", () => {
  afterEach(cleanup);

  it("lists each var with its type, default and description", () => {
    setup();
    const list = screen.getByTestId("vars-list");
    expect(within(list).getByText("symbols")).toBeTruthy();
    expect(
      within(list).getByText(/list of string, default \["AAPL","MSFT"\] — Tickers/),
    ).toBeTruthy();
    expect(within(list).getByText(/number, default 1.5/)).toBeTruthy();
  });

  it("says so when there are none", () => {
    setup({ vars: undefined });
    expect(screen.getByText("This spec declares no vars.")).toBeTruthy();
  });

  it("adds a var: validates, then saves the built value", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    expect(screen.getByRole("alert").textContent).toContain("A var needs a name");
    expect(onSave).not.toHaveBeenCalled();

    type("Name", "channel");
    type("Default", "#alerts");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("channel", { type: "string", default: "#alerts" }),
    );
    // The form closes once the save went through.
    await waitFor(() => expect(screen.queryByRole("form", { name: "Spec var" })).toBeNull());
  });

  it("refuses a duplicate name", () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    type("Name", "symbols");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    expect(screen.getByRole("alert").textContent).toContain('a var named "symbols" already exists');
    expect(onSave).not.toHaveBeenCalled();
  });

  it("edits in place: the name is fixed, and the default is parsed for the type", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit threshold" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    type("Default", "3");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("threshold", { type: "number", default: 3 }),
    );
  });

  it("a list asks what it holds", async () => {
    const { onSave } = setup({ vars: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    type("Name", "ids");
    type("Type", "list");
    type("List holds", "number");
    type("Default", "1, 2");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("ids", {
        type: "list",
        items: "number",
        default: [1, 2],
      }),
    );
  });

  it("keeps the form and its input open, with a message, when the save fails", async () => {
    const onSave = vi.fn(async () => false);
    setup({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Add var" }));
    type("Name", "keep_me");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not save"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("keep_me");
  });

  it("removes a var", async () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove threshold" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("threshold"));
  });

  it("on a 1.0 spec explains why and offers no way to add", () => {
    setup({ version: "1.0", vars: undefined });
    expect(screen.getByRole("status").textContent).toContain('Vars need spec version "1.1"');
    expect((screen.getByRole("button", { name: "Add var" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
