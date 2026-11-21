import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, RunEventMessage, RunState } from "../../src/api.js";
import { RunHarness } from "./RunHarness.js";

// KAM-280: a run waiting for a person's decision survives a page reload. The canvas asks the server for the runs
// still waiting and takes them up, so the approval dialog is there again and the run is in the Runs list.

afterEach(cleanup);

const WAITING = {
  status: "awaiting_approval",
  trace: [],
  pendingApproval: { kind: "approval", reason: "Send the refund?", step: "ok_to_send" },
} as unknown as RunState;

function api(pending: { id: string; state: RunState }[]) {
  const subscribed: string[] = [];
  const approveRun = vi.fn(async () => ({
    success: true,
    state: { status: "completed", trace: [], finalOutput: {} } as unknown as RunState,
  }));
  const client = {
    startRun: vi.fn(),
    approveRun,
    listPendingRuns: vi.fn(async () => pending),
    subscribeToRunEvents: (id: string, _on: (m: RunEventMessage) => void) => {
      subscribed.push(id);
      return () => {};
    },
  } as unknown as ApiClient;
  return { client, approveRun, subscribed };
}

describe("a pending approval after a reload", () => {
  it("shows the approval dialog again and lists the run, and a decision goes to that run", async () => {
    const { client, approveRun, subscribed } = api([{ id: "run-7", state: WAITING }]);
    render(<RunHarness api={client} showPanel={false} />);

    const dialog = await screen.findByRole("dialog", { name: "Approval required" });
    expect(dialog.textContent).toContain("Send the refund?");
    expect(screen.getByTestId("runbar-status").textContent).toContain("waiting for approval");
    expect(subscribed).toContain("run-7");

    screen.getByRole("button", { name: "Approve" }).click();
    await waitFor(() => expect(approveRun).toHaveBeenCalledWith("run-7", true, undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("changes nothing when no run is waiting", async () => {
    const { client } = api([]);
    render(<RunHarness api={client} showPanel={false} />);
    await waitFor(() => expect(client.listPendingRuns).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("No run yet")).toBeTruthy();
  });
});
