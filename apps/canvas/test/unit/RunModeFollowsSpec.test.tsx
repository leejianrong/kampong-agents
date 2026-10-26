import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient, RunOptionsResponse } from "../../src/api.js";
import { RunControls } from "../../src/RunControls.js";
import { useRunSession } from "../../src/runSession.js";
import { RunTrackerProvider, useRunTrackerStore } from "../../src/runTracker.js";

// KAM-205: a workflow built from a description starts live-only (it has a model step) and becomes replayable when
// the steps change. The bar should then move to the new default, unless the person had chosen a mode themselves.

const opts = (modes: ("replay" | "live")[]): RunOptionsResponse => ({
  success: true,
  modes,
  defaultMode: modes[0]!,
  fixtures: { available: false, count: 0 },
  tools: [],
  vars: [],
  modelCalls: false,
});

function Harness({ api, refreshKey }: { api: ApiClient; refreshKey: string }) {
  const tracker = useRunTrackerStore();
  const session = useRunSession(api, tracker, { refreshKey });
  return (
    <RunTrackerProvider value={tracker}>
      <RunControls session={session} onOpenDetails={() => {}} />
    </RunTrackerProvider>
  );
}

function setup() {
  let current = opts(["live"]);
  const api = { getRunOptions: async () => current } as unknown as ApiClient;
  const view = render(<Harness api={api} refreshKey="a" />);
  const change = (next: RunOptionsResponse) => {
    current = next;
    view.rerender(<Harness api={api} refreshKey={`${Math.random()}`} />);
  };
  return { change };
}

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";

describe("the run bar's mode follows the spec", () => {
  afterEach(cleanup);

  it("moves to Replay when it becomes open and nobody chose Live", async () => {
    const { change } = setup();
    // Live only: there is no switch, and the run is live.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Replay" })).toBeNull());
    change(opts(["replay", "live"]));
    await waitFor(() => expect(pressed("Replay")).toBe(true));
    expect(pressed("Live")).toBe(false);
  });

  it("keeps Live when the person picked it, even as Replay opens", async () => {
    const { change } = setup();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Replay" })).toBeNull());
    change(opts(["replay", "live"]));
    await waitFor(() => expect(pressed("Replay")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(pressed("Live")).toBe(true);
    change(opts(["replay", "live"]));
    await waitFor(() => expect(pressed("Live")).toBe(true));
  });
});
