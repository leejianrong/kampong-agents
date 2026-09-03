import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { App } from "../../src/App.js";

// @xyflow/react uses ResizeObserver internally, which jsdom doesn't implement.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
});

describe("@kampong/canvas-app scaffolding", () => {
  it("renders the canvas without crashing", () => {
    render(<App />);
    expect(screen.getByText("Trigger")).toBeTruthy();
  });
});
