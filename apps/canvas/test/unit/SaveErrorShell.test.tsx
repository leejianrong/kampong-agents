import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Panel, SaveErrorContext } from "../../src/Panel.js";

// KAM-195 / KAM-194: a failed save is explained once, inside the open panel, and goes when the input changes.

describe("Panel save failure", () => {
  afterEach(cleanup);

  it("shows the failure above the form, once, and clears it when something is typed", () => {
    const clear = vi.fn();
    render(
      <SaveErrorContext.Provider value={{ message: "Could not save: the disk is full.", clear }}>
        <Panel title="Vars" onClose={() => {}}>
          <input aria-label="Name" />
        </Panel>
      </SaveErrorContext.Provider>,
    );
    expect(screen.getAllByText("Could not save: the disk is full.")).toHaveLength(1);
    expect(screen.getByTestId("panel-save-error").getAttribute("role")).toBe("alert");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("says nothing, and does not clear, when nothing failed", () => {
    const clear = vi.fn();
    render(
      <SaveErrorContext.Provider value={{ message: null, clear }}>
        <Panel title="Vars" onClose={() => {}}>
          <input aria-label="Name" />
        </Panel>
      </SaveErrorContext.Provider>,
    );
    expect(screen.queryByTestId("panel-save-error")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x" } });
    expect(clear).not.toHaveBeenCalled();
  });

  it("does not show it in a panel that is kept out of sight", () => {
    render(
      <SaveErrorContext.Provider value={{ message: "Could not save: x.", clear: () => {} }}>
        <Panel title="Vars" onClose={() => {}} hidden>
          <input aria-label="Name" />
        </Panel>
      </SaveErrorContext.Provider>,
    );
    expect(screen.queryByTestId("panel-save-error")).toBeNull();
  });
});
