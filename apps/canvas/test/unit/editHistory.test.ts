import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api.js";
import {
  EditHistory,
  HISTORY_DEPTH,
  pinDiff,
  restoreSnapshot,
  withHistory,
  type Snapshot,
} from "../../src/editHistory.js";

// KAM-183 (ADR-0062): the undo stack and the restore it performs.

const snap = (source: string, layout: Snapshot["layout"] = {}): Snapshot => ({ source, layout });

describe("EditHistory", () => {
  it("records edits, and a new edit ends the redo chain", () => {
    const h = new EditHistory();
    h.record(snap("a"), "r1");
    h.record(snap("b"), "r2");
    expect(h.undoCount).toBe(2);
    h.commitUndo(snap("c"), "r3");
    expect(h.undoCount).toBe(1);
    expect(h.redoCount).toBe(1);
    h.record(snap("d"), "r4");
    expect(h.redoCount).toBe(0);
    expect(h.revision).toBe("r4");
  });

  it("undo then redo returns to the same snapshots", () => {
    const h = new EditHistory();
    h.record(snap("a"), "r1");
    expect(h.peekUndo()?.source).toBe("a");
    h.commitUndo(snap("b"), "r2");
    expect(h.peekRedo()?.source).toBe("b");
    h.commitRedo(snap("a"), "r3");
    expect(h.peekUndo()?.source).toBe("a");
    expect(h.redoCount).toBe(0);
  });

  it("caps the depth, dropping the oldest", () => {
    const h = new EditHistory(3);
    for (const s of ["a", "b", "c", "d", "e"]) h.record(snap(s));
    expect(h.undoCount).toBe(3);
    expect(h.peekUndo()?.source).toBe("e");
    h.commitUndo(snap("x"));
    h.commitUndo(snap("x"));
    h.commitUndo(snap("x"));
    expect(h.peekUndo()).toBeUndefined();
    expect(HISTORY_DEPTH).toBe(100);
  });

  it("does not record an edit made to a workflow that did not exist", () => {
    const h = new EditHistory();
    h.record(snap("   \n"), "r1");
    expect(h.undoCount).toBe(0);
  });

  it("clear empties both stacks, says whether there was anything, and notifies", () => {
    const h = new EditHistory();
    const listener = vi.fn();
    h.subscribe(listener);
    expect(h.clear()).toBe(false);
    h.record(snap("a"), "r1");
    listener.mockClear();
    expect(h.clear()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.undoCount).toBe(0);
    expect(h.revision).toBeUndefined();
  });

  it("is busy while a write or a restore is in flight", () => {
    const h = new EditHistory();
    h.writing(1);
    expect(h.busy).toBe(true);
    h.writing(-1);
    expect(h.busy).toBe(false);
    h.restoringNow(true);
    expect(h.busy).toBe(true);
  });

  it("idle resolves when the write in flight finishes", async () => {
    const h = new EditHistory();
    h.writing(1);
    let done = false;
    void h.idle().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    h.writing(-1);
    await Promise.resolve();
    expect(done).toBe(true);
    await h.idle();
  });
});

describe("pinDiff", () => {
  it("sets pins the target has, unpins the ones it lacks, and ignores unpinned positions", () => {
    const current = {
      $layout: { x: 3, y: 0 },
      a: { x: 1, y: 1, pinned: true },
      b: { x: 5, y: 5, pinned: true },
      c: { x: 9, y: 9 },
    };
    const target = {
      $layout: { x: 3, y: 0 },
      a: { x: 1, y: 1, pinned: true },
      c: { x: 0, y: 0, pinned: true },
    };
    expect(pinDiff(current, target)).toEqual({ b: null, c: { x: 0, y: 0 } });
  });
});

function fakeApi() {
  const replaceSource = vi.fn(async (_source: string, options?: { baseRevision?: string }) =>
    options?.baseRevision === "old"
      ? { success: false, stale: true, errors: [{ path: [], message: "the spec changed" }] }
      : { success: true, revision: "new" },
  );
  const pinPositions = vi.fn(async () => ({ success: true }));
  return { replaceSource, pinPositions };
}

describe("restoreSnapshot", () => {
  it("writes the text with the base revision, then the pins", async () => {
    const api = fakeApi();
    const result = await restoreSnapshot(
      api,
      { source: "# keep me\nA", layout: { a: { x: 1, y: 2, pinned: true } } },
      snap("B"),
      "rev",
    );
    expect(result).toEqual({ ok: true, revision: "new" });
    expect(api.replaceSource).toHaveBeenCalledWith("# keep me\nA", { baseRevision: "rev" });
    expect(api.pinPositions).toHaveBeenCalledWith({ a: { x: 1, y: 2 } });
  });

  it("a layout-only snapshot writes no text", async () => {
    const api = fakeApi();
    const result = await restoreSnapshot(
      api,
      { source: "A", layout: { a: { x: 1, y: 2, pinned: true } } },
      snap("A"),
    );
    expect(result.ok).toBe(true);
    expect(api.replaceSource).not.toHaveBeenCalled();
    expect(api.pinPositions).toHaveBeenCalledOnce();
  });

  it("a stale revision is refused and nothing else is written", async () => {
    const api = fakeApi();
    const result = await restoreSnapshot(
      api,
      { source: "A", layout: { a: { x: 1, y: 2, pinned: true } } },
      snap("B"),
      "old",
    );
    expect(result).toEqual({ ok: false, stale: true, messages: ["the spec changed"] });
    expect(api.pinPositions).not.toHaveBeenCalled();
  });

  it("without a layout it writes only the text (the assistant's Undo)", async () => {
    const api = fakeApi();
    const result = await restoreSnapshot(api, { source: "A" }, snap("B"));
    expect(result.ok).toBe(true);
    expect(api.pinPositions).not.toHaveBeenCalled();
  });
});

describe("withHistory", () => {
  function client() {
    return {
      applyOps: vi.fn(async () => ({ success: true, revision: "r2" })),
      applyPatch: vi.fn(async () => ({ success: true, revision: "r3" })),
      replaceSource: vi.fn(async () => ({ success: false, errors: [] })),
      pinPositions: vi.fn(async () => ({ success: true })),
      startBlank: vi.fn(async () => ({ success: true })),
      loadSpec: vi.fn(),
    } as unknown as ApiClient;
  }

  it("records a successful write with the state from before it, and ignores a refused one", async () => {
    const h = new EditHistory();
    let state = snap("v1");
    const api = withHistory(client(), h, () => state);
    await api.applyOps([]);
    state = snap("v2");
    await api.replaceSource("x");
    expect(h.undoCount).toBe(1);
    expect(h.peekUndo()?.source).toBe("v1");
    expect(h.revision).toBe("r2");
    await api.applyPatch([]);
    expect(h.undoCount).toBe(2);
    expect(h.revision).toBe("r3");
  });

  it("records a drag-pin as a layout-only snapshot, and keeps the revision", async () => {
    const h = new EditHistory();
    const before = snap("v1", { a: { x: 0, y: 0 } });
    const api = withHistory(client(), h, () => before);
    await api.applyOps([]);
    await api.pinPositions({ a: { x: 9, y: 9 } });
    expect(h.undoCount).toBe(2);
    expect(h.revision).toBe("r2");
  });
});

describe("withHistory, reading what is stored (KAM-183 review)", () => {
  it("takes each before from the server, one write at a time, so two quick edits record two different states", async () => {
    let stored = "v1";
    const order: string[] = [];
    const raw = {
      loadSpec: vi.fn(async () => ({ success: true, source: stored, layout: {}, errors: [] })),
      applyOps: vi.fn(async (ops: unknown[]) => {
        await new Promise((r) => setTimeout(r, 5));
        stored = `after-${(ops as { n: number }[])[0]!.n}`;
        order.push(stored);
        return { success: true, revision: stored };
      }),
    } as unknown as ApiClient;
    const h = new EditHistory();
    const api = withHistory(raw, h, () => snap("stale-screen"));
    await Promise.all([api.applyOps([{ n: 1 } as never]), api.applyOps([{ n: 2 } as never])]);
    expect(order).toEqual(["after-1", "after-2"]);
    expect(h.undoCount).toBe(2);
    h.commitUndo(snap("x"));
    expect(h.peekUndo()?.source).toBe("v1");
    h.commitUndo(snap("x"));
    expect(h.peekRedo()?.source).toBe("x");
  });

  it("a drop that moves nothing is not an edit and does not clear redo", async () => {
    const layout = { a: { x: 1, y: 1, pinned: true } };
    const raw = {
      loadSpec: vi.fn(async () => ({ success: true, source: "v1", layout, errors: [] })),
      pinPositions: vi.fn(async () => ({ success: true, layout })),
    } as unknown as ApiClient;
    const h = new EditHistory();
    h.record(snap("v0"), "r1");
    h.commitUndo(snap("v1"));
    expect(h.redoCount).toBe(1);
    await withHistory(raw, h, () => snap("v1")).pinPositions({ a: { x: 1, y: 1 } });
    expect(h.undoCount).toBe(0);
    expect(h.redoCount).toBe(1);
  });
});

describe("restoreSnapshot when the positions fail (KAM-183 review)", () => {
  it("says the text was already written, with its revision", async () => {
    const api = {
      replaceSource: vi.fn(async () => ({ success: true, revision: "r9" })),
      pinPositions: vi.fn(async () => ({ success: false, error: "nope" })),
    };
    const result = await restoreSnapshot(
      api,
      { source: "A", layout: { a: { x: 1, y: 1, pinned: true } } },
      snap("B"),
    );
    expect(result).toMatchObject({ ok: false, textWritten: { revision: "r9" } });
  });
});

describe("EditHistory revision and echo (KAM-183 review)", () => {
  it("seeds a revision only while the stack is empty", () => {
    const h = new EditHistory();
    h.seedRevision("r1");
    expect(h.revision).toBe("r1");
    h.record(snap("a"), "r2");
    h.seedRevision("r3");
    expect(h.revision).toBe("r2");
  });

  it("treats a change during or just after its own write as its own", () => {
    const h = new EditHistory();
    expect(h.ownWriteLikely).toBe(false);
    h.writing(1);
    expect(h.ownWriteLikely).toBe(true);
    h.writing(-1);
    expect(h.ownWriteLikely).toBe(true);
  });
});
