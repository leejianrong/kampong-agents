import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InspectorTabs, NO_RUN_YET } from "../../src/InspectorTabs.js";

// KAM-212: the shell every node form sits in. ARIA tabs pattern, nothing invented on Output and Test.

const names = () => screen.getAllByRole("tab").map((t) => t.textContent);

describe("InspectorTabs", () => {
  afterEach(cleanup);

  it("has Setup, Output, Test and Settings, with Setup open", () => {
    render(<InspectorTabs setup={<input aria-label="Field" />} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(names()).toEqual(["Setup", "Output", "Test", "Settings"]);
    expect(screen.getByRole("tab", { name: "Setup" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Setup" })).toBeTruthy();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("links each tab to its panel and keeps one tab in the tab order", () => {
    render(<InspectorTabs setup={<p>s</p>} />);
    for (const tab of screen.getAllByRole("tab")) {
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    const stops = screen.getAllByRole("tab").filter((t) => t.tabIndex === 0);
    expect(stops.map((t) => t.textContent)).toEqual(["Setup"]);
  });

  it("moves with the arrow keys, wrapping, and Home and End", () => {
    render(<InspectorTabs setup={<p>s</p>} />);
    const selected = () =>
      screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")
        ?.textContent;
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("Output");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Output" }));
    fireEvent.keyDown(list, { key: "End" });
    expect(selected()).toBe("Settings");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("Setup");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(selected()).toBe("Settings");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selected()).toBe("Setup");
  });

  it("says to run the workflow on Output and Test, and shows no data", () => {
    render(<InspectorTabs setup={<p>s</p>} />);
    for (const tab of ["Output", "Test"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      const panel = screen.getByRole("tabpanel", { name: tab });
      expect(panel.textContent).toContain(NO_RUN_YET);
      expect(panel.querySelector("pre, code, table")).toBeNull();
    }
  });

  it("keeps what was typed on a tab when another is opened", () => {
    render(<InspectorTabs setup={<p>s</p>} settings={<input aria-label="Creativity" />} />);
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Creativity"), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect((screen.getByLabelText("Creativity") as HTMLInputElement).value).toBe("0.4");
  });

  it("says so when a step has no settings", () => {
    render(<InspectorTabs setup={<p>s</p>} />);
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByTestId("no-settings")).toBeTruthy();
  });
});
