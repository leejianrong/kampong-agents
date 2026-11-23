import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHarness as RunPanel } from "./RunHarness.js";
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
    results: [{ index: 0 }],
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
      expect(screen.getByTestId("run-status").textContent).toContain(
        "Finished, 3 of 4 items failed",
      ),
    );
    expect(screen.getByTestId("run-status").innerHTML).toContain("completed_with_errors");
    const rows = screen.getAllByTestId("run-error-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("AAPL")).toBeTruthy();
    expect(within(rows[0]!).getByText("each_symbol / fetch")).toBeTruthy();
    expect(within(rows[0]!).getByText("no fixture for AAPL")).toBeTruthy();
  });

  it("keeps 25 failed items short: one group per reason, the items folded, no table (KAM-298)", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const message = (n: number) =>
      `Tool "kampong/alpha-vantage.time_series_daily" HTTP call to https://x.test/q?s=${n} failed: No recorded fixture for tool "x" at /home/jian/projects/a/b/c.json (after 3 attempts)`;
    const many = {
      each_symbol: {
        results: [],
        skipped: [],
        count: 25,
        errors: [
          ...Array.from({ length: 23 }, (_, i) => ({
            index: i,
            item: `Z${i}`,
            step: "fetch",
            message: message(i),
          })),
          { index: 23, item: "MSFT", step: "fetch", message: "HTTP 429 rate limit" },
          { index: 24, item: "GOOG", step: "fetch", message: "HTTP 429 rate limit" },
        ],
      },
    };
    render(<RunPanel api={apiFinishing(many)} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(screen.getByTestId("run-errors")).toBeTruthy());

    const groups = screen.getAllByTestId("run-error-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain("23 items");
    expect(groups[0]!.textContent).toContain("no recorded answer");
    expect(groups[1]!.textContent).toContain("2 items");
    // The big group is folded and the small one is open, so the panel stays short.
    const folds = groups.map((g) => g.querySelector(":scope > details") as HTMLDetailsElement);
    expect(folds[0]!.open).toBe(false);
    expect(folds[1]!.open).toBe(true);
    expect(screen.getByTestId("run-errors").querySelector("table")).toBeNull();
    // A file path from the raw message stays under "technical detail", not in the visible summary line.
    expect(groups[0]!.querySelector(".md3-run-failgroup__head")!.textContent).not.toContain(
      "/home",
    );
    expect(screen.getAllByTestId("run-error-row")).toHaveLength(25);
  });

  it("says 'error' for one and keeps a fully successful run plain completed", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const one = {
      loop: {
        results: [{ index: 0 }],
        skipped: [],
        count: 1,
        errors: [{ index: 0, item: 1, step: "s", message: "m" }],
      },
    };
    const { unmount } = render(<RunPanel api={apiFinishing(one)} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(screen.getByTestId("run-status").textContent).toContain(
        "Finished, 1 of 2 items failed",
      ),
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
