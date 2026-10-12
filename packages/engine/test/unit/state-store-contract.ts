// Shared StateStore contract suite (ADR-0028). Any implementation (SQLite
// now, Postgres later) calls runStateStoreContract with a factory that builds
// a fresh, empty store driven by the supplied fake clock.
import { afterEach, describe, expect, it } from "vitest";
import type { StateStore } from "../../src/state-store.js";

export interface FakeClock {
  (): number;
  advance(ms: number): void;
}

export function createFakeClock(start = 1_000_000): FakeClock {
  let t = start;
  const clock = (() => t) as FakeClock;
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

export interface ContractHarness {
  create(clock: FakeClock): Promise<StateStore> | StateStore;
  /** Optional: a second store on the same backing data (shared file/db). */
  createPeer?(first: StateStore, clock: FakeClock): Promise<StateStore> | StateStore;
}

export function runStateStoreContract(name: string, harness: ContractHarness): void {
  describe(`StateStore contract: ${name}`, () => {
    const open: StateStore[] = [];
    afterEach(async () => {
      while (open.length) await open.pop()!.close();
    });
    async function make() {
      const clock = createFakeClock();
      const s = await harness.create(clock);
      open.push(s);
      return { s, clock };
    }

    it("get returns undefined for a missing key; put/get round-trips JSON", async () => {
      const { s } = await make();
      expect(await s.get("a")).toBeUndefined();
      await s.put("a", { n: 1, list: ["x", null], nested: { ok: true } });
      expect(await s.get("a")).toEqual({ n: 1, list: ["x", null], nested: { ok: true } });
      await s.put("a", "replaced");
      expect(await s.get("a")).toBe("replaced");
    });

    it("exists and delete", async () => {
      const { s } = await make();
      expect(await s.exists("k")).toBe(false);
      expect(await s.delete("k")).toBe(false);
      await s.put("k", 0);
      expect(await s.exists("k")).toBe(true);
      expect(await s.delete("k")).toBe(true);
      expect(await s.exists("k")).toBe(false);
      expect(await s.get("k")).toBeUndefined();
    });

    it("falsy values are stored, not treated as absent", async () => {
      const { s } = await make();
      await s.put("zero", 0);
      await s.put("empty", "");
      await s.put("nul", null);
      expect(await s.get("zero")).toBe(0);
      expect(await s.get("empty")).toBe("");
      expect(await s.get("nul")).toBeNull();
      expect(await s.exists("nul")).toBe(true);
    });

    it("TTL: entry is live before expiry and gone at/after it (fake clock)", async () => {
      const { s, clock } = await make();
      await s.put("t", "v", { ttlMs: 1000 });
      clock.advance(999);
      expect(await s.get("t")).toBe("v");
      expect(await s.exists("t")).toBe(true);
      clock.advance(1);
      expect(await s.get("t")).toBeUndefined();
      expect(await s.exists("t")).toBe(false);
      expect(await s.list("")).toEqual([]);
      expect(await s.delete("t")).toBe(false);
    });

    it("overwriting without ttl clears a prior expiry; with ttl resets it", async () => {
      const { s, clock } = await make();
      await s.put("k", 1, { ttlMs: 100 });
      await s.put("k", 2);
      clock.advance(10_000);
      expect(await s.get("k")).toBe(2);
      await s.put("k", 3, { ttlMs: 100 });
      clock.advance(50);
      await s.put("k", 4, { ttlMs: 100 });
      clock.advance(60);
      expect(await s.get("k")).toBe(4);
    });

    it("putIfAbsent: first wins, value untouched by the loser", async () => {
      const { s } = await make();
      expect(await s.putIfAbsent("lock", "a")).toBe(true);
      expect(await s.putIfAbsent("lock", "b")).toBe(false);
      expect(await s.get("lock")).toBe("a");
    });

    it("putIfAbsent treats an expired entry as absent and applies the new ttl", async () => {
      const { s, clock } = await make();
      expect(await s.putIfAbsent("lock", "a", { ttlMs: 100 })).toBe(true);
      expect(await s.putIfAbsent("lock", "b", { ttlMs: 100 })).toBe(false);
      clock.advance(100);
      expect(await s.putIfAbsent("lock", "c", { ttlMs: 500 })).toBe(true);
      expect(await s.get("lock")).toBe("c");
      clock.advance(499);
      expect(await s.exists("lock")).toBe(true);
      clock.advance(1);
      expect(await s.exists("lock")).toBe(false);
    });

    it("concurrent putIfAbsent on one key has exactly one winner", async () => {
      const { s } = await make();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => s.putIfAbsent("race", i)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await s.get("race")).toBe(results.indexOf(true));
    });

    it("concurrent putIfAbsent across two connections to the same data has one winner", async (ctx) => {
      if (!harness.createPeer) return ctx.skip();
      const { s, clock } = await make();
      const peer = await harness.createPeer(s, clock);
      open.push(peer);
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 ? s : peer).putIfAbsent("race2", i)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await peer.get("race2")).toBe(results.indexOf(true));
    });

    it("list returns live entries by prefix, ordered, with literal matching", async () => {
      const { s, clock } = await make();
      await s.put("incident:b", 2);
      await s.put("incident:a", 1);
      await s.put("incident:gone", 0, { ttlMs: 10 });
      await s.put("other:x", 9);
      await s.put("incident%y", "pct");
      await s.put("Incident:case", "case");
      clock.advance(10);
      expect(await s.list("incident:")).toEqual([
        { key: "incident:a", value: 1 },
        { key: "incident:b", value: 2 },
      ]);
      expect(await s.list("incident%")).toEqual([{ key: "incident%y", value: "pct" }]);
      expect(await s.list("nothing:")).toEqual([]);
      expect((await s.list("")).map((e) => e.key)).toEqual([
        "Incident:case",
        "incident%y",
        "incident:a",
        "incident:b",
        "other:x",
      ]);
    });
  });
}
