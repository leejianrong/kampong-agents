import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpec, specToGraph } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";
import { RunControls } from "../../src/RunControls.js";
import { RunPanel } from "../../src/RunPanel.js";
import { useRunSession } from "../../src/runSession.js";
import type { ApiClient, RunEventMessage, RunState } from "../../src/api.js";
import {
  applyMessage,
  baseStepName,
  deriveNodeStatuses,
  emptyTracker,
  type RunTracker,
} from "../../src/runStatus.js";
import { RunTrackerProvider, useRunTrackerStore } from "../../src/runTracker.js";

// KAM-190: each node shows what the run did to it (running, passed, failed, skipped), inside a foreach and in
// branch arms, with an icon and a word, and a failed node links to its message in the run panel.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const SOURCE = `version: "1.1"
agent:
  id: triage
  name: Triage
  role: R
  goal: G
  tools:
    - name: reply
      action: http_request
      method: POST
      url: "https://x.example/reply"
  workflow:
    - step: each_item
      foreach:
        items: "trigger.items"
        as: item
        on_error: continue
        steps:
          - step: fetch
            type: tool
            tool: reply
    - step: route
      branch:
        if: "true"
        then:
          - step: taken
            type: tool
            tool: reply
        else:
          - step: untaken
            type: tool
            tool: reply
    - step: report
      type: tool
      tool: reply
`;

const IDS = [
  "workflow:each_item",
  "workflow:fetch",
  "workflow:route",
  "workflow:taken",
  "workflow:untaken",
  "workflow:report",
];

const state = (over: Partial<RunState>): RunState => ({ status: "running", trace: [], ...over });
const started = (step: string, s: RunState): RunEventMessage => ({
  type: "event",
  event: { type: "step_started", step },
  state: s,
});

function fold(messages: RunEventMessage[], runId = "r1"): RunTracker {
  let t: RunTracker = { ...emptyTracker, runId };
  let now = 1000;
  for (const m of messages) t = applyMessage(t, runId, m, (now += 100));
  return t;
}

describe("baseStepName", () => {
  it("strips loop prefixes, however deep", () => {
    expect(baseStepName("report")).toBe("report");
    expect(baseStepName("each_item[2].fetch")).toBe("fetch");
    expect(baseStepName("outer[0].inner[1].deep")).toBe("deep");
  });
});

describe("deriveNodeStatuses", () => {
  it("marks a started step running and a finished one passed, with its output and timing", () => {
    const s1 = state({});
    const s2 = state({ trace: [{ step: "each_item", status: "completed", output: { n: 1 } }] });
    const t = fold([started("each_item", s1), started("route", s2)]);
    const got = deriveNodeStatuses(t, IDS);
    expect(got["workflow:route"]).toMatchObject({ status: "running" });
    expect(got["workflow:each_item"]).toMatchObject({
      status: "passed",
      output: { n: 1 },
    });
    expect(got["workflow:each_item"]!.durationMs).toBeGreaterThan(0);
    expect(got["workflow:report"]).toBeUndefined();
  });

  it("aggregates a foreach's nested step across items: running while any is, failed if any failed", () => {
    const running = fold([
      started("each_item[0].fetch", state({})),
      started("each_item[1].fetch", state({})),
    ]);
    expect(deriveNodeStatuses(running, IDS)["workflow:fetch"]).toMatchObject({
      status: "running",
      runs: 2,
    });
    const failed = fold([
      started("each_item[0].fetch", state({})),
      started("each_item[1].fetch", state({})),
      started(
        "each_item[1].fetch",
        state({ trace: [{ step: "each_item[1].fetch", status: "failed", error: "boom" }] }),
      ),
    ]);
    expect(deriveNodeStatuses(failed, IDS)["workflow:fetch"]).toMatchObject({
      status: "failed",
      message: "boom",
    });
  });

  it("marks the steps of an untaken branch arm skipped once the run completes, and leaves them blank before", () => {
    const mid = state({ trace: [{ step: "route", status: "completed", output: {} }] });
    expect(
      deriveNodeStatuses(fold([started("taken", mid)]), IDS)["workflow:untaken"],
    ).toBeUndefined();
    const done = state({
      status: "completed",
      trace: [
        { step: "route", status: "completed", output: {} },
        { step: "taken", status: "completed", output: 1 },
        { step: "report", status: "completed", output: 2 },
      ],
      finalOutput: {},
    });
    const got = deriveNodeStatuses(fold([{ type: "state", state: done }]), IDS);
    expect(got["workflow:untaken"]).toEqual({ status: "skipped" });
    expect(got["workflow:taken"]!.status).toBe("passed");
  });

  // Regression: a foreach that carries on past a failed item emits a start for the nested step and no result, so
  // the step read "running" for ever after the run completed.
  it("does not leave a loop step running after a completed run whose loop reported it failed", () => {
    const done = state({
      status: "completed",
      trace: [{ step: "each_item", status: "completed", output: {} }],
      finalOutput: {
        each_item: {
          results: [],
          errors: [{ index: 0, item: "a", step: "fetch", message: "no fixture for a" }],
        },
      },
    });
    const t = fold([started("each_item[0].fetch", state({})), { type: "state", state: done }]);
    expect(deriveNodeStatuses(t, IDS)["workflow:fetch"]).toMatchObject({
      status: "failed",
      message: "no fixture for a",
    });
  });

  it("marks the failed step failed with its message, and does not mark steps a failed run never reached", () => {
    const failed = state({
      status: "failed",
      error: "bad",
      trace: [{ step: "route", status: "failed", error: "bad" }],
    });
    const got = deriveNodeStatuses(
      fold([started("route", state({})), { type: "state", state: failed }]),
      IDS,
    );
    expect(got["workflow:route"]).toMatchObject({ status: "failed", message: "bad" });
    expect(got["workflow:report"]).toBeUndefined();
  });

  it("shows the step an approval is waiting on", () => {
    const waiting = state({
      status: "awaiting_approval",
      pendingApproval: { step: "report", kind: "tool", reason: "r" },
    });
    const got = deriveNodeStatuses(fold([{ type: "state", state: waiting }]), IDS);
    expect(got["workflow:report"]).toEqual({ status: "waiting" });
  });

  it("learns a finished step from the state even when its start event came before the stream opened", () => {
    const s = state({ trace: [{ step: "report", status: "completed", output: 1 }] });
    const got = deriveNodeStatuses(fold([{ type: "state", state: s }]), IDS);
    expect(got["workflow:report"]).toMatchObject({ status: "passed", output: 1 });
  });

  it("ignores a message for a run that is not the current one", () => {
    const t = { ...emptyTracker, runId: "new" };
    const next = applyMessage(t, "old", started("report", state({})), 1);
    expect(next).toBe(t);
  });
});

// The seam end to end: the panel publishes, the canvas draws, a failed node links back.
function Harness({ api }: { api: ApiClient }) {
  const store = useRunTrackerStore();
  const session = useRunSession(api, store);
  const { spec } = parseSpec(SOURCE);
  const graph = specToGraph(spec!);
  const layout = Object.fromEntries(graph.nodes.map((n, i) => [n.id, { x: 0, y: i * 120 }]));
  return (
    <RunTrackerProvider value={store}>
      <Canvas
        graph={graph}
        layout={layout}
        runStatus={deriveNodeStatuses(
          store.tracker,
          graph.nodes.map((n) => n.id),
        )}
        onShowRunMessage={store.showMessage}
      />
      <RunControls session={session} onOpenDetails={() => {}} />
      <RunPanel session={session} />
    </RunTrackerProvider>
  );
}

describe("run status on the canvas", () => {
  it("updates nodes live, links a failure to its message, and clears on the next run", async () => {
    let push: (m: RunEventMessage) => void = () => {};
    const startRun = vi.fn(async () => ({
      success: true,
      id: `r${startRun.mock.calls.length}`,
      state: state({}),
    }));
    const api = {
      startRun,
      approveRun: vi.fn(),
      subscribeToRunEvents: (_id: string, on: (m: RunEventMessage) => void) => {
        push = on;
        return () => {};
      },
    } as unknown as ApiClient;
    render(<Harness api={api} />);
    const start = () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    };
    start();
    await waitFor(() => expect(startRun).toHaveBeenCalled());

    act(() => push(started("each_item", state({}))));
    const node = (name: RegExp) => screen.getByLabelText(name);
    await waitFor(() =>
      expect(
        within(node(/Foreach step each_item/)).getByTestId("node-run-status").textContent,
      ).toContain("Running"),
    );

    const failed = state({
      status: "failed",
      error: "boom",
      trace: [{ step: "each_item", status: "failed", error: "boom" }],
    });
    act(() => push({ type: "state", state: failed }));
    const badge = within(node(/Foreach step each_item/)).getByTestId("node-run-status");
    // Not colour alone: a word and an icon.
    expect(badge.textContent).toContain("Failed");
    expect(badge.querySelector("[aria-hidden='true']")).not.toBeNull();

    fireEvent.click(screen.getByTestId("node-run-message"));
    await waitFor(() => {
      const row = screen.getByTestId("run-trace").querySelector("[data-run-failed]");
      expect(row).toBe(document.activeElement);
      expect(row?.textContent).toContain("boom");
    });

    // The next run clears the marks as it starts.
    start();
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryAllByTestId("node-run-status")).toHaveLength(0));
  });
});
