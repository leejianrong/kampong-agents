import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "../../src/RunPanel.js";
import { createApiClient } from "../../src/api.js";

// SLICES.md V2 KAN-1107: the in-canvas test-run panel shows live per-step
// state and surfaces the approval modal on a guardrail/tool pause. Fetch
// and EventSource are faked so this never touches a real server/network,
// mirroring App.test.tsx's conventions.

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("RunPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts a run, shows the awaiting-approval modal, and reflects completion after approving", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const awaitingState = {
      status: "awaiting_approval",
      trace: [{ step: "parse_request", status: "completed", output: { text: "ok" } }],
      pendingApproval: {
        step: "decide",
        kind: "tool",
        reason: 'Tool "issue_refund" requires approval before it runs.',
      },
    };
    const completedState = {
      status: "completed",
      trace: [
        { step: "parse_request", status: "completed", output: { text: "ok" } },
        { step: "decide", status: "completed", output: "refunded" },
      ],
      finalOutput: { decide: "refunded" },
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/runs") {
        return {
          json: async () => ({ success: true, id: "run-1", state: awaitingState }),
        } as Response;
      }
      if (url === "/api/runs/run-1/approve") {
        return { json: async () => ({ success: true, state: completedState }) } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient();
    render(<RunPanel api={api} />);

    fireEvent.change(screen.getByLabelText("Input"), { target: { value: "Refund order #1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => {
      expect(screen.getByTestId("run-status").textContent).toContain("awaiting_approval");
    });
    expect(screen.getByRole("dialog", { name: "Approval required" })).toBeTruthy();
    expect(screen.getByTestId("approval-reason").textContent).toContain("issue_refund");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.getByTestId("run-status").textContent).toContain("completed");
    });
    expect(screen.getByTestId("run-final-output").textContent).toContain("refunded");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a rejected halt message and no dialog after rejecting", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);

    const awaitingState = {
      status: "awaiting_approval",
      trace: [],
      pendingApproval: {
        step: "evaluate_policy",
        kind: "guardrail",
        reason: "Confidence 0.4 is below threshold 0.85.",
      },
    };
    const rejectedState = {
      status: "rejected",
      trace: [{ step: "evaluate_policy", status: "failed", error: "Not confident enough." }],
      error: "Not confident enough.",
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/runs") {
        return {
          json: async () => ({ success: true, id: "run-2", state: awaitingState }),
        } as Response;
      }
      if (url === "/api/runs/run-2/approve") {
        return { json: async () => ({ success: true, state: rejectedState }) } as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient();
    render(<RunPanel api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => screen.getByRole("dialog"));

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(screen.getByTestId("run-halted").textContent).toContain("rejected");
    });
    expect(screen.getByTestId("run-halted").textContent).toContain("Not confident enough.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
