import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api.js";
import { useRunSession } from "../../src/runSession.js";
import { useRunTrackerStore } from "../../src/runTracker.js";

// KAM-349: when the spec changes the bar must already be waiting in that same render. Waiting only from an effect
// left Run enabled for one paint, and a press in that window was swallowed when the bar went disabled again.

function useSession(api: ApiClient, refreshKey: string) {
  const tracker = useRunTrackerStore();
  return useRunSession(api, tracker, { refreshKey });
}

describe("run options while the spec changes (KAM-349)", () => {
  it("is waiting in the render where the spec changed, and can run once loaded", async () => {
    const api = {
      getRunOptions: async () => ({ success: true, modes: ["replay"], defaultMode: "replay" }),
      startRun: async () => ({ success: false }),
      approveRun: async () => ({ success: false }),
      subscribeToRunEvents: () => () => {},
    } as unknown as ApiClient;
    const { result, rerender } = renderHook(({ key }) => useSession(api, key), {
      initialProps: { key: "a" },
    });
    await waitFor(() => expect(result.current.canRun).toBe(true));

    // Capture every render's value, not just the settled one.
    const seen: boolean[] = [];
    const probe = renderHook(
      ({ key }) => {
        const s = useSession(api, key);
        seen.push(s.canRun);
        return s;
      },
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(probe.result.current.canRun).toBe(true));
    seen.length = 0;
    act(() => probe.rerender({ key: "b" }));
    expect(seen[0]).toBe(false);
    await waitFor(() => expect(probe.result.current.canRun).toBe(true));
    rerender({ key: "a" });
  });
});
