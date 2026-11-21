import { useState } from "react";
import type { PendingApproval } from "./api.js";

// The blocking human-approval modal (PLAN.md Affordances "Test-run sandbox
// + approval modal", SLICES.md V2 KAN-1104/1107): the browser front end for
// the engine's front-end-agnostic pending-approval state
// (packages/engine/src/run.ts). A future CLI stdin prompt (V3, out of
// scope) would drive the same `/api/runs/:id/approve` decision, just from a
// terminal instead of this dialog.

export interface ApprovalModalProps {
  approval: PendingApproval;
  /**
   * The step that runs after this one (KAM-284): its name, null when this is the last of its arm or loop, undefined
   * when it is not known. Used to say what Approve does.
   */
  next?: string | null | undefined;
  /** The approval step's plain-words title, when it has one (KAM-290); the id is shown otherwise. */
  stepTitle?: string | undefined;
  onDecide: (approved: boolean, reason?: string) => void;
}

export function ApprovalModal({ approval, next, stepTitle, onDecide }: ApprovalModalProps) {
  const [reason, setReason] = useState("");

  const isTool = approval.kind === "tool" && approval.toolName !== undefined;
  const goesOn = typeof next === "string" ? `The run goes on to "${next}".` : "The run goes on.";
  const approves = isTool ? `${approval.toolName} runs, then the run goes on.` : goesOn;
  const rejects = isTool
    ? `${approval.toolName} is not called and the run stops.`
    : "The run stops here. Nothing after this step runs.";

  return (
    <div className="md3-modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Approval required"
        className="md3-elevated-surface md3-stack"
      >
        <h2 className="md3-title-medium">Approval required</h2>
        <p className="md3-label-large md3-approval__step" data-testid="approval-step">
          {isTool ? `Tool: ${approval.toolName}` : `Step: ${stepTitle ?? approval.step}`}
        </p>
        <p className="md3-body-medium md3-approval__message" data-testid="approval-reason">
          {approval.reason}
        </p>
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Note (optional)</span>
          <input
            className="md3-text-field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="md3-approval__choices">
          <div className="md3-approval__choice">
            <button
              type="button"
              className="md3-button md3-button-filled"
              onClick={() => onDecide(true, reason || undefined)}
            >
              Approve
            </button>
            <p className="md3-body-small" data-testid="approval-approve-outcome">
              {approves}
            </p>
          </div>
          <div className="md3-approval__choice">
            <button
              type="button"
              className="md3-button md3-button-outlined"
              onClick={() => onDecide(false, reason || undefined)}
            >
              Reject
            </button>
            <p className="md3-body-small" data-testid="approval-reject-outcome">
              {rejects}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
