import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { StepsPanel } from "../../src/StepsPanel.js";
import { moveErrorWords, type MoveOutcome } from "../../src/DeleteControl.js";

// KAM-174: Move up / Move down on the step rows of the Edit Steps panel.

const spec = {
  version: "1.1",
  agent: {
    id: "a",
    name: "A",
    role: "R",
    goal: "G",
    workflow: [
      { step: "fetch", action: "get" },
      { step: "gate", type: "validate", assert: "fetch.ok = true" },
      {
        step: "each",
        foreach: {
          items: "trigger.items",
          as: "item",
          steps: [
            { step: "inner1", action: "x" },
            { step: "inner2", action: "y" },
          ],
        },
      },
      {
        step: "pick",
        branch: {
          if: "fetch.ok = true",
          then: [
            { step: "a1", action: "x" },
            { step: "a2", action: "y" },
          ],
        },
      },
      {
        step: "route",
        branch: {
          switch: "fetch.kind",
          cases: {
            urgent: [
              { step: "u1", action: "x" },
              { step: "u2", action: "y" },
            ],
          },
        },
      },
    ],
  },
} as unknown as AgentSpec;

const ok: MoveOutcome = { success: true };

function setup(onMove = vi.fn(async (_op: unknown): Promise<MoveOutcome> => ok)) {
  render(<StepsPanel spec={spec} onPatch={vi.fn(async () => true)} onMove={onMove} />);
  return { onMove };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("StepsPanel move", () => {
  afterEach(cleanup);

  it("moves a top-level step up and down by one place", async () => {
    const { onMove } = setup();
    click("Move step gate up");
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({
        op: "step.move",
        step: "gate",
        to: { in: "workflow", index: 0 },
      }),
    );
    click("Move step gate down");
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({
        op: "step.move",
        step: "gate",
        to: { in: "workflow", index: 2 },
      }),
    );
  });

  it("moves within a foreach body, a branch arm and a switch case, in that list's own terms", async () => {
    const { onMove } = setup();
    click("Move step inner2 up");
    click("Move step a2 up");
    click("Move step u2 up");
    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(3));
    expect(onMove).toHaveBeenCalledWith({
      op: "step.move",
      step: "inner2",
      to: { in: { step: "each", slot: "steps" }, index: 0 },
    });
    expect(onMove).toHaveBeenCalledWith({
      op: "step.move",
      step: "a2",
      to: { in: { step: "pick", slot: "then" }, index: 0 },
    });
    expect(onMove).toHaveBeenCalledWith({
      op: "step.move",
      step: "u2",
      to: { in: { step: "route", slot: "cases", key: "urgent" }, index: 0 },
    });
  });

  it("disables Up on the first row of a list and Down on the last, with the reason", () => {
    setup();
    for (const name of ["fetch", "inner1", "a1", "u1"]) {
      const up = screen.getByRole("button", { name: `Move step ${name} up` }) as HTMLButtonElement;
      expect(up.disabled).toBe(true);
      expect(up.title).toBe("Already first in its list");
    }
    for (const name of ["route", "inner2", "a2", "u2"]) {
      const down = screen.getByRole("button", {
        name: `Move step ${name} down`,
      }) as HTMLButtonElement;
      expect(down.disabled).toBe(true);
      expect(down.title).toBe("Already last in its list");
    }
    expect(
      (screen.getByRole("button", { name: "Move step gate up" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a refused move in words and leaves the row alone", async () => {
    setup(
      vi.fn(async () => ({
        success: false as const,
        messages: moveErrorWords({
          code: "breaks_references",
          message:
            "the move puts a step before one it reads (gate reads fetch): move them together",
        }),
      })),
    );
    click("Move step fetch down");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('"fetch" was not moved');
    expect(alert.textContent).toContain('"gate" reads "fetch", so "fetch" has to stay before it.');
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has no Move buttons when the host does not offer moving", () => {
    render(<StepsPanel spec={spec} onPatch={vi.fn(async () => true)} />);
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("puts each refusal in plain words", () => {
    expect(
      moveErrorWords({
        code: "breaks_references",
        message: "the move puts a step before one it reads (a reads b, c reads d): x",
      }),
    ).toEqual([
      '"a" reads "b", so "b" has to stay before it.',
      '"c" reads "d", so "d" has to stay before it.',
    ]);
    expect(
      moveErrorWords({
        code: "breaks_references",
        message: "x is not something an expression can read",
      })[0],
    ).toContain("cannot see something it needs");
    expect(moveErrorWords({ message: "boom" })[0]).toContain("no longer be valid");
  });
});
