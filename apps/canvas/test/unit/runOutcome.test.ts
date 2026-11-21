import { describe, expect, it } from "vitest";
import type { RunState } from "../../src/api.js";
import type { LogRow } from "../../src/runLog.js";
import { oneLine, outcomeOf } from "../../src/runOutcome.js";

// KAM-269: the answer to "what happened?" in plain words, before any step list.

const row = (label: string, status: LogRow["status"], error?: string, depth = 0): LogRow => ({
  id: label,
  step: label,
  label,
  depth,
  status,
  input: {},
  ...(error !== undefined && { error }),
});
const run = (over: Partial<RunState>): RunState =>
  ({ status: "completed", trace: [], ...over }) as RunState;

describe("outcomeOf", () => {
  it("says a clean run finished and how many steps ran", () => {
    expect(outcomeOf(run({}), [row("a", "passed"), row("b", "passed")])).toEqual({
      tone: "ok",
      headline: "Finished, everything worked",
      detail: "2 steps ran.",
    });
  });

  it("leads a run that carried on past a failure with what failed and why", () => {
    const o = outcomeOf(run({}), [
      row("each", "passed"),
      row("fetch · MSFT", "failed", "rate limit", 1),
    ]);
    expect(o.tone).toBe("warn");
    expect(o.headline).toBe("Finished, 1 step failed");
    expect(o.detail).toBe('The run carried on. First: "fetch · MSFT": rate limit');
  });

  it("names the step a failed run stopped at, with its reason on one line", () => {
    const o = outcomeOf(run({ status: "failed" }), [
      row("fetch", "failed", `line one\n   line two`),
    ]);
    expect(o).toEqual({
      tone: "error",
      headline: 'Stopped at "fetch"',
      detail: "line one line two",
    });
  });

  it("says what is waiting for a person", () => {
    const o = outcomeOf(
      run({
        status: "awaiting_approval",
        pendingApproval: { step: "ok_to_send" },
      } as Partial<RunState>),
      [],
    );
    expect(o.tone).toBe("wait");
    expect(o.detail).toContain("ok_to_send");
  });

  it("keeps a long reason to a line", () => {
    expect(oneLine("x".repeat(400)).length).toBe(160);
  });
});
