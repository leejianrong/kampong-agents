import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_HEIGHT, PanelResizer, clampHeight, maxHeight } from "../../src/PanelResizer.js";

// KAM-273: the run log's height is set by drag or by key, kept inside the window, and remembered.

afterEach(cleanup);

describe("clampHeight", () => {
  it("keeps the panel between a minimum and most of the window", () => {
    expect(clampHeight(10, 900)).toBe(MIN_HEIGHT);
    expect(clampHeight(5000, 900)).toBe(maxHeight(900));
    expect(maxHeight(900)).toBe(630);
    expect(clampHeight(300.4, 900)).toBe(300);
  });
});

describe("PanelResizer", () => {
  const setup = (height: number | undefined) => {
    const onChange = vi.fn();
    render(<PanelResizer height={height} onChange={onChange} measure={() => 208} />);
    return { onChange, bar: screen.getByTestId("run-log-resizer") };
  };

  it("is a separator with its current height, from the measured one until one is set", () => {
    const { bar } = setup(undefined);
    expect(bar.getAttribute("role")).toBe("separator");
    expect(bar.getAttribute("aria-valuenow")).toBe("208");
    expect(bar.getAttribute("tabindex")).toBe("0");
  });

  it("grows with Up, shrinks with Down, and jumps with Home and End", () => {
    const { bar, onChange } = setup(300);
    fireEvent.keyDown(bar, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(324);
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(276);
    fireEvent.keyDown(bar, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(MIN_HEIGHT);
    fireEvent.keyDown(bar, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(maxHeight(window.innerHeight));
  });

  it("does not take a key it does not own", () => {
    const { bar, onChange } = setup(300);
    fireEvent.keyDown(bar, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
