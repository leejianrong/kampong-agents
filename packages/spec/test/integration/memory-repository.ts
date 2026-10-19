import type { LayoutMap } from "../../src/layout.js";
import type { SpecOp } from "../../src/ops.js";
import {
  evaluateOps,
  evaluateReplace,
  persistLayoutMoves,
  type ApplyOpsResult,
  type SpecRepository,
  type SpecSummary,
} from "../../src/repository.js";
import type { PatchOp } from "../../src/mutate.js";

/**
 * A `SpecRepository` that keeps everything in memory, so the shared contract (and its operation
 * sequences) also run against the pure `applyOpsToSource` layer, with no disk or database. The
 * revision is a counter, like the hosted row's version.
 */
export class MemoryRepository implements SpecRepository {
  private layout: LayoutMap = {};
  private version = 1;

  constructor(private source: string) {}

  async readSource(): Promise<string> {
    return this.source;
  }

  async readLayout(): Promise<LayoutMap> {
    return this.layout;
  }

  async writeLayout(layout: LayoutMap): Promise<void> {
    this.layout = layout;
  }

  async list(): Promise<SpecSummary[]> {
    return [{ id: "memory", name: "memory" }];
  }

  async applyPatchAndSave(ops: PatchOp[]) {
    return this.applyOpsAndSave(ops);
  }

  async replaceSourceAndSave(
    source: string,
    options: { baseRevision?: string } = {},
  ): Promise<ApplyOpsResult> {
    const revision = String(this.version);
    const result = evaluateReplace({ source: this.source, revision }, source, options.baseRevision);
    if (!result.success) return "stale" in result ? { ...result } : { ...result, revision };
    if (result.source !== this.source) {
      this.source = result.source;
      this.version += 1;
    }
    return { ...result, revision: String(this.version) };
  }

  async applyOpsAndSave(
    ops: SpecOp[],
    options: { baseRevision?: string } = {},
  ): Promise<ApplyOpsResult> {
    const revision = String(this.version);
    const result = evaluateOps({ source: this.source, revision }, ops, options.baseRevision);
    if (!result.success) return "stale" in result ? { ...result } : { ...result, revision };
    if (result.source !== this.source) {
      this.source = result.source;
      this.version += 1;
    }
    await persistLayoutMoves(this, result.layoutMoves);
    return { ...result, revision: String(this.version) };
  }
}
