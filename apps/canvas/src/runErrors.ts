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

/** An item as one short line of table text. */
export function describeItem(item: unknown): string {
  if (item === undefined) return "";
  return typeof item === "string" ? item : JSON.stringify(item);
}
