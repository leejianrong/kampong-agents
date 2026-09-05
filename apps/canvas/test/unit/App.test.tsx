import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const SPEC_RESPONSE = {
  success: true,
  spec: {
    version: "1.0",
    agent: {
      id: "greeter",
      name: "Greeter",
      role: "Front desk",
      goal: "Greet visitors.",
      workflow: [{ step: "greet", action: "say_hello" }],
    },
  },
  errors: [],
  layout: { "agent:greeter": { x: 0, y: 0 }, "workflow:greet": { x: 260, y: 0 } },
  source: 'version: "1.0"\nagent:\n  id: greeter\n',
};

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

describe("App", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SPEC_RESPONSE }) as Response),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("fetches the spec on mount and renders a node per tool/workflow/guardrails block", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy();
    });
    expect(screen.getByText(/Workflow: greet/)).toBeTruthy();
  });

  it("shows the raw YAML source in the preview panel", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("yaml-preview").textContent).toContain("agent:");
    });
  });

  it("does not show a conflict banner for an ordinary render", async () => {
    render(<App />);

    await waitFor(() => screen.getByText(/Trigger: Greeter/));
    expect(screen.queryByTestId("conflict-banner")).toBeNull();
  });
});
