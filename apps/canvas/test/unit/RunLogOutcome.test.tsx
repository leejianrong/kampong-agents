import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunLog } from "../../src/RunLog.js";
import type { RunSession } from "../../src/runSession.js";

// KAM-269 / 272 / 275: the run log leads with the outcome in words, its header is the outcome and the view
// switch, and a loop's items sit under the loop's row until one failed or the row is opened.

afterEach(cleanup);

const failedLoop = {
  each: {
    results: [],
    errors: [{ index: 1, step: "fetch", message: "rate limited", item: "MSFT" }],
  },
};

function session(finalOutput: Record<string, unknown>): RunSession {
  const entries = {
    each: { startedAt: 0, endedAt: 500, outcome: "completed" as const, output: { results: [] } },
    "each[0].fetch": { startedAt: 10, endedAt: 190, outcome: "completed" as const, output: 1 },
    "each[1].fetch": { startedAt: 200, endedAt: 210 },
    "each[2].fetch": { startedAt: 220, endedAt: 240, outcome: "completed" as const, output: 3 },
    done: { startedAt: 510, endedAt: 513, outcome: "completed" as const, output: "ok" },
  };
  const state = { status: "completed", trace: [], finalOutput } as never;
  return {
    viewed: {
      id: "run-1",
      input: "{}",
      startedAt: 0,
      endedAt: 513,
      mode: "replay",
      state,
      tracker: { runId: "run-1", entries, state },
    },
  } as unknown as RunSession;
}

describe("run log outcome", () => {
  it("leads a run that carried on past a failure with what failed, in a warning pill and banner", () => {
    render(<RunLog session={session(failedLoop)} open onToggle={() => {}} />);
    expect(screen.getByTestId("run-log-summary").textContent).toContain("Finished, 1 step failed");
    expect(screen.getByTestId("run-log-summary").className).toContain("completed_with_errors");
    const banner = screen.getByTestId("run-log-outcome").textContent ?? "";
    expect(banner).toContain("Finished, 1 step failed");
    expect(banner).toContain("fetch · MSFT");
    expect(banner).toContain("rate limited");
    // The header no longer carries a start time or step counts; they are in the pill's tooltip.
    expect(screen.getByTestId("run-log-summary").getAttribute("title")).toContain("steps");
  });

  it("lists a loop's items when one failed, and folds a clean loop until it is opened", () => {
    render(<RunLog session={session(failedLoop)} open onToggle={() => {}} />);
    expect(screen.getAllByTestId("run-log-row")).toHaveLength(5);

    cleanup();
    render(<RunLog session={session({})} open onToggle={() => {}} />);
    const rows = () =>
      screen.getAllByTestId("run-log-row").map((r) => r.getAttribute("data-run-step"));
    expect(rows()).toEqual(["each", "done"]);
    expect(screen.getByTestId("run-log-outcome").textContent).toContain("everything worked");
    const loop = within(screen.getByLabelText("Steps in this run")).getAllByTestId(
      "run-log-row",
    )[0]!;
    expect(loop.getAttribute("aria-expanded")).toBe("false");
    expect(loop.textContent).toContain("3 items");
    fireEvent.click(loop);
    expect(rows()).toEqual(["each", "fetch", "fetch", "fetch", "done"]);
  });
});
