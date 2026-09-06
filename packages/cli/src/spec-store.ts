import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import {
  applyPatchToSource,
  loadWithLayout as loadWithLayoutShared,
  parseLayout,
  serializeLayout,
  type ApplyPatchResult,
  type LayoutMap,
  type LoadResult,
  type PatchOp,
  type SpecRepository,
  type SpecSummary,
} from "@kampong/spec";

// Filesystem-backed `SpecRepository` (KAN-1224, ADR-0014, ADR-0005): wraps
// the two files a spec travels with (the YAML itself + its sidecar layout,
// ADR-0006) behind the single write path PLAN.md's Shape S1 requires --
// every mutation is parsed and validated before anything else reads it, and
// an invalid mutation never reaches disk. Before this card this class talked
// to `readFileSync`/`writeFileSync` directly with no interface between it and
// its callers (ADR-0014's "what exists today" -- the gap this card pays
// down); it now implements `SpecRepository` so `packages/server`'s
// Postgres-backed implementation can stand in for it without either package
// depending on the other. Kept the name `SpecStore` -- reads naturally as
// "the filesystem-backed `SpecRepository`" and every call site already
// spells it that way.
//
// Interface methods are `Promise`-returning (the shape `SpecRepository`
// requires, since the Postgres-backed implementation is inherently async),
// but every method's BODY still uses the original synchronous `node:fs`
// calls (wrapped in an `async` function, which returns an already-resolved
// Promise without ever yielding to the libuv threadpool) rather than
// `node:fs/promises`. This is a deliberate correction, not an oversight: an
// earlier version of this class used `node:fs/promises` throughout, and that
// genuinely-async I/O measurably reintroduced a real, reproducible flake in
// apps/canvas/test/integration/live-server.test.tsx ("adding a tool through
// the canvas really mutates the file on disk...") -- roughly 30-40% of runs
// hung in that test's `afterEach` on `await app.close()` until the vitest
// hookTimeout. A/B testing confirmed the pre-refactor `main` (synchronous fs)
// passed 5/5 with no flake, `fs/promises` failed ~2-3/5, and reverting this
// class's internals to synchronous fs (unchanged Promise-returning surface)
// passed 10/10. The exact mechanism wasn't chased further than that (a likely
// candidate: shifting real event-loop/threadpool timing changes when a
// `/api/events` SSE connection's teardown lands relative to `app.close()`'s
// own connection-draining wait, given server.ts's SSE route (`/api/events`)
// keeps a raw hijacked connection open) -- what matters operationally is that
// this class must keep its one-spec-per-process, single-synchronous-tick
// read/write behavior (`kampong dev`'s original guarantee) rather than
// introducing genuine async I/O latency here, since nothing about this
// card's actual requirement (a `Promise`-returning interface so the
// Postgres-backed implementation can share it) needed real async I/O on the
// filesystem side. A real ENOENT/EACCES still surfaces as the same
// `NodeJS.ErrnoException` shape `server.ts`'s error-translation logic
// depends on (`err.code === "ENOENT"`) either way, sync or async.

export type { ApplyPatchResult, LoadResult };

export class SpecStore implements SpecRepository {
  constructor(
    private readonly specPath: string,
    private readonly layoutPath: string,
  ) {}

  async readSource(): Promise<string> {
    return readFileSync(this.specPath, "utf8");
  }

  async readLayout(): Promise<LayoutMap> {
    if (!existsSync(this.layoutPath)) return {};
    return parseLayout(readFileSync(this.layoutPath, "utf8"));
  }

  async writeLayout(layout: LayoutMap): Promise<void> {
    mkdirSync(dirname(this.layoutPath), { recursive: true });
    writeFileSync(this.layoutPath, serializeLayout(layout));
  }

  /**
   * Enumerates `*.yaml`/`*.yml` files sitting alongside the current spec, as a best-effort
   * discovery aid -- see `SpecRepository.list()`'s docstring for why this doesn't make
   * `kampong dev` itself multi-spec-aware (ADR-0011, out of scope for this card). A directory
   * that doesn't exist (or isn't readable) yields an empty list rather than throwing -- `list()`
   * is advisory, not a primary read path any existing route depends on.
   */
  async list(): Promise<SpecSummary[]> {
    const dir = dirname(this.specPath);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
      .sort()
      .map((name) => ({ id: name, name: basename(name, extname(name)) }));
  }

  /** Parses the current spec, auto-assigning + persisting layout for any node missing one (ADR-0006). */
  async loadWithLayout(): Promise<LoadResult> {
    return loadWithLayoutShared(this);
  }

  /** Validates a patch against a fresh parse before writing; an invalid mutation never touches disk. */
  async applyPatchAndSave(ops: PatchOp[]): Promise<ApplyPatchResult> {
    const source = await this.readSource();
    const result = applyPatchToSource(source, ops);
    if (!result.success) {
      return result;
    }
    writeFileSync(this.specPath, result.source);
    return result;
  }
}
