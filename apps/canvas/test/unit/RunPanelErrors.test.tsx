import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPanel } from "../../src/RunPanel.js";
import type { ApiClient } from "../../src/api.js";
import { failedItems } from "../../src/runErrors.js";

// KAM-189: a run that finished with failed foreach items is "completed with N errors" (amber) and lists each
// failure; a fully successful run stays plain green "completed".

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}

const THREE_FAILED = {
  each_symbol: {
    results: [],
    count: 3,
    skipped: [],
    errors: ["AAPL", "MSFT", "NVDA"].map((item, index) => ({
      index,
      item,
      step: "fetch",
      message: `no fixture for ${item}`,
    })),
  },
  report: { loaded: 0, failed: 3 },
};

function apiFinishing(finalOutput: Record<string, unknown>): ApiClient {
  return {
    startRun: vi.fn(async () => ({
      success: true,
      id: "r1",
      state: { status: "completed", trace: [], finalOutput },
    })),
    approveRun: vi.fn(),
    subscribeToRunEvents: () => () => {},
  } as unknown as ApiClient;
}

describe("failedItems", () => {
  it("collects each failed item with its step and message", () => {
    expect(failedItems(THREE_FAILED)).toEqual([
      {
        loop: "each_symbol",
        index: 0,
        item: "AAPL",
        step: "fetch",
        message: "no fixture for AAPL",
      },
      {
        loop: "each_symbol",
        index: 1,
        item: "MSFT",
        step: "fetch",
        message: "no fixture for MSFT",
      },
      {
        loop: "each_symbol",
        index: 2,
        item: "NVDA",
        step: "fetch",
        message: "no fixture for NVDA",
      },
    ]);
  });

  it("finds nothing in an ordinary output or a loop with no errors", () => {
    expect(failedItems(undefined)).toEqual([]);
    expect(failedItems({ a: { errors: [] }, b: "text" })).toEqual([]);
    expect(failedItems({ loop: { results: [{}], errors: [], skipped: [], count: 1 } })).toEqual([]);
  });
});

describe("RunPanel failed items", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reports completed with errors and tabulates the failed items", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    render(<RunPanel api={apiFinishing(THREE_FAILED)} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(screen.getByTestId("run-status").textContent).toContain("completed with 3 errors"),
    );
    expect(screen.getByTestId("run-status").innerHTML).toContain("completed_with_errors");
    const rows = screen.getAllByTestId("run-error-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("AAPL")).toBeTruthy();
    expect(within(rows[0]!).getByText("each_symbol / fetch")).toBeTruthy();
    expect(within(rows[0]!).getByText("no fixture for AAPL")).toBeTruthy();
  });

  it("says 'error' for one and keeps a fully successful run plain completed", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const one = {
      loop: {
        results: [],
        skipped: [],
        count: 1,
        errors: [{ index: 0, item: 1, step: "s", message: "m" }],
      },
    };
    const { unmount } = render(<RunPanel api={apiFinishing(one)} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-status").textContent).toContain("completed with 1 error"),
    );
    unmount();

    render(<RunPanel api={apiFinishing({ answer: "ok" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-status").textContent).toContain("completed"),
    );
    expect(screen.getByTestId("run-status").textContent).not.toContain("error");
    expect(screen.getByTestId("run-status").innerHTML).toContain("md3-status-pill--completed");
    expect(screen.queryByTestId("run-errors")).toBeNull();
    expect(screen.getByTestId("run-final-output")).toBeTruthy();
  });
});
