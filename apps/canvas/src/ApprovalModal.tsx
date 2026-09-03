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
  onDecide: (approved: boolean, reason?: string) => void;
}

export function ApprovalModal({ approval, onDecide }: ApprovalModalProps) {
  const [reason, setReason] = useState("");

  return (
    <div className="md3-modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Approval required"
        className="md3-elevated-surface md3-stack"
      >
        <h2 className="md3-title-medium">Approval required</h2>
        <p className="md3-body-medium" data-testid="approval-reason">
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
        <div className="md3-form-actions">
          <button
            type="button"
            className="md3-button md3-button-filled"
            onClick={() => onDecide(true, reason || undefined)}
          >
            Approve
          </button>
          <button
            type="button"
            className="md3-button md3-button-outlined"
            onClick={() => onDecide(false, reason || undefined)}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
