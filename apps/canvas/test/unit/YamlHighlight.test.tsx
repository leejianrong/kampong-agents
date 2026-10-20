import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec } from "@kampong/spec";
import { App } from "../../src/App.js";

// KAM-210: selecting a node marks its lines in the "For developers" drawer; clicking a line selects the node.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const SOURCE = `version: "1.1"
agent:
  id: hl
  name: Highlighter
  role: R
  goal: G
  workflow:
    - step: each
      foreach:
        items: "[1, 2]"
        as: x
        steps:
          - step: inner
            action: inner work
    - step: route
      branch:
        if: "true"
        then:
          - step: yes
            action: say yes
`;

const parsed = parseSpec(SOURCE);
if (!parsed.success) throw new Error(JSON.stringify(parsed.errors));
const RESPONSE = { success: true, spec: parsed.spec, errors: [], layout: {}, source: SOURCE };

const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`)!;
const marked = () =>
  Array.from(document.querySelectorAll('[data-testid="yaml-preview"] [aria-current="true"]')).map(
    (el) => el.textContent?.trim(),
  );

describe("YAML highlight (KAM-210)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => RESPONSE }) as Response),
    );
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage = null;
        close = vi.fn();
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("marks the lines of the selected step, including a foreach body and a branch arm", async () => {
    render(<App />);
    await waitFor(() => expect(node("workflow:inner")).toBeTruthy());
    fireEvent.click(screen.getByTestId("yaml-drawer-toggle"));
    expect(marked()).toEqual([]);

    fireEvent.click(node("workflow:inner"));
    expect(marked()).toEqual(["- step: inner", "action: inner work"]);
    fireEvent.click(node("workflow:yes"));
    expect(marked()).toEqual(["- step: yes", "action: say yes"]);
    // The text is still exactly the source: display only.
    expect(screen.getByTestId("yaml-preview").textContent).toBe(SOURCE);
  });

  it("records the selection while the drawer is closed, without opening it", async () => {
    render(<App />);
    await waitFor(() => expect(node("workflow:yes")).toBeTruthy());
    fireEvent.click(node("workflow:yes"));
    expect(screen.queryByTestId("yaml-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("yaml-drawer-toggle"));
    expect(marked()).toEqual(["- step: yes", "action: say yes"]);
  });

  it("selects the node (and opens its inspector) when a line is clicked", async () => {
    render(<App />);
    await waitFor(() => expect(node("workflow:inner")).toBeTruthy());
    fireEvent.click(screen.getByTestId("yaml-drawer-toggle"));
    fireEvent.click(screen.getByText("action: inner work", { exact: false }));
    expect(marked()).toEqual(["- step: inner", "action: inner work"]);
    expect(node("workflow:inner").classList.contains("selected")).toBe(true);
  });
});
