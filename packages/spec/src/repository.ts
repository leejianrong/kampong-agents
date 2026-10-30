import type { PatchOp } from "./mutate.js";
import {
  applyLayoutMoves,
  applyOpsToSource,
  type ApplyOpsToSourceResult,
  type LayoutMove,
  type OpChanges,
  type OpError,
  type SpecOp,
} from "./ops.js";
import { parseSpec, type SpecError } from "./parse.js";
import { specToGraph } from "./graph.js";
import { LAYOUT_MARK, layoutWithPins, type LayoutMap } from "./layout.js";

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

/**
 * What `applyOpsAndSave` returns. `revision` is an optimistic-concurrency token (hosted: the row's version;
 * local: a hash of the file text); it is not part of the spec. A stale `baseRevision` is `stale: true` with
 * the current revision.
 */
export type ApplyOpsResult =
  | {
      success: true;
      source: string;
      spec: unknown;
      revision: string;
      changes: OpChanges;
      layoutMoves: LayoutMove[];
    }
  | { success: false; errors: OpError[]; source: string; revision?: string; stale?: boolean };

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
   * The mutation entry point (ADR-0055): raw patch ops and the step/tool ops, applied in order and validated
   * once. `baseRevision`, when given, must equal the spec's current revision or nothing is written and the
   * result is `stale`. `applyPatchAndSave` is this with patch ops and no revision.
   */
  applyOpsAndSave(ops: SpecOp[], options?: { baseRevision?: string }): Promise<ApplyOpsResult>;

  /**
   * Import (ADR-0054): replaces the whole spec text with `source` if it validates, byte for byte, so the
   * author's comments and formatting are kept as given. An invalid source writes nothing and comes back as
   * errors with line numbers. Same `baseRevision` rule as `applyOpsAndSave`.
   */
  replaceSourceAndSave(
    source: string,
    options?: { baseRevision?: string },
  ): Promise<ApplyOpsResult>;

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
  const result = applyOpsToSource(source, ops);
  if (!result.success) return { success: false, errors: result.errors, source };
  return { success: true, source: result.source, spec: result.spec };
}

/** Renames and drops the layout keys an operation changed (ADR-0006), writing only if something moved. */
export async function persistLayoutMoves(
  repo: Pick<SpecRepository, "readLayout" | "writeLayout">,
  moves: readonly LayoutMove[],
): Promise<void> {
  if (moves.length === 0) return;
  const layout = await repo.readLayout();
  const next = applyLayoutMoves(layout, moves);
  if (JSON.stringify(next) !== JSON.stringify(layout)) await repo.writeLayout(next);
}

export type EvaluatedOps =
  | ApplyOpsToSourceResult
  | { success: false; stale: true; errors: OpError[]; source: string; revision: string };

/**
 * The pure core of `applyOpsAndSave`, shared by both repositories so they cannot differ (ADR-0054, ADR-0055):
 * checks `baseRevision` against the `revision` the caller just read, then applies and validates the ops.
 * The caller persists `source` (and the layout moves) only when this succeeds.
 */
export function evaluateOps(
  current: { source: string; revision: string },
  ops: SpecOp[],
  baseRevision?: string,
): EvaluatedOps {
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    return staleResult(current.source, current.revision);
  }
  return applyOpsToSource(current.source, ops);
}

/**
 * The pure core of `replaceSourceAndSave`: the `baseRevision` check, then the new text validated as a spec.
 * The text is kept exactly as given (nothing is re-serialised), so an import then an export is the same file.
 */
export function evaluateReplace(
  current: { source: string; revision: string },
  source: string,
  baseRevision?: string,
): EvaluatedOps {
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    return staleResult(current.source, current.revision);
  }
  const parsed = parseSpec(source);
  if (!parsed.success) {
    return { success: false, errors: parsed.errors, source: current.source };
  }
  return {
    success: true,
    source,
    spec: parsed.spec,
    changes: { renamed: [], removed: [], rewrote: 0 },
    layoutMoves: [],
  };
}

/** The refusal for a write made against an out-of-date revision. */
export function staleResult(
  source: string,
  revision: string,
): Extract<EvaluatedOps, { stale: true }> {
  return {
    success: false,
    stale: true,
    errors: [
      {
        code: "stale",
        path: [],
        message: "the spec changed since it was loaded: reload it and apply the change again",
      },
    ],
    source,
    revision,
  };
}

/**
 * Parses the current spec and lays its graph out left to right (ADR-0006, ADR-0059), persisting the result. Generic over any `SpecRepository` (this used to be a method on `SpecStore` alone) --
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
    const next = layoutWithPins(graph, layout);
    if (JSON.stringify(next) !== JSON.stringify(layout)) {
      await repo.writeLayout(next);
      layout = next;
    }
  }

  return { success: result.success, spec: result.spec, errors: result.errors, layout, source };
}

export type PinResult = { success: true; layout: LayoutMap } | { success: false; error: string };

/**
 * KAM-186 (ADR-0061): pins the given nodes where the person dragged them, or unpins a node whose position is
 * `null`. The one write path for both modes: `kampong dev` (`PUT /api/layout`) and hosted
 * (`PUT /api/specs/:id/layout`) call it over their own repository, so the stored shape cannot drift. Ids that
 * are not nodes of the current spec, the reserved `$layout` stamp and non-finite numbers are ignored. The
 * returned layout is the one `loadWithLayout` would now give.
 */
export async function pinNodePositions(
  repo: Pick<SpecRepository, "readSource" | "readLayout" | "writeLayout">,
  positions: Record<string, { x: number; y: number } | null>,
): Promise<PinResult> {
  const result = parseSpec(await repo.readSource());
  if (!result.success || !result.spec) {
    return { success: false, error: "The workflow has errors, so its layout was not changed." };
  }
  const graph = specToGraph(result.spec);
  const known = new Set(graph.nodes.map((n) => n.id));
  const stored = await repo.readLayout();
  const next: LayoutMap = { ...stored };
  for (const [id, at] of Object.entries(positions)) {
    if (id === LAYOUT_MARK || !known.has(id)) continue;
    if (at === null) {
      delete next[id];
    } else if (Number.isFinite(at.x) && Number.isFinite(at.y)) {
      next[id] = { x: Math.round(at.x), y: Math.round(at.y), pinned: true };
    }
  }
  const layout = layoutWithPins(graph, next);
  if (JSON.stringify(layout) !== JSON.stringify(stored)) await repo.writeLayout(layout);
  return { success: true, layout };
}
