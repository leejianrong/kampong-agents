import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  applyPatch,
  parseLayout,
  parseSpec,
  serializeLayout,
  specToGraph,
  toYamlString,
  withAutoLayout,
  type LayoutMap,
  type PatchOp,
  type SpecError,
} from "@kampong/spec";

// Wraps the two files a spec travels with (the YAML itself + its sidecar
// layout, ADR-0006) behind the single write path PLAN.md's Shape S1
// requires: every mutation is parsed and validated before anything else
// reads it, and an invalid mutation never reaches disk.

export interface LoadResult {
  success: boolean;
  spec?: unknown;
  errors: SpecError[];
  layout: LayoutMap;
  source: string;
}

export type ApplyPatchResult =
  | { success: true; source: string; spec: unknown }
  | { success: false; errors: SpecError[]; source: string };

export class SpecStore {
  constructor(
    private readonly specPath: string,
    private readonly layoutPath: string,
  ) {}

  readSource(): string {
    return readFileSync(this.specPath, "utf8");
  }

  readLayout(): LayoutMap {
    if (!existsSync(this.layoutPath)) return {};
    return parseLayout(readFileSync(this.layoutPath, "utf8"));
  }

  writeLayout(layout: LayoutMap): void {
    writeFileSync(this.layoutPath, serializeLayout(layout));
  }

  /** Parses the current spec, auto-assigning + persisting layout for any node missing one (ADR-0006). */
  loadWithLayout(): LoadResult {
    const source = this.readSource();
    const result = parseSpec(source);
    let layout = this.readLayout();

    if (result.success && result.spec) {
      const graph = specToGraph(result.spec);
      const next = withAutoLayout(
        layout,
        graph.nodes.map((n) => ({ id: n.id, column: n.column })),
      );
      if (JSON.stringify(next) !== JSON.stringify(layout)) {
        this.writeLayout(next);
        layout = next;
      }
    }

    return { success: result.success, spec: result.spec, errors: result.errors, layout, source };
  }

  /** Validates a patch against a fresh parse before writing; an invalid mutation never touches disk. */
  applyPatchAndSave(ops: PatchOp[]): ApplyPatchResult {
    const source = this.readSource();
    const { doc } = parseSpec(source);
    applyPatch(doc, ops);
    const nextSource = toYamlString(doc);
    const result = parseSpec(nextSource);

    if (!result.success) {
      return { success: false, errors: result.errors, source };
    }
    writeFileSync(this.specPath, nextSource);
    return { success: true, source: nextSource, spec: result.spec };
  }
}
