import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";
import { buildActions, commandName, type ActionContext } from "../../src/actions.js";
import { filterCommands, goToLabel } from "../../src/CommandPalette.js";

// KAM-215: the command palette reads actions.ts and the spec's nodes; Ctrl/Cmd+K opens it.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const SPEC = {
  version: "1.1",
  agent: {
    id: "pal_agent",
    name: "Pal agent",
    role: "Support",
    goal: "Handle refunds.",
    tools: [
      { name: "fetch_price", action: "http_request", method: "GET", url: "https://x.example" },
    ],
    workflow: [{ step: "parse", action: "extract the order" }],
  },
};

async function open() {
  const api = {
    loadSpec: async () => ({
      success: true,
      spec: SPEC,
      errors: [],
      layout: {},
      source: "version: '1.1'\n",
    }),
    applyPatch: async () => ({ success: true }),
    applyOps: async () => ({ success: true }),
    subscribeToEvents: () => () => {},
    startRun: async () => ({ success: true }),
    approveRun: async () => ({ success: true }),
    subscribeToRunEvents: () => () => {},
    listSecrets: async () => [],
    setSecret: async () => [],
    removeSecret: async () => [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<App api={api as any} specName="Pal flow" />);
  await screen.findByText(/^Manual$/);
}

const dialog = () => screen.getByRole("dialog", { name: "Command palette" });
const box = () => within(dialog()).getByRole("combobox", { name: "Search commands" });

describe("command palette", () => {
  it("opens on Ctrl+K and on Cmd+K as a dialog with a combobox that owns a listbox", async () => {
    await open();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(box());
    const list = within(dialog()).getByRole("listbox");
    expect(box().getAttribute("aria-controls")).toBe(list.id);
    expect(box().getAttribute("aria-expanded")).toBe("true");
    const active = box().getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(dialog()).toBeTruthy();
  });

  it("lists the commands and a Go to entry per node, and filters by every word", async () => {
    await open();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const names = within(dialog())
      .getAllByRole("option")
      .map((o) => o.textContent);
    for (const want of [
      "Run the workflow",
      "Open Test Run",
      "Open code (YAML drawer)Alt+Y",
      "Open Secrets",
      "Open Vars",
      "Open Guardrails",
      "Open Trigger",
      "Add step",
      "Add tool",
      "Import YAML",
      "Export YAML",
      "Go to trigger",
      "Go to tool fetch_price",
      "Go to step parse",
    ]) {
      expect(names, want).toContain(want);
    }
    expect(names).not.toContain("Search commands");
    fireEvent.change(box(), { target: { value: "go parse" } });
    expect(
      within(dialog())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Go to step parse"]);
    fireEvent.change(box(), { target: { value: "nothing like it" } });
    expect(within(dialog()).getByRole("status").textContent).toContain("No command matches");
    expect(box().getAttribute("aria-expanded")).toBe("false");
  });

  it("arrows move the active row and Enter runs it; the palette closes", async () => {
    await open();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(box(), { target: { value: "guardrails" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Set Guardrails" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const first = box().getAttribute("aria-activedescendant");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).not.toBe(first);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().getAttribute("aria-activedescendant")).toBe(first);
  });

  it("Go to selects the node and opens its inspector", async () => {
    await open();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(box(), { target: { value: "tool fetch_price" } });
    fireEvent.click(within(dialog()).getByRole("option", { name: "Go to tool fetch_price" }));
    await waitFor(() => expect(screen.getByTestId("node-inspector")).toBeTruthy());
  });

  it("Escape closes it and focus goes back to where it was; Tab stays in the box", async () => {
    await open();
    const menu = screen.getByRole("button", { name: "Menu" });
    menu.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const tab = fireEvent.keyDown(box(), { key: "Tab" });
    expect(tab).toBe(false);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("the run bar menu has Search commands, which opens it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Search commands/ }));
    expect(dialog()).toBeTruthy();
  });
});

describe("palette wording", () => {
  const ctx: ActionContext = {
    openForm: null,
    yamlOpen: false,
    hasSecrets: true,
    hasChecks: true,
    noSpecYet: false,
    toggleForm: vi.fn(),
    toggleYaml: vi.fn(),
    download: vi.fn(),
  };

  it("every status action is an Open command, and the palette entry only appears when it can open", () => {
    const names = buildActions(ctx).map(commandName);
    expect(names).toContain("Open Checks");
    expect(buildActions(ctx).some((a) => a.id === "commands")).toBe(false);
    expect(buildActions({ ...ctx, openPalette: vi.fn() }).some((a) => a.id === "commands")).toBe(
      true,
    );
  });

  it("names nodes the way the canvas does and matches every word", () => {
    expect(goToLabel({ id: "workflow:a", kind: "workflow", data: { step: "a" } })).toBe(
      "Go to step a",
    );
    expect(goToLabel({ id: "tool:t", kind: "tool", data: { name: "t" } })).toBe("Go to tool t");
    expect(filterCommands([{ words: "open code" }, { words: "open vars" }], "open v")).toHaveLength(
      1,
    );
  });
});
