import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";
import { buildActions, type ActionContext } from "../../src/actions.js";
import { chooseFromMenu } from "./menu.js";

// KAM-214: the run bar (name, saved state, Run, YAML toggle, menu) and the status bar (Vars, Secrets, Guardrails,
// Checks, Trigger) replace the toolbar. Every action the nine buttons had stays reachable.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const SOURCE = `version: "1.1"
agent:
  id: bar_agent
  name: Bar agent
  role: Support
  goal: Handle refunds.
  workflow:
    - step: parse
      action: extract the order
`;
const SPEC = {
  version: "1.1",
  agent: {
    id: "bar_agent",
    name: "Bar agent",
    role: "Support",
    goal: "Handle refunds.",
    workflow: [{ step: "parse", action: "extract the order" }],
  },
};

function open(extra: Record<string, unknown> = {}, load: Record<string, unknown> = {}) {
  const api = {
    loadSpec: async () => ({
      success: true,
      spec: SPEC,
      errors: [],
      layout: {},
      source: SOURCE,
      ...load,
    }),
    applyPatch: async () => ({ success: true }),
    applyOps: async () => ({ success: true }),
    subscribeToEvents: () => () => {},
    startRun: async () => ({ success: true }),
    approveRun: async () => ({ success: true }),
    subscribeToRunEvents: () => () => {},
    ...extra,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<App api={api as any} specName="Refund flow" />);
  return screen.findByText(/^Manual$/);
}

const full = {
  listSecrets: async () => [
    { name: "A_TOKEN", source: "unset", referenced: true },
    { name: "B_TOKEN", source: "unset", referenced: true },
    { name: "C_TOKEN", source: "saved", referenced: true },
    { name: "D_TOKEN", source: "unset", referenced: false },
  ],
  setSecret: async () => [],
  removeSecret: async () => [],
  runDoctor: async () => ({ checks: [] }),
};

describe("run bar", () => {
  it("shows the name, the saved state, Run, the YAML toggle and a menu in a banner", async () => {
    await open();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByRole("heading", { name: "Refund flow" })).toBeTruthy();
    expect(within(bar).getByTestId("save-state").textContent).toBe("Saved");
    expect(within(bar).getByRole("button", { name: "Test Run" }).textContent).toBe("Test Run");
    expect(within(bar).getByRole("button", { name: "For developers: show YAML" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Menu" })).toBeTruthy();
  });

  it("Run opens and closes Test Run", async () => {
    await open();
    const run = screen.getByRole("button", { name: "Test Run" });
    fireEvent.click(run);
    expect(screen.getByRole("region", { name: "Test Run" })).toBeTruthy();
    expect(run.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(run);
    expect(screen.queryByRole("region", { name: "Test Run" })).toBeNull();
  });

  it("says saves are paused when the spec has an error", async () => {
    await open({}, { success: false, errors: [{ path: [], message: "bad", line: 3 }] }).catch(
      () => undefined,
    );
    await waitFor(() =>
      expect(screen.getByTestId("save-state").textContent).toContain("Saves paused"),
    );
  });

  it("the menu lists the infrequent actions, each opens its panel, and Escape closes it", async () => {
    await open();
    const button = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual([
      "Add step",
      "Add tool",
      "Edit steps",
      "Search commandsCtrl+K",
      "Show tour",
      "Import YAML",
      "Export YAML",
    ]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);

    for (const [item, panel] of [
      ["Add step", "Add Workflow Step"],
      ["Add tool", "Add Tool"],
      ["Edit steps", "Edit Steps"],
      ["Import YAML", "Import from file"],
    ] as const) {
      chooseFromMenu(item);
      expect(screen.getByRole("region", { name: panel })).toBeTruthy();
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("Export YAML downloads the spec's own text", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = (blob: Blob | MediaSource) => (created.push(blob as Blob), "blob:x");
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await open();
    chooseFromMenu("Export YAML");
    expect(click).toHaveBeenCalled();
    expect(await created[0]!.text()).toBe(SOURCE);
    click.mockRestore();
  });
});

describe("top bar views (KAM-246)", () => {
  it("switches between the Editor and the two panels you read results in", async () => {
    await open(full);
    const bar = screen.getByRole("banner");
    const views = within(bar).getByRole("group", { name: "View" });
    const editor = within(views).getByRole("button", { name: "Editor" });
    const run = within(views).getByRole("button", { name: "Test Run" });
    const checks = within(views).getByRole("button", { name: "Checks" });
    expect(editor.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(run);
    expect(run.getAttribute("aria-pressed")).toBe("true");
    expect(editor.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(checks);
    expect(screen.getAllByRole("region", { name: "Checks" }).length).toBeGreaterThan(0);
    expect(run.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(editor);
    expect(screen.queryByRole("region", { name: "Checks" })).toBeNull();
    expect(editor.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("status chips (KAM-246)", () => {
  const ctx = {
    openForm: null,
    yamlOpen: false,
    hasSecrets: true,
    hasChecks: true,
    noSpecYet: false,
    toggleForm: () => {},
    toggleYaml: () => {},
    download: () => {},
  };
  const chip = (id: string, extra = {}) =>
    buildActions({ ...ctx, ...extra }).find((a) => a.id === id);

  it("says how many vars there are and what starts a run, and marks missing secrets", () => {
    expect(chip("vars", { varCount: 3 })?.detail).toBe("3");
    expect(chip("vars", { varCount: 0 })?.detail).toBeUndefined();
    expect(chip("trigger", { triggerSummary: "Every 6 hours" })?.detail).toBe("Every 6 hours");
    expect(chip("trigger")?.detail).toBeUndefined();
    expect(chip("secrets", { missingSecrets: 4 })).toMatchObject({
      tone: "warn",
      badge: { count: 4, words: "4 missing" },
    });
    expect(chip("secrets", { missingSecrets: 0 })?.tone).toBeUndefined();
  });
});

describe("status bar", () => {
  it("offers Vars, Secrets, Guardrails, Checks and Trigger in a footer, each opening its panel", async () => {
    await open(full);
    await screen.findByRole("button", { name: "Secrets 2 missing" });
    const bar = screen.getByRole("contentinfo");
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["Vars", "Secrets 2", "Guardrails", "Checks", "Trigger"]);
    for (const [button, panel] of [
      [/^Vars$/, "Spec Vars"],
      [/^Secrets/, "Secrets"],
      [/^Guardrails$/, "Set Guardrails"],
      [/^Checks$/, "Checks"],
      [/^Trigger$/, "Trigger"],
    ] as const) {
      fireEvent.click(within(bar).getByRole("button", { name: button }));
      expect(screen.getAllByRole("region", { name: panel }).length).toBeGreaterThan(0);
    }
  });

  it("shows no count when nothing is missing, and no Checks where the server has none", async () => {
    await open({
      listSecrets: async () => [{ name: "A", source: "saved", referenced: true }],
      setSecret: async () => [],
      removeSecret: async () => [],
    });
    expect(await screen.findByRole("button", { name: "Secrets" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Checks" })).toBeNull();
  });
});

describe("actions", () => {
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
    openForm: null,
    yamlOpen: false,
    hasSecrets: true,
    hasChecks: true,
    noSpecYet: false,
    toggleForm: () => {},
    toggleYaml: () => {},
    download: () => {},
    ...over,
  });

  it("describes each verb once, with the surface it is drawn on", () => {
    const by = (surface: string) =>
      buildActions(ctx())
        .filter((a) => a.surface === surface)
        .map((a) => a.id);
    expect(by("run")).toEqual(["run"]);
    expect(by("yaml")).toEqual(["yaml"]);
    expect(by("status")).toEqual(["vars", "secrets", "guardrails", "checks", "trigger"]);
    expect(by("menu")).toEqual(["add-step", "add-tool", "edit-steps", "import", "export"]);
  });

  it("offers only what needs no spec while the workflow is being started", () => {
    const ids = buildActions(ctx({ noSpecYet: true })).map((a) => a.id);
    expect(ids).toEqual(["run", "yaml", "secrets", "checks", "import"]);
  });

  it("every action carries a label that its accessible name contains", () => {
    // (the YAML toggle is an icon-like "</>", named in words for screen readers)
    for (const a of buildActions(ctx()).filter((a) => a.id !== "yaml"))
      expect(a.ariaLabel ?? a.label).toContain(a.label);
  });
});
