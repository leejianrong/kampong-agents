// The read-only YAML viewer, shown in the "For developers" drawer (KAM-202; PLAN.md Affordances). Deliberately a
// light, honest viewer, not a competing IDE -- Cursor/Claude Code/Codex are
// where real editing happens (ADR-0008). The YAML is the interchange format (ADR-0054), so its header
// carries the two quiet actions for taking a spec out and bringing one in (KAM-207).

import { useEffect, useMemo, useRef } from "react";
import type { LineRange } from "./yamlSourceMap.js";

export interface YamlPreviewProps {
  source: string;
  /** The lines of the selected node (KAM-210): marked, and scrolled into view when they are off screen. */
  highlight?: LineRange | null;
  /** A click on a line (1-based). The caller decides what that selects. */
  onLineClick?: (line: number) => void;
  /** Saves the spec as a YAML file. Omitted: no Download button. */
  onDownload?: () => void;
  /** Opens the import panel. Omitted: no Import button. */
  onImport?: () => void;
}

export function YamlPreview({
  source,
  highlight,
  onLineClick,
  onDownload,
  onImport,
}: YamlPreviewProps) {
  const body = useRef<HTMLPreElement>(null);
  // One block per line, each carrying its own newline, so the text is exactly the source (copy and paste work).
  const lines = useMemo(() => {
    const parts = source.split("\n");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    return parts.map((text, i) =>
      i < parts.length - 1 || source.endsWith("\n") ? `${text}\n` : text,
    );
  }, [source]);

  // Bring the marked lines into view, unless they already are (a click in the drawer should not make it jump).
  const start = highlight?.start;
  const end = highlight?.end;
  useEffect(() => {
    const pre = body.current;
    if (!pre || start === undefined || end === undefined) return;
    const reveal = () => {
      const first = pre.querySelector<HTMLElement>(`[data-line="${start}"]`);
      const last = pre.querySelector<HTMLElement>(`[data-line="${end}"]`) ?? first;
      if (!first || !last || pre.clientHeight === 0) return;
      const top = first.offsetTop;
      const bottom = last.offsetTop + last.offsetHeight;
      if (top >= pre.scrollTop && bottom <= pre.scrollTop + pre.clientHeight) return;
      pre.scrollTop = Math.max(0, top - pre.clientHeight / 4);
    };
    reveal();
    // The drawer shares its pane with the inspector, which settles after this render: look again when it resizes.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(pre);
    return () => observer.disconnect();
  }, [start, end, source]);

  const handleClick = (event: React.MouseEvent) => {
    if (!onLineClick) return;
    // Selecting text to copy it is not a request to move the selection.
    if (window.getSelection()?.toString()) return;
    const line = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (line) onLineClick(Number(line.dataset.line));
  };

  return (
    <aside className="md3-yaml-panel" aria-label="For developers">
      <div className="md3-yaml-panel__header">
        <span className="md3-title-small">For developers: YAML</span>
        {(onDownload || onImport) && (
          <span className="md3-yaml-panel__actions">
            {onDownload && (
              <button type="button" className="md3-button md3-button-text" onClick={onDownload}>
                Download as file
              </button>
            )}
            {onImport && (
              <button type="button" className="md3-button md3-button-text" onClick={onImport}>
                Import from file
              </button>
            )}
          </span>
        )}
      </div>
      {/* Focusable so the keyboard can scroll it (axe: scrollable-region-focusable). */}
      <pre
        ref={body}
        data-testid="yaml-preview"
        className="md3-yaml-panel__body"
        tabIndex={0}
        role="region"
        aria-label="Spec as YAML (read only)"
        onClick={handleClick}
      >
        {lines.map((text, i) => {
          const n = i + 1;
          const marked = start !== undefined && end !== undefined && n >= start && n <= end;
          return (
            <span
              key={n}
              data-line={n}
              className={marked ? "md3-yaml-line md3-yaml-line--selected" : "md3-yaml-line"}
              {...(marked && { "aria-current": "true" as const })}
            >
              {text}
            </span>
          );
        })}
      </pre>
    </aside>
  );
}
