import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, RunEventMessage, RunOptionsResponse } from "../../src/api.js";
import { RunHarness } from "./RunHarness.js";

// KAM-219: the Run bar over the run session: Replay by default, the LIVE confirmation, the outcome chip, the runs
// drawer, Set it here, and a run that outlives the Test Run panel.

const options = (over: Partial<RunOptionsResponse> = {}): RunOptionsResponse => ({
  success: true,
  modes: ["replay", "live"],
  defaultMode: "replay",
  fixtures: { available: true, dir: "fixtures", count: 3 },
  tools: [
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
  ...over,
});

const COMPLETED_WITH_ERRORS = {
  status: "completed",
  trace: [],
  finalOutput: {
    each: {
      results: [],
      errors: [{ index: 0, step: "fetch", message: "429 slow down", item: "MSFT" }],
    },
  },
} as const;

function setup(opts: RunOptionsResponse | null = options(), results: unknown[] = []) {
  let push: (m: RunEventMessage) => void = () => {};
  let n = 0;
  const startRun = vi.fn(async () => ({
    success: true,
    id: `r${++n}`,
    state: (results[n - 1] ?? { status: "running", trace: [] }) as never,
    mode: "replay" as const,
  }));
  const api = {
    ...(opts && { getRunOptions: async () => opts }),
    startRun,
    approveRun: vi.fn(),
    subscribeToRunEvents: (_id: string, on: (m: RunEventMessage) => void) => {
      push = on;
      return () => {};
    },
  } as unknown as ApiClient;
  return { api, startRun, push: (m: RunEventMessage) => push(m) };
}

describe("Run bar", () => {
  afterEach(cleanup);

  it("opens on Replay, with no LIVE badge, and runs without a confirmation", async () => {
    const { api, startRun } = setup();
    render(<RunHarness api={api} showPanel={false} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(screen.queryByTestId("run-mode-badge")).toBeNull();
    fireEvent.click(screen.getByTestId("run-button"));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", "replay"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("badges LIVE and asks before a live run that could change something, naming the tool", async () => {
    const { api, startRun } = setup();
    render(<RunHarness api={api} showPanel={false} />);
    await waitFor(() => screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByTestId("run-mode-badge").textContent).toBe("LIVE");
    fireEvent.click(screen.getByTestId("run-button"));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByTestId("run-confirm-tools").textContent).toContain("post_alert");
    expect(startRun).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Run live" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", "live"));
  });

  it("shows no mode switch where the server cannot describe its runs (hosted)", async () => {
    const { api, startRun } = setup(null);
    render(<RunHarness api={api} showPanel={false} />);
    expect(screen.queryByRole("group", { name: "Run mode" })).toBeNull();
    fireEvent.click(screen.getByTestId("run-button"));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith("", undefined));
    expect(screen.queryByTestId("run-set-secret")).toBeNull();
  });

  it("calls a run that carried failed items on a warning, and keeps it in the drawer", async () => {
    const { api } = setup(options(), [COMPLETED_WITH_ERRORS]);
    render(<RunHarness api={api} showPanel={false} />);
    await waitFor(() => screen.getByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByTestId("run-button"));
    const chip = await screen.findByTestId("runbar-status");
    expect(chip.textContent).toContain("completed with 1 error");
    expect(chip.className).toContain("completed_with_errors");

    fireEvent.click(screen.getByTestId("runs-drawer-toggle"));
    const rows = within(screen.getByTestId("runs-drawer")).getAllByTestId("run-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Run 1");
    expect(rows[0]!.textContent).toContain("completed with 1 error");
    fireEvent.keyDown(screen.getByTestId("runs-drawer"), { key: "Escape" });
    expect(screen.queryByTestId("runs-drawer")).toBeNull();
  });

  it("keeps the run, and what was typed, when the Test Run panel closes and opens", async () => {
    const { api, push } = setup();
    const view = render(<RunHarness api={api} />);
    await waitFor(() => screen.getByRole("button", { name: "Replay" }));
    fireEvent.change(screen.getByLabelText("Input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("run-button"));
    await screen.findByTestId("run-trace");
    act(() =>
      push({
        type: "state",
        state: { status: "completed", trace: [], finalOutput: { a: 1 } } as never,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("runbar-status").textContent).toContain("completed"),
    );
    // Closing the panel (as opening Secrets does) must not cost the result.
    view.rerender(<RunHarness api={api} showPanel={false} />);
    expect(screen.getByTestId("runbar-status").textContent).toContain("completed");
    view.rerender(<RunHarness api={api} />);
    expect(screen.getByTestId("run-final-output").textContent).toContain('"a": 1');
    expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("hello");
  });

  it("offers Set it here from the bar for a missing credential, and disables Run while blocked", async () => {
    const failed = {
      status: "failed",
      trace: [],
      error: "Environment variable KEY is not set (referenced in a request field).",
    };
    const { api } = setup(options(), [failed]);
    const onSetSecret = vi.fn();
    render(<RunHarness api={api} showPanel={false} onSetSecret={onSetSecret} />);
    await waitFor(() => screen.getByRole("button", { name: "Replay" }));
    fireEvent.click(screen.getByTestId("run-button"));
    fireEvent.click(await screen.findByRole("button", { name: "Set it here" }));
    expect(onSetSecret).toHaveBeenCalledWith("KEY");
    cleanup();
    render(<RunHarness api={api} blockedReason="The workflow has errors" showPanel={false} />);
    expect((screen.getByTestId("run-button") as HTMLButtonElement).disabled).toBe(true);
  });
});
