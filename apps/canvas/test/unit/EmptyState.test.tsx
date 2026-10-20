import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";
import type { ApiClient } from "../../src/api.js";

// KAM-196: the empty states and the invalid-YAML banner, against a stubbed ApiClient.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const GOOD = {
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
  source: 'version: "1.0"\n',
};

const EMPTY_WORKFLOW_SOURCE =
  'version: "1.0"\nagent:\n  id: a\n  name: A\n  role: r\n  goal: g\n  workflow: []\n';

function apiWith(load: () => unknown, extra: Partial<ApiClient> = {}): ApiClient {
  return {
    loadSpec: vi.fn(async () => load()),
    applyPatch: async () => ({ success: true }),
    applyOps: async () => ({ success: true }),
    replaceSource: async () => ({ success: true }),
    startBlank: async () => ({ success: true }),
    subscribeToEvents: () => () => {},
    startRun: vi.fn(async () => ({ success: true })),
    approveRun: async () => ({ success: true }),
    subscribeToRunEvents: () => () => {},
    ...extra,
  } as unknown as ApiClient;
}

describe("empty states (KAM-196)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("shows the new-workflow state, with no error banner, when there is no spec file", async () => {
    const api = apiWith(() => ({
      success: false,
      missing: true,
      errors: [],
      layout: {},
      source: "",
    }));
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(screen.getByTestId("empty-state").getAttribute("data-kind")).toBe("new");
    expect(screen.queryByTestId("spec-error-banner")).toBeNull();
    expect(screen.queryByTestId("spec-errors")).toBeNull();
    expect(screen.getByTestId("start-blank")).toBeTruthy();
    // Nothing to edit yet, so the build tools are not offered.
    // Nothing to edit yet: the menu has no Add tool, only import.
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "Add tool" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Import YAML" })).toBeTruthy();
  });

  it("Start blank asks the server to create the workflow, then loads it", async () => {
    let created = false;
    const startBlank = vi.fn(async () => {
      created = true;
      return { success: true };
    });
    const api = apiWith(
      () =>
        created ? GOOD : { success: false, missing: true, errors: [], layout: {}, source: "" },
      { startBlank },
    );
    render(<App api={api} />);
    await waitFor(() => screen.getByTestId("start-blank"));

    fireEvent.click(screen.getByTestId("start-blank"));

    await waitFor(() => expect(screen.getByText(/^Manual$/)).toBeTruthy());
    expect(startBlank).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("says why when Start blank is refused", async () => {
    const api = apiWith(
      () => ({ success: false, missing: true, errors: [], layout: {}, source: "" }),
      {
        startBlank: async () => ({
          success: false,
          errors: [{ path: [], message: "Has content." }],
        }),
      },
    );
    render(<App api={api} />);
    await waitFor(() => screen.getByTestId("start-blank"));
    fireEvent.click(screen.getByTestId("start-blank"));

    await waitFor(() =>
      expect(screen.getByTestId("empty-state-error").textContent).toBe("Has content."),
    );
  });

  it("shows the no-steps state for workflow: [] instead of a raw schema error", async () => {
    const api = apiWith(() => ({
      success: false,
      errors: [
        { path: ["agent", "workflow"], message: "Too small: expected array to have >=1 items" },
      ],
      layout: {},
      source: EMPTY_WORKFLOW_SOURCE,
    }));
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(screen.getByTestId("empty-state").getAttribute("data-kind")).toBe("steps");
    expect(screen.queryByTestId("spec-errors")).toBeNull();

    fireEvent.click(screen.getByTestId("empty-add-step"));
    expect(screen.getByRole("form", { name: "Add Workflow Step" })).toBeTruthy();
  });

  it("Test Run says why it cannot start instead of 'Failed to start run.'", async () => {
    const startRun = vi.fn(async () => ({ success: false }));
    const api = apiWith(
      () => ({
        success: false,
        errors: [{ path: ["agent", "workflow"], message: "Too small" }],
        layout: {},
        source: EMPTY_WORKFLOW_SOURCE,
      }),
      { startRun },
    );
    render(<App api={api} />);
    await waitFor(() => screen.getByTestId("empty-state"));

    fireEvent.click(screen.getByRole("button", { name: "Test Run" }));

    expect(screen.getByTestId("run-blocked").textContent).toContain("no steps yet");
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    expect(startRun).not.toHaveBeenCalled();
  });
});

describe("invalid YAML banner (KAM-196)", () => {
  afterEach(cleanup);

  it("names the line, says it is the last valid version, and says saves are paused", async () => {
    let call = 0;
    const api = apiWith(() =>
      call++ === 0
        ? GOOD
        : {
            success: false,
            errors: [
              {
                path: [],
                message: "Flow sequence in block collection must be sufficiently indented",
                line: 7,
                column: 3,
              },
            ],
            layout: {},
            source: "agent: [\n",
          },
    );
    let fire: ((e: { type: string; source: string }) => void) | undefined;
    api.subscribeToEvents = (cb) => {
      fire = cb;
      return () => {};
    };
    render(<App api={api} />);
    await waitFor(() => screen.getByText(/^Manual$/));

    fire?.({ type: "reload", source: "" });

    await waitFor(() => expect(screen.getByTestId("spec-errors-summary")).toBeTruthy());
    const text = screen.getByTestId("spec-errors-summary").textContent;
    expect(text).toContain("Showing the last valid version");
    expect(text).toContain("fix line 7");
    expect(text).toContain("Saves are paused");
    // The last valid canvas is still there.
    expect(screen.getByText(/^Manual$/)).toBeTruthy();
  });
});
