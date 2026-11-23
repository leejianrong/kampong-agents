import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLog } from "../../src/RunLog.js";
import type { RunSession } from "../../src/runSession.js";

// KAM-269 / 272 / 275: the run log leads with the outcome in words, its header is the outcome and the view
// switch, and a loop's items sit under the loop's row until one failed or the row is opened.

afterEach(cleanup);

const failedLoop = {
  each: {
    results: [{ index: 0 }, { index: 2 }],
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
    expect(banner).toContain("usage limit was reached");
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

  it("folds a loop with a failed item when its row is clicked, and opens it again", () => {
    render(<RunLog session={session(failedLoop)} open onToggle={() => {}} />);
    const loop = () => screen.getAllByTestId("run-log-row")[0]!;
    expect(screen.getAllByTestId("run-log-row")).toHaveLength(5);
    fireEvent.click(loop());
    expect(screen.getAllByTestId("run-log-row")).toHaveLength(2);
    expect(loop().textContent).toContain("1 failed");
    fireEvent.click(loop());
    expect(screen.getAllByTestId("run-log-row")).toHaveLength(5);
  });
});

describe("run log keyboard and detail (KAM-277, 270, 271)", () => {
  it("moves between the Steps and Timeline tabs with the arrow keys, one tab stop", () => {
    const withTrace = {
      ...session(failedLoop),
      fetchTrace: async () => undefined,
    } as unknown as RunSession;
    render(<RunLog session={withTrace} open onToggle={() => {}} />);
    const steps = screen.getByTestId("run-log-view-steps");
    const timeline = screen.getByTestId("run-log-view-timeline");
    expect(steps.getAttribute("tabindex")).toBe("0");
    expect(timeline.getAttribute("tabindex")).toBe("-1");
    steps.focus();
    fireEvent.keyDown(steps, { key: "ArrowRight" });
    expect(timeline.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(timeline);
  });

  it("moves between the step rows with the arrow keys and picks the row it lands on", () => {
    render(<RunLog session={session(failedLoop)} open onToggle={() => {}} />);
    const rows = () => screen.getAllByTestId("run-log-row");
    // The failed item is picked and is the one tab stop.
    const picked = rows().find((r) => r.getAttribute("aria-current") === "true")!;
    expect(picked.textContent).toContain("MSFT");
    expect(rows().filter((r) => r.getAttribute("tabindex") === "0")).toEqual([picked]);
    fireEvent.keyDown(picked, { key: "ArrowDown" });
    const next = rows().find((r) => r.getAttribute("aria-current") === "true")!;
    expect(next).not.toBe(picked);
    expect(document.activeElement).toBe(next);
  });

  it("explains a failed step first and keeps the raw message behind Show technical detail", () => {
    render(<RunLog session={session(failedLoop)} open onToggle={() => {}} />);
    const error = screen.getByTestId("run-log-error");
    expect(error.textContent).toContain("usage limit was reached");
    expect(within(error).getByText("Show technical detail")).toBeTruthy();
    expect(error.textContent).toContain("rate limited");
  });

  it("shows input and output as labelled fields with a JSON view, and leaves out an empty Input", () => {
    render(<RunLog session={session({})} open onToggle={() => {}} />);
    // The run's input is {} here, so there is no Input tab.
    expect(screen.queryByTestId("run-log-tab-input")).toBeNull();
    fireEvent.click(screen.getByTestId("run-log-tab-output"));
    const out = screen.getByTestId("run-log-output");
    expect(within(out).getByText("View as JSON")).toBeTruthy();
    fireEvent.click(within(out).getByText("View as JSON"));
    expect(out.querySelector("pre")).not.toBeNull();
  });
});

describe("a Replay with no recording (KAM-281)", () => {
  const MISSING =
    "No recorded model fixture at fixtures/@model.summarise.7f3a.json for summarise. Run once with `--tools record` against a live model.";
  function missing(input: string) {
    const base = session({}) as unknown as { viewed: Record<string, unknown> };
    const entries = { summarise: { startedAt: 0, endedAt: 5, outcome: "failed", error: MISSING } };
    const state = { status: "failed", trace: [], error: MISSING };
    return {
      ...base,
      input,
      canRun: true,
      runLive: vi.fn(),
      clearInput: vi.fn(),
      viewed: { ...base.viewed, input, state, tracker: { runId: "run-1", entries, state } },
    } as unknown as RunSession & {
      runLive: ReturnType<typeof vi.fn>;
      clearInput: ReturnType<typeof vi.fn>;
    };
  }

  it("offers Run live and Clear the input, and shows no flag or path until the detail is opened", () => {
    const s = missing("hello");
    render(<RunLog session={s} open onToggle={() => {}} />);
    const error = screen.getByTestId("run-log-error");
    const visible = error.querySelector(".md3-runlog__error-headline")!.textContent ?? "";
    expect(visible).toContain("no recorded answer");
    expect(visible).not.toMatch(/--tools|fixtures\//);
    fireEvent.click(within(error).getByRole("button", { name: "Run live" }));
    expect(s.runLive).toHaveBeenCalled();
    fireEvent.click(within(error).getByRole("button", { name: "Clear the input" }));
    expect(s.clearInput).toHaveBeenCalled();
  });

  it("does not offer Clear the input when there is none", () => {
    render(<RunLog session={missing("")} open onToggle={() => {}} />);
    expect(screen.queryByRole("button", { name: "Clear the input" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run live" })).toBeTruthy();
  });
});
