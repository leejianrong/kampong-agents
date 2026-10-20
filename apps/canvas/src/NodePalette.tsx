import { useEffect, useRef, useState } from "react";
import { StepPicker } from "./StepPicker.js";
import type { StepKind } from "./stepKinds.js";

// The left rail of step kinds (KAM-213): search, then pick a kind to add it at the end of the workflow (the form
// that opens has the Position chooser). `/` focuses the search from anywhere that is not a text field. On a
// narrow window the rail starts collapsed to a button and opens over the canvas, so it never causes a sideways
// scroll or squeezes the graph.

export interface NodePaletteProps {
  version?: string;
  onChoose: (kind: StepKind) => void;
  /** Opens the Add Tool form: a tool is not a step, so it has its own button under the step list. */
  onAddTool?: () => void;
}

const NARROW = 1100;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function NodePalette({ version, onChoose, onAddTool }: NodePaletteProps) {
  const [open, setOpen] = useState(() => window.innerWidth >= NARROW);
  const search = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusSearch = useRef(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      focusSearch.current = true;
      if (open) search.current?.focus();
      else setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open && focusSearch.current) {
      focusSearch.current = false;
      search.current?.focus();
    }
  }, [open]);

  if (!open) {
    return (
      <div className="md3-palette md3-palette--collapsed">
        <button
          ref={toggle}
          type="button"
          className="md3-button md3-button-tonal md3-palette__open"
          aria-expanded={false}
          aria-controls="step-palette"
          aria-keyshortcuts="/"
          title="Show the step palette (/)"
          onClick={() => setOpen(true)}
        >
          Steps
        </button>
      </div>
    );
  }

  return (
    <aside
      id="step-palette"
      className="md3-palette"
      aria-label="Step palette"
      data-testid="step-palette"
    >
      <div className="md3-palette__header">
        <span className="md3-title-small">Add a step</span>
        <button
          type="button"
          className="md3-button md3-button-text"
          aria-expanded
          aria-controls="step-palette"
          onClick={() => {
            setOpen(false);
            // The rail is gone; keep keyboard focus on the canvas side.
            requestAnimationFrame(() => toggle.current?.focus());
          }}
        >
          Hide
        </button>
      </div>
      <StepPicker
        ref={search}
        version={version}
        label="Search steps"
        onChoose={onChoose}
        onEscape={() => search.current?.blur()}
      />
      {onAddTool && (
        <button
          type="button"
          className="md3-button md3-button-tonal md3-palette__tool"
          onClick={onAddTool}
        >
          + Tool
        </button>
      )}
      <p className="md3-body-small md3-field__hint">
        A step is added at the end of the workflow; you choose its place on the next screen. To add
        one between two steps, use the + on the line between them.
      </p>
    </aside>
  );
}
