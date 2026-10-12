import { describe, expect, it } from "vitest";
import type { StateStore } from "@kampong/engine";
import { startServeRunners } from "../../src/serve-runner.js";

const store: StateStore = {
  get: async () => undefined,
  put: async () => {},
  exists: async () => false,
  delete: async () => true,
  putIfAbsent: async () => true,
  list: async () => [],
  close: async () => {},
};

describe("startServeRunners", () => {
  it("is a safe no-op when there are no jobs (no store opened, resolves immediately)", async () => {
    let opened = false;
    const handle = startServeRunners([], {
      openStore: () => {
        opened = true;
        return store;
      },
      log: () => {},
    });
    expect(opened).toBe(false);
    expect(await handle.done).toEqual({ failed: false });
    await handle.stop();
  });

  it("reports failure when a job hits its consecutive-failure limit", async () => {
    const lines: string[] = [];
    const handle = startServeRunners(
      [{ name: "poll", intervalMs: 1, run: async () => Promise.reject(new Error("nope")) }],
      {
        openStore: () => store,
        log: (l) => lines.push(l),
        maxConsecutiveFailures: 2,
        clock: { now: () => Date.now(), sleep: async () => {} },
        random: () => 0.5,
      },
    );
    const result = await handle.done;
    expect(result.failed).toBe(true);
    expect(lines.join("\n")).toMatch(/poll[\s\S]*2 consecutive failures[\s\S]*nope/);
  });

  it("stop() aborts running jobs and resolves done without failure", async () => {
    const handle = startServeRunners([{ name: "j", intervalMs: 10_000, run: async () => {} }], {
      openStore: () => store,
      log: () => {},
    });
    await handle.stop();
    expect(await handle.done).toEqual({ failed: false });
  });
});
