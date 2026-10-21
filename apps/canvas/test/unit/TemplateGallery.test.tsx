import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";
import type { ApiClient, TemplateSummary } from "../../src/api.js";

// KAM-216: the template gallery in the empty state and the menu, against a stubbed ApiClient.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const TEMPLATES: TemplateSummary[] = [
  {
    name: "market-etl",
    title: "Daily stock price tracker",
    description: "Looks up prices every day and tells you when one moves a lot.",
    stepKinds: ["foreach", "tool", "validate"],
    runsOffline: true,
  },
  {
    name: "support-triage",
    title: "Support inbox assistant",
    description: "Drafts replies to customer emails.",
    stepKinds: ["tool", "action"],
    runsOffline: false,
  },
];

const MISSING = { success: false, missing: true, errors: [], layout: {}, source: "" };
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

describe("template gallery (KAM-216)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("lists the templates in the empty state with title, description, step kinds and the offline badge", async () => {
    const api = apiWith(() => MISSING, {
      listTemplates: async () => TEMPLATES,
      startFromTemplate: async () => ({ success: true }),
    });
    render(<App api={api} />);

    const card = await screen.findByTestId("template-market-etl");
    expect(card.textContent).toContain("Daily stock price tracker");
    expect(card.textContent).toContain("Looks up prices every day");
    expect(card.textContent).toContain("Foreach");
    expect(card.textContent).toContain("Validate");
    expect(screen.getByTestId("template-market-etl-offline").textContent).toBe("Runs offline");
    // Only a template with recorded data gets the badge.
    expect(screen.queryByTestId("template-support-triage-offline")).toBeNull();
  });

  it("choosing a template saves it and opens the workflow", async () => {
    let saved = false;
    const startFromTemplate = vi.fn(async () => {
      saved = true;
      return { success: true };
    });
    const api = apiWith(() => (saved ? GOOD : MISSING), {
      listTemplates: async () => TEMPLATES,
      startFromTemplate,
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByTestId("template-market-etl-use"));

    await waitFor(() => expect(screen.queryByTestId("empty-state")).toBeNull());
    expect(startFromTemplate).toHaveBeenCalledWith("market-etl", { replace: false });
  });

  it("says why when a template cannot be used", async () => {
    const api = apiWith(() => MISSING, {
      listTemplates: async () => TEMPLATES,
      startFromTemplate: async () => ({
        success: false,
        errors: [{ path: [], message: "Has content." }],
      }),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByTestId("template-market-etl-use"));
    expect((await screen.findByTestId("empty-state-error")).textContent).toContain("Has content.");
  });

  it("is offered from the menu on an existing workflow and asks before replacing it", async () => {
    const startFromTemplate = vi.fn(async () => ({ success: true }));
    const api = apiWith(() => GOOD, { listTemplates: async () => TEMPLATES, startFromTemplate });
    render(<App api={api} />);
    await waitFor(() => expect(screen.getByText(/^Manual$/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New from template" }));
    fireEvent.click(await screen.findByTestId("template-market-etl-use"));
    // Nothing is sent until the person confirms.
    expect(startFromTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("template-market-etl-confirm"));
    await waitFor(() =>
      expect(startFromTemplate).toHaveBeenCalledWith("market-etl", { replace: true }),
    );
  });

  it("is left out where the server has no templates (hosted)", async () => {
    const api = apiWith(() => MISSING);
    render(<App api={api} />);
    await waitFor(() => screen.getByTestId("start-blank"));
    expect(screen.queryByTestId("empty-state-templates")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.queryByRole("menuitem", { name: "New from template" })).toBeNull();
  });
});
