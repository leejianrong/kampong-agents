import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalModal } from "../../src/ApprovalModal.js";
import { stepAfter } from "../../src/approvalNext.js";

// KAM-284: the approval dialog names the step and says what Approve and Reject will do, and keeps the message's
// line breaks. KAM-283: the step after an approval is found even when it sits in a branch arm.

afterEach(cleanup);

const WORKFLOW = [
  { step: "inbox", type: "tool", tool: "list" },
  {
    step: "decide",
    branch: {
      if: "x",
      then: [{ step: "save", type: "tool", tool: "save" }],
      else: [
        { step: "review", type: "approval", message: "ok?" },
        { step: "draft_approved", type: "tool", tool: "save" },
      ],
    },
  },
  { step: "report", type: "transform", set: { a: "1" } },
];

describe("stepAfter", () => {
  it("finds the next step at the top, inside an arm, and says when it is the last of its list", () => {
    expect(stepAfter(WORKFLOW, "inbox")).toBe("decide");
    expect(stepAfter(WORKFLOW, "review")).toBe("draft_approved");
    expect(stepAfter(WORKFLOW, "draft_approved")).toBeNull();
    expect(stepAfter(WORKFLOW, "report")).toBeNull();
    expect(stepAfter(WORKFLOW, "nope")).toBeUndefined();
  });

  it("looks inside a loop's body too", () => {
    const loop = [
      { step: "each", foreach: { items: "x", as: "i", steps: [{ step: "a" }, { step: "b" }] } },
    ];
    expect(stepAfter(loop, "a")).toBe("b");
  });
});

describe("ApprovalModal", () => {
  const approval = {
    step: "review",
    kind: "approval" as const,
    reason: "Low confidence (0.6).\n\nSubject: Refund\n\nHi Ana,\nWe can help.",
  };

  it("names the step, keeps the message's line breaks, and says what each button does", () => {
    const onDecide = vi.fn();
    render(<ApprovalModal approval={approval} next="draft_approved" onDecide={onDecide} />);
    expect(screen.getByTestId("approval-step").textContent).toContain("review");
    const reason = screen.getByTestId("approval-reason");
    expect(reason.textContent).toBe(approval.reason);
    // The stylesheet gives this class pre-line, so the blank lines and the line break in the message show.
    expect(reason.className).toContain("md3-approval__message");
    expect(screen.getByTestId("approval-approve-outcome").textContent).toContain("draft_approved");
    expect(screen.getByTestId("approval-reject-outcome").textContent).toContain("stops here");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith(true, undefined);
  });

  it("says the run goes on when the step after is not known, and names the tool for a tool pause", () => {
    render(
      <ApprovalModal
        approval={{ step: "send", kind: "tool", toolName: "issue_refund", reason: "Run it?" }}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByTestId("approval-step").textContent).toContain("issue_refund");
    expect(screen.getByTestId("approval-approve-outcome").textContent).toContain("issue_refund");
    expect(screen.getByTestId("approval-reject-outcome").textContent).toContain("not called");
  });
});
