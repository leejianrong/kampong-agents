import type { KeyboardEvent } from "react";

// The WAI-ARIA tabs pattern (KAM-277): Left and Right move to the previous and next tab, Home and End to the first
// and last, wrapping at the ends. The tab that has the focus is the selected one, so a roving tabindex keeps
// the Tab key to one stop per tablist.

export function nextTab<T extends string>(
  key: string,
  ids: readonly T[],
  current: T,
): T | undefined {
  const i = ids.indexOf(current);
  if (i < 0) return undefined;
  if (key === "ArrowRight") return ids[(i + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(i - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return undefined;
}

/** onKeyDown for a tablist: picks the tab the key names and moves the focus to its button. */
export function tabListKeys<T extends string>(
  ids: readonly T[],
  current: T,
  pick: (id: T) => void,
  buttonFor: (id: T) => HTMLElement | null,
) {
  return (event: KeyboardEvent) => {
    const next = nextTab(event.key, ids, current);
    if (next === undefined) return;
    event.preventDefault();
    pick(next);
    buttonFor(next)?.focus();
  };
}

/** The row an arrow key moves to in a list of rows (Up, Down, Home, End), or undefined for any other key. */
export function nextRow(key: string, count: number, index: number): number | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
