import type { ApiClient } from "../../src/api.js";
import { RunControls } from "../../src/RunControls.js";
import { RunPanel } from "../../src/RunPanel.js";
import { useRunSession } from "../../src/runSession.js";
import { RunTrackerProvider, useRunTrackerStore } from "../../src/runTracker.js";

// The Run bar and the Test Run panel over one run session, as the App mounts them (KAM-219), for the tests that
// drive a run from either.

export function RunHarness({
  api,
  blockedReason,
  onSetSecret,
  showPanel = true,
}: {
  api: ApiClient;
  blockedReason?: string;
  onSetSecret?: (name: string) => void;
  /** False draws the bar alone, as when the Test Run panel is closed. */
  showPanel?: boolean;
}) {
  const tracker = useRunTrackerStore();
  const session = useRunSession(api, tracker, { blockedReason });
  return (
    <RunTrackerProvider value={tracker}>
      <RunControls session={session} onOpenDetails={() => {}} onSetSecret={onSetSecret} />
      {showPanel && <RunPanel session={session} />}
    </RunTrackerProvider>
  );
}
