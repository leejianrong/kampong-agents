import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "../../src/RunPanel.js";
import type { ApiClient, RunOptionsResponse } from "../../src/api.js";

// KAM-188: the Test Run panel's Replay / Live switch, the LIVE banner and the confirmation before a live
// run that can change something outside the project.

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}

const RUNNING = { status: "running", trace: [] } as const;

function options(overrides: Partial<RunOptionsResponse> = {}): RunOptionsResponse {
  return {
    success: true,
    modes: ["replay", "live"],
    defaultMode: "replay",
    fixtures: { available: true, dir: "fixtures", count: 12 },
    tools: [
      {
        name: "quote",
        describes: "GET https://quotes.test",
        effect: "read",
        sideEffecting: false,
        requiresApproval: false,
        recorded: true,
      },
      {
        name: "post_alert",
        describes: "kampong/slack post_message",
        effect: "write",
        sideEffecting: true,
        requiresApproval: false,
        recorded: true,
      },
    ],
    modelCalls: false,
    ...overrides,
  };
}

function apiWith(opts: RunOptionsResponse | undefined, mode: "replay" | "live" = "replay") {
  const startRun = vi.fn(async () => ({
    success: true,
    id: "r1",
    state: RUNNING,
    mode,
  }));
  const api = {
    ...(opts && { getRunOptions: async () => opts }),
    startRun,
    approveRun: vi.fn(),
    subscribeToRunEvents: () => () => {},
  } as unknown as ApiClient;
  return { api, startRun };
}

describe("RunPanel modes", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts on Replay when fixtures exist and runs without a confirmation", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api, startRun } = apiWith(options());
    render(<RunPanel api={api} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(screen.queryByTestId("run-live-banner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", "replay"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("run-mode").textContent).toContain("Replay (recorded fixtures)"),
    );
  });

  it("shows the LIVE banner and the tools a live run would call", async () => {
    const { api } = apiWith(options());
    render(<RunPanel api={api} />);
    await waitFor(() => screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    const banner = screen.getByTestId("run-live-banner");
    expect(banner.textContent).toContain("LIVE");
    expect(banner.textContent).toContain("quote");
    expect(banner.textContent).toContain("read only");
    expect(banner.textContent).toContain("post_alert");
    expect(banner.textContent).toContain("changes things");
  });

  it("asks before a live run with a side-effecting tool, and starts only on confirm", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api, startRun } = apiWith(options(), "live");
    render(<RunPanel api={api} />);
    await waitFor(() => screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    const dialog = screen.getByRole("dialog", { name: "Run live?" });
    expect(dialog.textContent).toContain("post_alert");
    expect(dialog.textContent).not.toContain("quote");
    expect(startRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(screen.getByTestId("run-confirm-live"));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", "live"));
    await waitFor(() => expect(screen.getByTestId("run-mode").textContent).toContain("LIVE"));
  });

  it("does not ask when a live run only reads, and says there is nothing to replay", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const readOnly = options({
      modes: ["live"],
      defaultMode: "live",
      fixtures: { available: false, count: 0 },
      tools: [options().tools![0]!],
    });
    const { api, startRun } = apiWith(readOnly, "live");
    render(<RunPanel api={api} />);
    await waitFor(() => screen.getByTestId("run-live-banner"));
    expect(screen.queryByRole("group", { name: "Run mode" })).toBeNull();
    expect(screen.getByTestId("run-live-banner").textContent).toContain("no recorded fixtures");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", "live"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no switch and sends no mode when the client cannot describe runs (hosted)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { api, startRun } = apiWith(undefined);
    render(<RunPanel api={api} />);
    expect(screen.queryByRole("group", { name: "Run mode" })).toBeNull();
    expect(screen.queryByTestId("run-live-banner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", undefined));
  });
});
