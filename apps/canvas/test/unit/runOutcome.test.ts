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
    expect(o.detail).toBe(
      'The run carried on. First: "fetch · MSFT": The service\'s usage limit was reached.',
    );
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

  it("says when a finished run went past an approval step, and where to change what makes it ask (KAM-283)", () => {
    const rows = [row("a", "passed")];
    const o = outcomeOf(run({}), rows, { skippedApprovals: ["review"], hasVars: true });
    expect(o.note).toBe(
      'The approval step "review" did not ask: nothing in this run needed a person. Change a value under Vars to see it.',
    );
    expect(outcomeOf(run({}), rows, { skippedApprovals: ["review"] }).note).not.toContain("Vars");
    expect(outcomeOf(run({}), rows, { skippedApprovals: ["a", "b"] }).note).toContain(
      "2 approval steps",
    );
    expect(outcomeOf(run({}), rows).note).toBeUndefined();
    // It is said on a run that finished with failures too, and never on one that stopped.
    const failed = [row("fetch", "failed", "boom", 1)];
    expect(outcomeOf(run({}), failed, { skippedApprovals: ["review"] }).note).toBeDefined();
    expect(
      outcomeOf(run({ status: "failed" }), failed, { skippedApprovals: ["review"] }).note,
    ).toBeUndefined();
  });
});
