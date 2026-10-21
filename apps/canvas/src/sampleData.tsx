import { createContext, useContext, useMemo } from "react";
import { samplesFrom, type Samples } from "./dataPicker.js";
import { useRunTracker } from "./runTracker.js";

// What the data picker (KAM-218) needs beyond the run tracker: the input the shown run was given and, where a
// Replay run is possible, a way to start one so a picker with no values can fill itself in.

export interface SampleDataApi {
  /** The input text of the run on show. */
  input?: string | undefined;
  /** Starts a Replay run (recorded fixtures, nothing sent); absent when there are none to replay or a run is going. */
  replay?: (() => void) | undefined;
}

export const SampleDataContext = createContext<SampleDataApi>({});

/** The values of the run on show and the way to get some. Without a tracker there are no values. */
export function useSamples(): { samples: Samples; replay: (() => void) | undefined } {
  const tracker = useRunTracker();
  const { input, replay } = useContext(SampleDataContext);
  const trackerValue = tracker?.tracker;
  const samples = useMemo(
    () => (trackerValue ? samplesFrom(trackerValue, input) : { steps: {} }),
    [trackerValue, input],
  );
  return { samples, replay };
}
