import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";

// KAM-181 and KAM-182: a save is confirmed (toast, announced politely) and a panel's typed input is not thrown
// away by moving to another panel or by Esc without a question.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SOURCE_A = `version: "1.1"
agent:
  id: greeter
  name: Greeter
  role: Front desk
  goal: Greet visitors.
  workflow:
    - step: greet
      action: say_hello
`;
const SOURCE_B = SOURCE_A.replace("say_hello", "say_goodbye");

const specOf = (action: string) => ({
  version: "1.1",
  agent: {
    id: "greeter",
    name: "Greeter",
    role: "Front desk",
    goal: "Greet visitors.",
    workflow: [{ step: "greet", action }],
  },
});

function setup() {
  let saved = false;
  const api = {
    loadSpec: async () => ({
      success: true,
      spec: specOf(saved ? "say_goodbye" : "say_hello"),
      errors: [],
      layout: {},
      source: saved ? SOURCE_B : SOURCE_A,
    }),
    applyPatch: async () => {
      saved = true;
      return { success: true };
    },
    applyOps: async () => ({ success: true }),
    subscribeToEvents: () => () => {},
    startRun: async () => ({ success: true }),
    approveRun: async () => ({ success: true }),
    subscribeToRunEvents: () => () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<App api={api as any} />);
}

const openPanel = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));
const ready = () => waitFor(() => expect(screen.getByText("greet")).toBeTruthy());
const type = (label: string, value: string) =>
  fireEvent.input(screen.getByLabelText(label, { exact: false }), { target: { value } });
const panelOnShow = (name: string) => screen.queryAllByRole("region", { name })[0] ?? null;

describe("drafts and Esc (KAM-182)", () => {
  afterEach(cleanup);

  it("keeps a typed var name when another panel is opened and comes back", async () => {
    setup();
    await ready();
    openPanel(/^Vars/);
    openPanel("Add var");
    type("Name", "keepme");
    openPanel(/^Trigger/);
    expect(panelOnShow("Spec Vars")).toBeNull();
    expect(panelOnShow("Trigger")).toBeTruthy();
    openPanel(/^Vars/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("keepme");
  });

  it("Esc closes a panel with nothing typed straight away", async () => {
    setup();
    await ready();
    openPanel(/^Vars/);
    expect(panelOnShow("Spec Vars")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panelOnShow("Spec Vars")).toBeNull();
    expect(screen.queryByTestId("discard-prompt")).toBeNull();
  });

  it("Esc on a panel with typed input asks; Keep editing keeps it, Discard drops the draft", async () => {
    setup();
    await ready();
    openPanel(/^Vars/);
    openPanel("Add var");
    type("Name", "half");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("discard-prompt")).toBeTruthy();
    expect(panelOnShow("Spec Vars")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByTestId("discard-prompt")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("half");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(panelOnShow("Spec Vars")).toBeNull();
    openPanel(/^Vars/);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("Close on a clean Add Tool form closes it; with typed input it asks", async () => {
    setup();
    await ready();
    openPanel("Menu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add tool" }));
    fireEvent.input(screen.getAllByRole("textbox")[0]!, { target: { value: "half" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Add Tool" }));
    expect(screen.getByTestId("discard-prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(panelOnShow("Add Tool")).toBeNull();
  });
});

describe("save feedback (KAM-181)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("announces a save politely, and the toast goes away by itself", async () => {
    setup();
    await ready();
    const region = screen.getByTestId("save-toast");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    openPanel(/^Vars/);
    openPanel("Add var");
    type("Name", "symbols");
    fireEvent.click(screen.getByRole("button", { name: "Save var" }));
    await waitFor(() => expect(region.textContent).toMatch(/^Saved/));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(region.textContent).toBe("");
  });
});
