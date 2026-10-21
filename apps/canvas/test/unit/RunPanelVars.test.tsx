import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "../../src/RunPanel.js";
import { createApiClient, type ApiClient, type RunOptionsResponse } from "../../src/api.js";

// KAM-191: Test Run lists the spec's declared vars, prefilled with their defaults, and sends only the ones
// changed for that one run.

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}

const OPTIONS: RunOptionsResponse = {
  success: true,
  modes: ["live"],
  defaultMode: "live",
  fixtures: { available: false, count: 0 },
  tools: [],
  modelCalls: false,
  vars: [
    { name: "symbols", type: "list", items: "string", default: "AAPL, MSFT" },
    { name: "threshold", type: "number", default: "1.5", description: "Percent move" },
    { name: "account", type: "string" },
  ],
};

function apiWith(options: RunOptionsResponse | undefined) {
  const startRun = vi.fn(async () => ({
    success: true,
    id: "r1",
    state: { status: "running", trace: [] },
  }));
  const api = {
    ...(options && { getRunOptions: async () => options }),
    startRun,
    approveRun: vi.fn(),
    subscribeToRunEvents: () => () => {},
  } as unknown as ApiClient;
  return { api, startRun };
}

describe("RunPanel vars", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each declared var prefilled with its default, and marks one with none as required", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RunPanel api={apiWith(OPTIONS).api} />);
    const threshold = (await screen.findByTestId("run-var-threshold")) as HTMLInputElement;
    expect(threshold.value).toBe("1.5");
    expect((screen.getByTestId("run-var-symbols") as HTMLInputElement).value).toBe("AAPL, MSFT");
    expect((screen.getByTestId("run-var-account") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("run-vars").textContent).toContain("required");
    expect(screen.getByTestId("run-vars").textContent).toContain("Percent move");
    expect(screen.getByTestId("run-vars").textContent).toContain("this run only");
  });

  it("sends no vars when none was changed", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api, startRun } = apiWith({
      ...OPTIONS,
      vars: [{ name: "threshold", type: "number", default: "1.5" }],
    });
    render(<RunPanel api={api} />);
    await screen.findByTestId("run-var-threshold");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun).toHaveBeenCalledWith("", "live");
  });

  it("sends only the vars changed from their defaults", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api, startRun } = apiWith(OPTIONS);
    render(<RunPanel api={api} />);
    fireEvent.change(await screen.findByTestId("run-var-threshold"), { target: { value: "0.05" } });
    fireEvent.change(screen.getByTestId("run-var-account"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun).toHaveBeenCalledWith("", "live", { threshold: "0.05", account: "acme" });
  });

  it("shows no var fields for a server that does not list vars, or a spec without any", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api } = apiWith({ ...OPTIONS, vars: [] });
    const first = render(<RunPanel api={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeTruthy());
    expect(screen.queryByTestId("run-vars")).toBeNull();
    first.unmount();
    render(<RunPanel api={apiWith(undefined).api} />);
    expect(screen.queryByTestId("run-vars")).toBeNull();
  });
});

describe("the local client's startRun", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts the vars in the request body, and leaves them out when there are none", async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient();
    await api.startRun("hi", "replay", { threshold: "2" });
    await api.startRun("hi");
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    expect(bodies).toEqual([
      { input: "hi", mode: "replay", vars: { threshold: "2" } },
      { input: "hi" },
    ]);
  });
});
