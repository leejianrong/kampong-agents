import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";
import { chooseFromMenu } from "./menu.js";

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
    localStorage.clear();
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

  it("keeps the YAML in a drawer for developers, closed until opened (KAM-202)", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
    expect(screen.queryByTestId("yaml-preview")).toBeNull();

    const toggle = screen.getByTestId("yaml-drawer-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    const preview = screen.getByTestId("yaml-preview");
    expect(preview.textContent).toContain("agent:");
    // The scroll region is reachable by keyboard.
    expect(preview.getAttribute("tabindex")).toBe("0");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("yaml-preview")).toBeNull();
  });

  it("toggles the YAML drawer with Alt+Y and remembers it across a reload", async () => {
    const first = render(<App />);
    await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
    fireEvent.keyDown(window, { code: "KeyY", altKey: true });
    expect(screen.getByTestId("yaml-preview")).toBeTruthy();
    first.unmount();

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("yaml-preview")).toBeTruthy());
    fireEvent.keyDown(window, { code: "KeyY", altKey: true });
    expect(screen.queryByTestId("yaml-preview")).toBeNull();
  });

  it("still works when browser storage throws", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
    expect(screen.queryByTestId("yaml-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("yaml-drawer-toggle"));
    expect(screen.getByTestId("yaml-preview")).toBeTruthy();
  });

  it("shows a warning banner when the spec declares knowledge_base, which nothing executes (KAN-1831)", async () => {
    const withKnowledgeBase = {
      ...SPEC_RESPONSE,
      spec: {
        ...SPEC_RESPONSE.spec,
        agent: {
          ...SPEC_RESPONSE.spec.agent,
          knowledge_base: [{ type: "url", source: "https://docs.example.com/policy" }],
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => ({ ok: true, status: 200, json: async () => withKnowledgeBase }) as Response,
      ),
    );

    render(<App />);

    const banner = await screen.findByTestId("spec-warnings");
    expect(banner.textContent).toMatch(/knowledge_base/);
    expect(banner.textContent).toMatch(/not.*executed/i);
  });

  it("shows no warning banner for a spec without inert fields", async () => {
    render(<App />);

    await waitFor(() => screen.getByText(/Trigger: Greeter/));
    expect(screen.queryByTestId("spec-warnings")).toBeNull();
  });

  it("does not show a conflict banner for an ordinary render", async () => {
    render(<App />);

    await waitFor(() => screen.getByText(/Trigger: Greeter/));
    expect(screen.queryByTestId("conflict-banner")).toBeNull();
  });

  describe("component forms (KAN-1885)", () => {
    const CATALOG = {
      components: [
        {
          id: "acme/tickets",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`,
          permissionsSummary: "reach tickets.example.test",
          slots: [],
          config: [],
          ops: {
            get: {
              effect: "read",
              input: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
      ],
      problems: [],
    };

    function stubFetch(components: () => Promise<Response>) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).endsWith("/api/components")
            ? components()
            : ({ ok: true, status: 200, json: async () => SPEC_RESPONSE } as Response),
        ),
      );
    }

    it("loads the installed components when the Add Tool form opens and offers the Component kind", async () => {
      stubFetch(async () => ({ ok: true, status: 200, json: async () => CATALOG }) as Response);
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Add Tool");
      fireEvent.click(await screen.findByRole("button", { name: "Component" }));
      expect(screen.getByLabelText("Component")).toBeTruthy();
      expect(screen.getByLabelText("id")).toBeTruthy();
    });

    it("explains a failure to list components instead of hiding the Component kind silently", async () => {
      stubFetch(
        async () => ({ ok: false, status: 500, json: async () => ({ error: "nope" }) }) as Response,
      );
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Add Tool");
      fireEvent.click(await screen.findByRole("button", { name: "Component" }));
      expect(screen.getByText(/Could not list components: nope/)).toBeTruthy();
    });

    it("pins a component from the form and shows the new state without reopening it (KAN-1901)", async () => {
      const unpinned = {
        ...CATALOG,
        components: [{ ...CATALOG.components[0]!, pin: { state: "unpinned" } }],
      };
      const pinned = {
        ...CATALOG,
        components: [{ ...CATALOG.components[0]!, pin: { state: "pinned" } }],
      };
      const calls: { url: string; body?: string }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), body: init?.body as string | undefined });
          const json = (body: unknown) =>
            ({ ok: true, status: 200, json: async () => body }) as Response;
          if (String(url).endsWith("/api/components/pin")) {
            return json({ success: true, catalog: pinned });
          }
          if (String(url).endsWith("/api/components")) return json(unpinned);
          return json(SPEC_RESPONSE);
        }),
      );
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Add Tool");
      fireEvent.click(await screen.findByRole("button", { name: "Component" }));
      expect((await screen.findByTestId("pin-state")).textContent).toBe("Not pinned");
      fireEvent.click(screen.getByRole("button", { name: /review and pin/i }));
      fireEvent.click(screen.getByRole("button", { name: "Pin" }));
      await waitFor(() => expect(screen.getByTestId("pin-state").textContent).toBe("Pinned"));
      const pin = calls.find((c) => c.url.endsWith("/api/components/pin"))!;
      // It carries the digest the author was shown, so files edited since cannot be pinned unreviewed.
      expect(JSON.parse(pin.body!)).toEqual({
        use: "acme/tickets@1.0.0",
        allowWiderPermissions: false,
        expectedDigest: `sha256:${"a".repeat(64)}`,
      });
    });
  });

  describe("variables", () => {
    function stub(rows: { name: string; source: string; referenced: boolean }[]) {
      const calls: { url: string; method?: string; body?: string }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), method: init?.method, body: init?.body as string });
          if (String(url).includes("/api/secrets/") && init?.method === "PUT") {
            rows = rows.map((r) => (r.name === "SLACK_BOT_TOKEN" ? { ...r, source: "saved" } : r));
          }
          return {
            ok: true,
            status: 200,
            json: async () =>
              String(url).includes("/api/secrets")
                ? { success: true, secrets: rows }
                : SPEC_RESPONSE,
          } as Response;
        }),
      );
      return calls;
    }

    it("lists names with where each comes from, and sets one without ever showing it", async () => {
      const calls = stub([{ name: "SLACK_BOT_TOKEN", source: "unset", referenced: true }]);
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /^Secrets/ }));
      expect(await screen.findByText("SLACK_BOT_TOKEN")).toBeTruthy();
      expect(screen.getByText("Needed, not set")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Set SLACK_BOT_TOKEN" }));
      const input = screen.getByLabelText("New value for SLACK_BOT_TOKEN") as HTMLInputElement;
      expect(input.type).toBe("password");
      fireEvent.change(input, { target: { value: "xoxb-abc" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText("Saved here")).toBeTruthy();
      const put = calls.find((c) => c.method === "PUT")!;
      expect(put.url).toContain("/api/secrets/SLACK_BOT_TOKEN");
      expect(JSON.parse(put.body!)).toEqual({ value: "xoxb-abc" });
      // the value is gone from the page once saved
      expect(document.body.innerHTML).not.toContain("xoxb-abc");
      expect(screen.queryByLabelText("New value for SLACK_BOT_TOKEN")).toBeNull();
    });

    it("refuses a name that is not a variable name", async () => {
      stub([]);
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /^Secrets/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Add secret" }));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "not valid" } });
      fireEvent.change(screen.getByLabelText("Value"), { target: { value: "v" } });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
  });

  describe("checks (KAN-1901)", () => {
    it("runs the offline checks from the toolbar and lists the results", async () => {
      const calls: { url: string; body?: string }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), body: init?.body as string | undefined });
          return {
            ok: true,
            status: 200,
            json: async () =>
              String(url).endsWith("/api/doctor")
                ? {
                    success: true,
                    checks: [{ status: "fail", area: "env", message: "X is not set" }],
                  }
                : SPEC_RESPONSE,
          } as Response;
        }),
      );
      render(<App />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Checks" }));
      fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
      expect(await screen.findByText("X is not set")).toBeTruthy();
      expect(JSON.parse(calls.find((c) => c.url.endsWith("/api/doctor"))!.body!)).toEqual({});
    });

    it("has no Checks button on a server that cannot run them", async () => {
      const api = {
        loadSpec: async () => SPEC_RESPONSE,
        applyPatch: async () => ({ success: true }),
        applyOps: async () => ({ success: true }),
        replaceSource: async () => ({ success: true }),
        startBlank: async () => ({ success: true }),
        subscribeToEvents: () => () => {},
        startRun: async () => ({ success: true }),
        approveRun: async () => ({ success: true }),
        subscribeToRunEvents: () => () => {},
      };
      render(<App api={api} />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      expect(screen.queryByRole("button", { name: "Checks" })).toBeNull();
    });
  });

  describe("Spec vars (KAM-159)", () => {
    const withVersion = (version: string, vars?: Record<string, unknown>) => ({
      ...SPEC_RESPONSE,
      spec: { ...SPEC_RESPONSE.spec, version, ...(vars && { vars }) },
    });
    function appWith(response: unknown) {
      const applied: unknown[] = [];
      const api = {
        loadSpec: async () => response,
        applyPatch: async (ops: unknown) => (applied.push(ops), { success: true }),
        subscribeToEvents: () => () => {},
        startRun: async () => ({ success: true }),
        approveRun: async () => ({ success: true }),
        subscribeToRunEvents: () => () => {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<App api={api as any} />);
      return applied;
    }

    it("opens from the toolbar and saves the first var as a vars block", async () => {
      const applied = appWith(withVersion("1.1"));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Vars" }));
      fireEvent.click(screen.getByRole("button", { name: "Add var" }));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "symbols" } });
      fireEvent.change(screen.getByLabelText("Type"), { target: { value: "list" } });
      fireEvent.change(screen.getByLabelText("Default", { exact: false }), {
        target: { value: "AAPL, MSFT" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save var" }));
      await waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual([
        {
          op: "set",
          path: ["vars"],
          value: { symbols: { type: "list", default: ["AAPL", "MSFT"] } },
        },
      ]);
    });

    it("adds to an existing block and removes the last var along with the block", async () => {
      const applied = appWith(withVersion("1.1", { only: { type: "string" } }));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Vars" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove only" }));
      await waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual([{ op: "remove", path: ["vars"] }]);
    });

    it("is gated on a 1.0 spec", async () => {
      appWith(withVersion("1.0"));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Vars" }));
      expect(screen.getByRole("status").textContent).toContain("Vars need spec version");
    });
  });

  describe("Trigger panel (KAM-161)", () => {
    const withTrigger = (version: string, trigger?: Record<string, unknown>) => ({
      ...SPEC_RESPONSE,
      spec: {
        ...SPEC_RESPONSE.spec,
        version,
        agent: { ...SPEC_RESPONSE.spec.agent, ...(trigger && { trigger }) },
      },
    });
    function appWith(response: unknown) {
      const applied: unknown[] = [];
      const api = {
        loadSpec: async () => response,
        applyPatch: async (ops: unknown) => (applied.push(ops), { success: true }),
        subscribeToEvents: () => () => {},
        startRun: async () => ({ success: true }),
        approveRun: async () => ({ success: true }),
        subscribeToRunEvents: () => () => {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<App api={api as any} />);
      return applied;
    }

    it("opens from the toolbar and sets agent.trigger", async () => {
      const applied = appWith(withTrigger("1.1"));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
      fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
      fireEvent.change(screen.getByLabelText("Cron", { exact: false }), {
        target: { value: "0 9 * * *" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));
      await waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual([
        { op: "set", path: ["agent", "trigger"], value: { type: "schedule", cron: "0 9 * * *" } },
      ]);
    });

    it("removes an existing trigger", async () => {
      const applied = appWith(withTrigger("1.1", { type: "webhook" }));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove trigger" }));
      await waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual([{ op: "remove", path: ["agent", "trigger"] }]);
    });

    it("is gated on a 1.0 spec", async () => {
      appWith(withTrigger("1.0"));
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
      expect(screen.getByRole("status").textContent).toContain("need spec version");
    });
  });

  describe("Edit steps (KAM-162)", () => {
    it("opens from the toolbar and patches a step in place", async () => {
      const applied: unknown[] = [];
      const api = {
        loadSpec: async () => ({
          ...SPEC_RESPONSE,
          spec: { ...SPEC_RESPONSE.spec, version: "1.1" },
        }),
        applyPatch: async (ops: unknown) => (applied.push(ops), { success: true }),
        subscribeToEvents: () => () => {},
        startRun: async () => ({ success: true }),
        approveRun: async () => ({ success: true }),
        subscribeToRunEvents: () => () => {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<App api={api as any} />);
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Edit Steps");
      fireEvent.click(screen.getByRole("button", { name: "Edit greet" }));
      fireEvent.change(screen.getByLabelText("Model"), {
        target: { value: "m" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save step" }));
      await waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual([
        { op: "set", path: ["agent", "workflow", 0, "model"], value: "m" },
      ]);
    });
  });

  describe("Expression fields (KAM-160)", () => {
    function open11(version: string) {
      const response = {
        ...SPEC_RESPONSE,
        spec: {
          ...SPEC_RESPONSE.spec,
          version,
          vars: { threshold: { type: "number", default: 5 } },
        },
      };
      const api = {
        loadSpec: async () => response,
        applyPatch: async () => ({ success: true }),
        subscribeToEvents: () => () => {},
        startRun: async () => ({ success: true }),
        approveRun: async () => ({ success: true }),
        subscribeToRunEvents: () => () => {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<App api={api as any} />);
    }

    it("checks a new step's expressions against the spec's vars on a 1.1 spec", async () => {
      open11("1.1");
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Add Workflow Step");
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
      const field = screen.getByLabelText("Assert (expression that must be true)");
      fireEvent.change(field, { target: { value: "vars.threshhold > 1" } });
      expect(
        screen.getByText(/vars.threshhold is not declared in vars \(declared: threshold\)/),
      ).toBeTruthy();
      fireEvent.change(field, { target: { value: "vars." } });
      expect(screen.getByRole("option", { name: /threshold/ })).toBeTruthy();
    });

    it("leaves them plain on a 1.0 spec", async () => {
      open11("1.0");
      await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
      chooseFromMenu("Add Workflow Step");
      fireEvent.click(screen.getByRole("button", { name: "Condition" }));
      fireEvent.change(screen.getByLabelText("If (condition)"), { target: { value: "vars.x" } });
      expect(screen.queryByText(/Problem:/)).toBeNull();
    });
  });
});
