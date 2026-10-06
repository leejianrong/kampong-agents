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
  });
});
