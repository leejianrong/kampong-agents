import type { Reason } from "./runReason.js";
import type { RunSession } from "./runSession.js";

// KAM-281: a failure with a way out gets the buttons for it, next to the words. For Replay with no recording that
// is running the input live once, or clearing it to go back to what was recorded.

export function ReasonFix({ reason, session }: { reason: Reason; session: RunSession }) {
  if (reason.fix !== "replay_missing") return null;
  const canLive = session.options?.modes?.includes("live") ?? true;
  return (
    <div className="md3-runlog__error-fix" data-testid="reason-fix">
      {canLive && (
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={!session.canRun}
          onClick={session.runLive}
        >
          Run live
        </button>
      )}
      {session.input !== "" && (
        <button type="button" className="md3-button md3-button-text" onClick={session.clearInput}>
          Clear the input
        </button>
      )}
    </div>
  );
}
