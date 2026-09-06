import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
// requires, since the Postgres-backed implementation is inherently async) --
// implemented here via `node:fs/promises` rather than the old sync calls
// wrapped in `Promise.resolve()`, so a real ENOENT/EACCES still surfaces as
// the same `NodeJS.ErrnoException` shape `server.ts`'s error-translation
// logic already depends on (`err.code === "ENOENT"`), not a different one.

export type { ApplyPatchResult, LoadResult };

export class SpecStore implements SpecRepository {
  constructor(
    private readonly specPath: string,
    private readonly layoutPath: string,
  ) {}

  async readSource(): Promise<string> {
    return readFile(this.specPath, "utf8");
  }

  async readLayout(): Promise<LayoutMap> {
    if (!existsSync(this.layoutPath)) return {};
    return parseLayout(await readFile(this.layoutPath, "utf8"));
  }

  async writeLayout(layout: LayoutMap): Promise<void> {
    // ADR-0006's convention is a nested sidecar (`.kampong/layout.json`),
    // whose parent directory won't exist yet the first time a brand-new
    // spec directory is opened (e.g. `kampong dev`'s default layout path) --
    // create it rather than let a first-run `kampong dev` 500 on this.
    await mkdir(dirname(this.layoutPath), { recursive: true });
    await writeFile(this.layoutPath, serializeLayout(layout));
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
      entries = await readdir(dir);
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
    await writeFile(this.specPath, result.source);
    return result;
  }
}
