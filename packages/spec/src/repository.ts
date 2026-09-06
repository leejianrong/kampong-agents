import { applyPatch, type PatchOp } from "./mutate.js";
import { parseSpec, type SpecError } from "./parse.js";
import { specToGraph } from "./graph.js";
import { withAutoLayout, type LayoutMap } from "./layout.js";

// KAN-1224 (ADR-0014's `SpecRepository` decision, ADR-0005's original "local-
// mode-specific code is isolated behind an interface the hosted backend
// implements differently later" promise finally paid down): the shared seam
// both `packages/cli` (filesystem-backed, unchanged behavior) and
// `packages/server` (Postgres-backed, new) implement, so neither needs to
// depend on the other -- packages/spec is the one dependency both already
// have. Lives here rather than in either consumer package for exactly that
// reason.
//
// Deliberately modeled on what `SpecStore` (packages/cli/src/spec-store.ts)
// already did before this card, not invented from scratch: a repository
// instance is scoped to ONE spec (+ its one layout sidecar) at construction
// time -- `packages/cli` is a one-spec-per-process tool today (ADR-0011) and
// this card does not change that; the Postgres-backed implementation mirrors
// the same "constructed already pointed at a specific spec row" shape rather
// than threading a spec id through every call. `list()` is the one
// genuinely new capability (ADR-0014) and is honestly documented below as
// meaning something different in each implementation.

/** A minimal (id, name) pair for whatever specs a `list()` call can see. */
export interface SpecSummary {
  id: string;
  name: string;
}

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

export interface SpecRepository {
  /** Reads the current spec's raw YAML source text. */
  readSource(): Promise<string>;

  /** Reads the current spec's layout sidecar (ADR-0006), or `{}` if none has been written yet. */
  readLayout(): Promise<LayoutMap>;

  /** Persists a layout map for the current spec. */
  writeLayout(layout: LayoutMap): Promise<void>;

  /**
   * Validates `ops` against a fresh parse of the current spec before persisting anything --
   * an invalid mutation never reaches storage (PLAN.md Shape S1: "every mutation is parsed
   * and validated before anything else reads it").
   */
  applyPatchAndSave(ops: PatchOp[]): Promise<ApplyPatchResult>;

  /**
   * Lists the specs visible in this repository's configured scope.
   *
   * This means genuinely different things per implementation, on purpose:
   * - The filesystem-backed implementation (`packages/cli`) is constructed scoped to a single
   *   spec/layout path pair, because `kampong dev`/`kampong run` are one-spec-per-process tools
   *   (ADR-0011) -- this card does not change that. Its `list()` is a best-effort discovery aid
   *   that enumerates `*.yaml`/`*.yml` files sitting in that spec's directory; it does NOT make
   *   `kampong dev` itself multi-spec-aware.
   * - The Postgres-backed implementation (`packages/server`) is genuinely workspace-scoped: its
   *   `list()` returns every spec row belonging to the workspace it was constructed against,
   *   independent of which single spec it's otherwise reading/writing.
   */
  list(): Promise<SpecSummary[]>;
}

/**
 * Pure validated-mutation helper shared by every `SpecRepository` implementation's
 * `applyPatchAndSave`: parses `source`, applies `ops` to the parsed YAML document, re-validates
 * the result, and returns either the new source text (not yet persisted -- the caller decides
 * how) or the validation failure. Factored out here specifically so the filesystem- and
 * Postgres-backed implementations can't drift on what counts as "valid" -- one implementation of
 * the parse/patch/re-validate sequence, reused by both, rather than two copies that happen to
 * compile against the same interface but could quietly diverge in behavior.
 */
export function applyPatchToSource(source: string, ops: PatchOp[]): ApplyPatchResult {
  const { doc } = parseSpec(source);
  applyPatch(doc, ops);
  const nextSource = doc.toString({ flowCollectionPadding: false });
  const result = parseSpec(nextSource);

  if (!result.success) {
    return { success: false, errors: result.errors, source };
  }
  return { success: true, source: nextSource, spec: result.spec };
}

/**
 * Parses the current spec, auto-assigning + persisting layout for any node missing one
 * (ADR-0006). Generic over any `SpecRepository` (this used to be a method on `SpecStore` alone) --
 * both the filesystem- and Postgres-backed implementations get this behavior for free rather than
 * reimplementing the same parse-graph-autolayout orchestration on top of their own I/O.
 */
export async function loadWithLayout(
  repo: Pick<SpecRepository, "readSource" | "readLayout" | "writeLayout">,
): Promise<LoadResult> {
  const source = await repo.readSource();
  const result = parseSpec(source);
  let layout = await repo.readLayout();

  if (result.success && result.spec) {
    const graph = specToGraph(result.spec);
    const next = withAutoLayout(
      layout,
      graph.nodes.map((n) => ({ id: n.id, column: n.column })),
    );
    if (JSON.stringify(next) !== JSON.stringify(layout)) {
      await repo.writeLayout(next);
      layout = next;
    }
  }

  return { success: result.success, spec: result.spec, errors: result.errors, layout, source };
}
