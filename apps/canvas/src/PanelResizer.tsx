import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

// ADR-0063 / KAM-273: the run log's height is the person's to set. A drag handle along its top edge, which is also
// a separator the keyboard can move (Up and Down, Home and End), and the height is remembered between visits.

const KEY = "kampong.runlog.height";
export const MIN_HEIGHT = 120;
const STEP = 24;

/** The most the panel may take: most of the window, so the canvas is never squeezed to nothing. */
export const maxHeight = (viewport: number): number =>
  Math.max(MIN_HEIGHT, Math.round(viewport * 0.7));

export const clampHeight = (px: number, viewport: number): number =>
  Math.min(maxHeight(viewport), Math.max(MIN_HEIGHT, Math.round(px)));

function load(): number | undefined {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function save(px: number): void {
  try {
    window.localStorage.setItem(KEY, String(px));
  } catch {
    // Storage is blocked (private window): the height still holds for this visit.
  }
}

/** The height the person set, in px, or undefined while they have not set one (the stylesheet's default holds). */
export function useRunLogHeight() {
  const [height, setHeight] = useState<number | undefined>(() => load());
  const set = (px: number | undefined) => {
    setHeight(px);
    if (px !== undefined) save(px);
  };
  return [height, set] as const;
}

export function PanelResizer({
  height,
  onChange,
  measure,
}: {
  /** The height in px now, or undefined for the default. */
  height: number | undefined;
  onChange: (px: number) => void;
  /** The body's rendered height, for a first drag or key press before any height was set. */
  measure: () => number;
}) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const [live, setLive] = useState(false);
  const viewport = () => window.innerHeight;

  useEffect(() => {
    // A window that shrank under a saved height: keep the panel inside it.
    if (height !== undefined && height > maxHeight(viewport()))
      onChange(clampHeight(height, viewport()));
  }, [height, onChange]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: height ?? measure() };
    setLive(true);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // Dragging up (a smaller clientY) makes the panel taller.
    onChange(
      clampHeight(drag.current.startHeight + (drag.current.startY - event.clientY), viewport()),
    );
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setLive(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const now = height ?? measure();
    const next =
      event.key === "ArrowUp"
        ? now + STEP
        : event.key === "ArrowDown"
          ? now - STEP
          : event.key === "Home"
            ? MIN_HEIGHT
            : event.key === "End"
              ? maxHeight(viewport())
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(clampHeight(next, viewport()));
  }

  const now = height ?? measure();
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the run log"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maxHeight(viewport())}
      aria-valuenow={now}
      tabIndex={0}
      className={`md3-runlog__resizer${live ? " md3-runlog__resizer--live" : ""}`}
      data-testid="run-log-resizer"
      title="Drag to resize, or use the Up and Down keys"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
