// Items a run carried on past a failure (KAM-189). A `foreach` with `on_error: continue` finishes the run as
// "completed" and lists each failed item under `<step>.errors` in its output; this reads those back out so the
// Test Run panel can say "completed with errors" instead of showing a clean green result.

export interface FailedItem {
  /** The foreach step the item belonged to. */
  loop: string;
  index: number;
  /** The nested step that failed. */
  step: string;
  message: string;
  /** The item itself, shown to tell failures apart (a symbol, an id). */
  item: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every failed foreach item in a completed run's output, in step then item order. */
export function failedItems(finalOutput: Record<string, unknown> | undefined): FailedItem[] {
  const found: FailedItem[] = [];
  for (const [loop, output] of Object.entries(finalOutput ?? {})) {
    // A foreach output is the only step output with both lists.
    if (
      !isRecord(output) ||
      !Array.isArray(output["results"]) ||
      !Array.isArray(output["errors"])
    ) {
      continue;
    }
    for (const entry of output["errors"]) {
      if (!isRecord(entry)) continue;
      found.push({
        loop,
        index: typeof entry["index"] === "number" ? entry["index"] : found.length,
        step: typeof entry["step"] === "string" ? entry["step"] : "",
        message: typeof entry["message"] === "string" ? entry["message"] : String(entry["message"]),
        item: entry["item"],
      });
    }
  }
  return found;
}

/**
 * How many items a loop's own output says failed when NONE of them worked (no results, at least one error), else
 * undefined. A loop that carried on past every item reads as finished, though nothing it did came of it (KAM-297).
 */
export function loopAllFailed(output: unknown): number | undefined {
  if (!isRecord(output) || !Array.isArray(output["results"]) || !Array.isArray(output["errors"])) {
    return undefined;
  }
  return output["results"].length === 0 && output["errors"].length > 0
    ? output["errors"].length
    : undefined;
}

/** True when a run's loops had failed items and not one item worked, in any loop. */
export function nothingWorked(finalOutput: Record<string, unknown> | undefined): boolean {
  let failed = 0;
  let worked = 0;
  for (const output of Object.values(finalOutput ?? {})) {
    if (
      !isRecord(output) ||
      !Array.isArray(output["results"]) ||
      !Array.isArray(output["errors"])
    ) {
      continue;
    }
    failed += output["errors"].length;
    worked += output["results"].length;
  }
  return failed > 0 && worked === 0;
}

/** An item as one short line of table text. */
export function describeItem(item: unknown): string {
  if (item === undefined) return "";
  return typeof item === "string" ? item : JSON.stringify(item);
}
