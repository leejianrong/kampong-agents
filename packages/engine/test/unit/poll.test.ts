import { describe, expect, it } from "vitest";
import { processPoll, type PollConfig, type StateStore } from "../../src/index.js";

// KAM-117: which items a poll starts under each dedupe, and that a restart (a new poll over the same store)
// does not start them again.

function memoryStore(): StateStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => data.get(k) as never,
    put: async (k, v) => void data.set(k, v),
    exists: async (k) => data.has(k),
    delete: async (k) => data.delete(k),
    putIfAbsent: async (k, v) => (data.has(k) ? false : (data.set(k, v), true)),
    list: async () => [],
    close: async () => {},
  };
}

const msgs = (...uids: number[]) => ({
  messages: uids.map((uid) => ({ uid, subject: `s${uid}` })),
});
const base: PollConfig = { name: "poll", dedupe: "unique", id: "uid", items: "messages" };

async function poll(store: StateStore, config: PollConfig, result: unknown, fail?: () => boolean) {
  const started: unknown[][] = [];
  const outcome = await processPoll({
    store,
    config,
    result,
    start: async (batch) => {
      if (fail?.()) throw new Error("start failed");
      started.push(batch);
    },
  });
  return { started, outcome, uids: started.flat().map((i) => (i as { uid: number }).uid) };
}

describe("processPoll", () => {
  it.each(["unique", "greatest", "last"] as const)(
    "%s: one run per new item, none on a repeat",
    async (dedupe) => {
      const store = memoryStore();
      const config = { ...base, dedupe };
      const first = await poll(store, config, msgs(1, 2, 3));
      expect(first.uids).toEqual([1, 2, 3]);
      expect(first.started.every((b) => b.length === 1)).toBe(true);
      expect(first.outcome).toEqual({ fetched: 3, started: 3, runs: 3 });
      // "Restart": a fresh call over the same store sees the same list and starts nothing.
      expect((await poll(store, config, msgs(1, 2, 3))).uids).toEqual([]);
      expect((await poll(store, config, msgs(1, 2, 3, 4))).uids).toEqual([4]);
    },
  );

  it("unique starts an item once however it is ordered, and collapses a repeat within one list", async () => {
    const store = memoryStore();
    expect((await poll(store, base, msgs(3, 1, 3))).uids).toEqual([3, 1]);
    expect((await poll(store, base, msgs(2, 1))).uids).toEqual([2]);
  });

  it("greatest starts in ascending order and ignores keys at or below the cursor", async () => {
    const store = memoryStore();
    const config = { ...base, dedupe: "greatest" } as const;
    expect((await poll(store, config, msgs(5, 2, 9))).uids).toEqual([2, 5, 9]);
    expect((await poll(store, config, msgs(1, 9, 10, 4))).uids).toEqual([10]);
  });

  it("greatest compares string ids by value and refuses mixed kinds", async () => {
    const store = memoryStore();
    const config = { ...base, dedupe: "greatest", id: "$string(uid)" } as const;
    expect(
      (await poll(store, { ...config, id: "name" }, { messages: [{ name: "b" }, { name: "a" }] }))
        .started.length,
    ).toBe(2);
    await expect(poll(store, { ...config, id: "uid" }, msgs(1))).rejects.toThrow(/one kind/);
  });

  it("last starts what follows the previous last item, or everything if it has gone", async () => {
    const store = memoryStore();
    const config = { ...base, dedupe: "last" } as const;
    await poll(store, config, msgs(1, 2, 3));
    expect((await poll(store, config, msgs(2, 3, 4, 5))).uids).toEqual([4, 5]);
    expect((await poll(store, config, msgs(7, 8))).uids).toEqual([7, 8]);
  });

  it("time_window starts a key again once its window has passed", async () => {
    const store = memoryStore();
    const ttls: (number | undefined)[] = [];
    const real = store.putIfAbsent;
    store.putIfAbsent = async (k, v, o) => (ttls.push(o?.ttlMs), real(k, v, o));
    const config = { ...base, dedupe: "time_window", windowMs: 60_000 } as const;
    expect((await poll(store, config, msgs(1))).uids).toEqual([1]);
    expect(ttls).toEqual([60_000]);
    expect((await poll(store, config, msgs(1))).uids).toEqual([]);
    store.data.clear(); // the entry expiring
    expect((await poll(store, config, msgs(1))).uids).toEqual([1]);
  });

  it("a failed start is retried on the next poll, not lost (unique and cursor kinds)", async () => {
    for (const dedupe of ["unique", "greatest", "last"] as const) {
      const store = memoryStore();
      const config = { ...base, dedupe };
      let calls = 0;
      await expect(poll(store, config, msgs(1, 2), () => ++calls === 2)).rejects.toThrow(
        "start failed",
      );
      // Item 1 started, item 2 did not; only item 2 comes back.
      expect((await poll(store, config, msgs(1, 2))).uids).toEqual([2]);
    }
  });

  it("one_run_per_item false starts one run over the new items, and none when there are none", async () => {
    for (const dedupe of ["unique", "greatest", "last"] as const) {
      const store = memoryStore();
      const config = { ...base, dedupe, oneRunPerItem: false };
      const first = await poll(store, config, msgs(1, 2));
      expect(first.started).toHaveLength(1);
      expect(first.uids).toEqual([1, 2]);
      expect(first.outcome).toEqual({ fetched: 2, started: 2, runs: 1 });
      expect((await poll(store, config, msgs(1, 2))).started).toEqual([]);
    }
  });

  it("a failed batch start releases its keys", async () => {
    const store = memoryStore();
    const config = { ...base, oneRunPerItem: false };
    await expect(poll(store, config, msgs(1, 2), () => true)).rejects.toThrow("start failed");
    expect((await poll(store, config, msgs(1, 2))).uids).toEqual([1, 2]);
  });

  it("treats a missing list as empty and a lone match as a one-item list", async () => {
    const store = memoryStore();
    expect((await poll(store, base, {})).outcome.fetched).toBe(0);
    expect((await poll(store, base, { messages: { uid: 7 } })).uids).toEqual([7]);
  });

  it("uses the result as the list when there is no items expression", async () => {
    const { uids } = await poll(
      memoryStore(),
      { name: "poll", dedupe: "unique", id: "uid" },
      msgs(1).messages,
    );
    expect(uids).toEqual([1]);
    await expect(
      poll(memoryStore(), { name: "poll", dedupe: "unique", id: "uid" }, { messages: [] }),
    ).rejects.toThrow(/not a list/);
  });

  it("refuses an id that is missing or not a string or number, naming the item", async () => {
    await expect(
      poll(memoryStore(), base, { messages: [{ uid: 1 }, { subject: "x" }] }),
    ).rejects.toThrow(/item 1/);
    await expect(
      poll(memoryStore(), { ...base, id: "$" }, { messages: [{ a: 1 }] }),
    ).rejects.toThrow(/non-empty string or a number/);
  });

  it("keeps two pollers' state apart by name", async () => {
    const store = memoryStore();
    await poll(store, { ...base, name: "a" }, msgs(1));
    expect((await poll(store, { ...base, name: "b" }, msgs(1))).uids).toEqual([1]);
  });
});
