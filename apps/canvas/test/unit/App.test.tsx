import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      fireEvent.click(screen.getByRole("button", { name: "Add Tool" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Add Tool" }));
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
      fireEvent.click(screen.getByRole("button", { name: "Add Tool" }));
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
});
