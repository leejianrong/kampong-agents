import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunTrace } from "../../src/api.js";
import { RunLog } from "../../src/RunLog.js";
import type { RunSession } from "../../src/runSession.js";

// KAM-258: the run log's Timeline view reads the run's trace and says, in words, what was slow, what used the
// most and what failed. The Steps view is unchanged and stays the default.

afterEach(cleanup);

const trace: RunTrace = {
  id: "t",
  status: "error",
  startedAt: 0,
  endedAt: 9000,
  totals: { inputTokens: 900, outputTokens: 100, modelCalls: 1 },
  spans: [
    { id: "r", name: "agent", kind: "run", status: "error", startedAt: 0, endedAt: 9000 },
    {
      id: "a",
      parentId: "r",
      name: "draft",
      kind: "llm",
      status: "ok",
      startedAt: 0,
      endedAt: 6000,
    },
    {
      id: "m",
      parentId: "a",
      name: "gpt-x",
      kind: "model",
      model: "gpt-x",
      status: "ok",
      startedAt: 100,
      endedAt: 5900,
      usage: { inputTokens: 900, outputTokens: 100 },
    },
    {
      id: "b",
      parentId: "r",
      name: "send",
      kind: "tool",
      status: "error",
      startedAt: 6000,
      endedAt: 9000,
      error: "HTTP 500 from the mail API",
    },
  ],
};

function session(fetchTrace: RunSession["fetchTrace"]): RunSession {
  return {
    fetchTrace,
    viewed: {
      id: "run-1",
      input: "",
      startedAt: 0,
      endedAt: 9000,
      state: { status: "failed", trace: [] },
      tracker: { runId: "run-1", entries: {}, state: { status: "failed", trace: [] } },
    },
  } as unknown as RunSession;
}

describe("run log timeline", () => {
  it("offers no Timeline when the server cannot give a trace", () => {
    render(<RunLog session={session(undefined)} open onToggle={() => {}} />);
    expect(screen.queryByTestId("run-log-view-timeline")).toBeNull();
  });

  it("shows the plain-words facts and a bar per step and model call", async () => {
    const fetchTrace = vi.fn(async () => trace);
    render(<RunLog session={session(fetchTrace)} open onToggle={() => {}} />);
    expect(fetchTrace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("run-log-view-timeline"));
    const view = await screen.findByTestId("run-timeline");
    await waitFor(() => expect(fetchTrace).toHaveBeenCalledWith("run-1"));

    const facts = within(view)
      .getAllByTestId("run-timeline-fact")
      .map((f) => f.textContent);
    // What failed is the run log's banner above, so the facts do not say it twice.
    expect(facts.some((f) => f?.startsWith("Stopped at"))).toBe(false);
    expect(facts).toContain('Slowest step: "draft", 6.0 s.');
    expect(facts.at(-1)).toContain("1,000 tokens");

    const rows = within(view).getAllByTestId("run-timeline-row");
    expect(rows.map((r) => r.getAttribute("data-row-kind"))).toEqual(["llm", "model", "tool"]);
    expect(rows[2]!.getAttribute("data-row-status")).toBe("error");
    expect(rows[1]!.textContent).toContain("1,000 tokens");
  });

  it("says so when no timing was kept", async () => {
    render(<RunLog session={session(async () => undefined)} open onToggle={() => {}} />);
    fireEvent.click(screen.getByTestId("run-log-view-timeline"));
    expect((await screen.findByTestId("run-timeline-empty")).textContent).toContain(
      "No timing was kept",
    );
  });
});
