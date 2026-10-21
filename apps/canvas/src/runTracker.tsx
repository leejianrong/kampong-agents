import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { RunEventMessage } from "./api.js";
import { applyMessage, emptyTracker, type RunTracker } from "./runStatus.js";

// The seam between a run and the rest of the canvas (KAM-190). The Test Run panel publishes what the run's event
// stream says; the canvas, the run bar and the data picker read the tracker. Neither side knows the other.

export interface RunTrackerApi {
  tracker: RunTracker;
  /** A new run starts: whatever the last one showed is cleared. */
  begin(runId: string | null): void;
  /** The stream's message for a run (or the state its start returned). */
  publish(runId: string, message: RunEventMessage): void;
  /** Ask the run panel to show a node's failure message. A new request repeats an old one. */
  showMessage(nodeId: string): void;
  messageRequest: { nodeId: string; nonce: number } | null;
}

const RunTrackerContext = createContext<RunTrackerApi | null>(null);

/** The tracker, or null where nothing provides one (the run panel works on its own then). */
export function useRunTracker(): RunTrackerApi | null {
  return useContext(RunTrackerContext);
}

/** Holds the tracker for one canvas. */
export function useRunTrackerStore(): RunTrackerApi {
  const [tracker, setTracker] = useState<RunTracker>(emptyTracker);
  const [messageRequest, setRequest] = useState<RunTrackerApi["messageRequest"]>(null);
  const begin = useCallback((runId: string | null) => {
    setTracker({ ...emptyTracker, runId });
    setRequest(null);
  }, []);
  const publish = useCallback((runId: string, message: RunEventMessage) => {
    setTracker((t) => applyMessage(t, runId, message, Date.now()));
  }, []);
  const showMessage = useCallback((nodeId: string) => {
    setRequest((r) => ({ nodeId, nonce: (r?.nonce ?? 0) + 1 }));
  }, []);
  return useMemo(
    () => ({ tracker, begin, publish, showMessage, messageRequest }),
    [tracker, begin, publish, showMessage, messageRequest],
  );
}

export function RunTrackerProvider({
  value,
  children,
}: {
  value: RunTrackerApi;
  children: ReactNode;
}) {
  return <RunTrackerContext.Provider value={value}>{children}</RunTrackerContext.Provider>;
}
