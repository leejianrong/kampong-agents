import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSpec, ComponentCatalogEntry, PatchOp } from "@kampong/spec";
import { App } from "../../src/App.js";
import { StepsPanel } from "../../src/StepsPanel.js";
import { chooseFromMenu } from "./menu.js";

// KAM-175: tool steps, stop steps and the tools themselves can be edited from the Edit Steps panel. The patch
// logic is tested in packages/spec (tool-edit.test.ts); this covers the rows, the forms and the wiring.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const TICKETS: ComponentCatalogEntry = {
  id: "acme/tickets",
  version: "1.0.0",
  digest: "sha256:abc",
  permissionsSummary: "Calls tickets.example.com",
  pin: { state: "first-party" },
  slots: [],
  config: [],
  ops: {
    create: {
      effect: "write",
      input: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" }, urgent: { type: "boolean" } },
      },
    },
  },
};

const spec = (): AgentSpec =>
  ({
    version: "1.1",
    agent: {
      id: "a",
      name: "A",
      role: "R",
      goal: "G",
      tools: [
        {
          name: "feed",
          action: "http_request",
          method: "GET",
          url: "https://example.com/{symbol}",
          headers: { Accept: "application/json" },
          requires_approval: false,
        },
        {
          name: "notify",
          action: "slack_post_message",
          token: "${SLACK_TOKEN}",
          channel: "#a",
          text: "hi",
        },
        {
          name: "file",
          action: "component",
          use: "acme/tickets@1.0.0",
          op: "create",
          with: { title: "T", extra: 1 },
        },
      ],
      workflow: [
        { step: "get", type: "tool", tool: "feed" },
        { step: "ask", type: "approval", message: "Ok?" },
        { step: "halt", stop: { reason: "done", status: "skipped" } },
        { step: "pick", branch: { if: "true", then: [{ step: "x", stop: {} }] } },
        { step: "gate", type: "condition", if: "a", then: "b", else: "c" },
      ],
    },
  }) as unknown as AgentSpec;

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("StepsPanel: tool, stop and approval steps", () => {
  afterEach(cleanup);

  function setup() {
    const onPatch = vi.fn(async (_ops: PatchOp[]) => true);
    render(<StepsPanel spec={spec()} onPatch={onPatch} onEditTool={vi.fn()} />);
    return onPatch;
  }

  it("gives every step row an Edit button or a stated reason", () => {
    setup();
    const list = screen.getByTestId("steps-list");
    for (const row of within(list).getAllByRole("listitem")) {
      const hasEdit = within(row).queryByRole("button", { name: /^Edit / }) !== null;
      const hasReason = /edited in the YAML/.test(row.textContent ?? "");
      expect(hasEdit || hasReason, row.textContent ?? "").toBe(true);
    }
    expect(within(list).getByRole("button", { name: "Edit get" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Edit halt" })).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Edit x" })).toBeTruthy();
  });

  it("repoints a tool step at another tool", async () => {
    const onPatch = setup();
    click("Edit get");
    expect((screen.getByLabelText("Tool to call") as HTMLSelectElement).value).toBe("feed");
    fireEvent.change(screen.getByLabelText("Tool to call"), { target: { value: "notify" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "set", path: ["agent", "workflow", 0, "tool"], value: "notify" },
      ]),
    );
  });

  it("edits a stop's reason and status, clearing the status", async () => {
    const onPatch = setup();
    click("Edit halt");
    expect((screen.getByLabelText("Why the run ends here") as HTMLTextAreaElement).value).toBe(
      "done",
    );
    expect((screen.getByLabelText("End the run as") as HTMLSelectElement).value).toBe("skipped");
    fireEvent.change(screen.getByLabelText("Why the run ends here"), {
      target: { value: "nothing new" },
    });
    fireEvent.change(screen.getByLabelText("End the run as"), { target: { value: "" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        { op: "set", path: ["agent", "workflow", 2, "stop", "reason"], value: "nothing new" },
        { op: "remove", path: ["agent", "workflow", 2, "stop", "status"] },
      ]),
    );
  });

  it("edits a stop inside a branch at its own path", async () => {
    const onPatch = setup();
    click("Edit x");
    fireEvent.change(screen.getByLabelText("Why the run ends here"), { target: { value: "r" } });
    click("Save step");
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith([
        {
          op: "set",
          path: ["agent", "workflow", 3, "branch", "then", 0, "stop", "reason"],
          value: "r",
        },
      ]),
    );
  });

  it("shows a bad template in a stop reason and does not save", () => {
    const onPatch = setup();
    click("Edit halt");
    fireEvent.change(screen.getByLabelText("Why the run ends here"), {
      target: { value: "{{ 1 + }}" },
    });
    click("Save step");
    expect(screen.getByRole("alert").textContent).toContain("reason:");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("lists every tool with an Edit button that opens it by index", () => {
    const onEditTool = vi.fn();
    render(<StepsPanel spec={spec()} onPatch={vi.fn(async () => true)} onEditTool={onEditTool} />);
    const list = screen.getByTestId("tools-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("button", { name: "Edit tool notify" }));
    expect(onEditTool).toHaveBeenCalledWith(1);
  });
});

describe("App: editing a tool", () => {
  afterEach(cleanup);

  function open() {
    const applied: PatchOp[][] = [];
    const api = {
      loadSpec: async () => ({
        success: true,
        spec: spec(),
        errors: [],
        layout: {},
        source: 'version: "1.1"\n',
      }),
      applyPatch: async (ops: PatchOp[]) => (applied.push(ops), { success: true }),
      listComponents: async () => ({ components: [TICKETS], problems: [] }),
      subscribeToEvents: () => () => {},
      startRun: async () => ({ success: true }),
      approveRun: async () => ({ success: true }),
      subscribeToRunEvents: () => () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<App api={api as any} />);
    return applied;
  }
  const openTool = async (name: string) => {
    await waitFor(() => expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy());
    chooseFromMenu("Edit Steps");
    click(`Edit tool ${name}`);
  };

  it("edits an HTTP tool from its saved values and patches only what changed", async () => {
    const applied = open();
    await openTool("feed");
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://example.com/{symbol}",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "Tool kind" })).toBeNull();
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.org/x" } });
    click("Save tool");
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual([
      { op: "set", path: ["agent", "tools", 0, "url"], value: "https://example.org/x" },
    ]);
    // The panel closes after the save.
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit Tool" })).toBeNull());
  });

  it("saving an untouched tool sends no patch", async () => {
    const applied = open();
    await openTool("notify");
    click("Save tool");
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit Tool" })).toBeNull());
    expect(applied).toEqual([]);
  });

  it("edits a component tool's op inputs as fields and keeps an input the form has no field for", async () => {
    const applied = open();
    await openTool("file");
    await waitFor(() => expect(screen.getByLabelText("title (required)")).toBeTruthy());
    expect((screen.getByLabelText("title (required)") as HTMLInputElement).value).toBe("T");
    expect((screen.getByLabelText("Component") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("title (required)"), { target: { value: "New" } });
    click("Save tool");
    await waitFor(() => expect(applied).toHaveLength(1));
    expect(applied[0]).toEqual([
      { op: "set", path: ["agent", "tools", 2, "with", "title"], value: "New" },
    ]);
  });
});
