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
  /** KAM-181: the lines a save just changed: marked for a few seconds and scrolled into view. `nonce` makes a repeat count. */
  changed?: { range: LineRange; nonce: number } | null;
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
  changed,
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

  // Bring a range of lines into view, unless they already are (a click in the drawer should not make it jump).
  const reveal = (from: number, to: number) => {
    const pre = body.current;
    if (!pre) return;
    const first = pre.querySelector<HTMLElement>(`[data-line="${from}"]`);
    const last = pre.querySelector<HTMLElement>(`[data-line="${to}"]`) ?? first;
    if (!first || !last || pre.clientHeight === 0) return;
    const top = first.offsetTop;
    const bottom = last.offsetTop + last.offsetHeight;
    if (top >= pre.scrollTop && bottom <= pre.scrollTop + pre.clientHeight) return;
    pre.scrollTop = Math.max(0, top - pre.clientHeight / 4);
  };
  const watchAndReveal = (from: number, to: number) => {
    const pre = body.current;
    if (!pre) return;
    reveal(from, to);
    // The drawer shares its pane with the inspector, which settles after this render: look again when it resizes.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => reveal(from, to));
    observer.observe(pre);
    return () => observer.disconnect();
  };

  const start = highlight?.start;
  const end = highlight?.end;
  useEffect(() => {
    if (start === undefined || end === undefined) return;
    return watchAndReveal(start, end);
  }, [start, end, source]);

  // After a save the changed lines win over the selection: that is what the user is looking for.
  const changedStart = changed?.range.start;
  const changedEnd = changed?.range.end;
  const changedNonce = changed?.nonce;
  useEffect(() => {
    if (changedStart === undefined || changedEnd === undefined) return;
    return watchAndReveal(changedStart, changedEnd);
  }, [changedNonce, changedStart, changedEnd]);

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
          const flashed =
            changedStart !== undefined &&
            changedEnd !== undefined &&
            n >= changedStart &&
            n <= changedEnd;
          const className = [
            "md3-yaml-line",
            marked && "md3-yaml-line--selected",
            flashed && "md3-yaml-line--changed",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <span
              key={flashed ? `${n}:${changedNonce}` : n}
              data-line={n}
              className={className}
              {...(flashed && { "data-changed": "true" })}
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
