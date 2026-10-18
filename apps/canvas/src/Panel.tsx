import type { ReactNode } from "react";

// The one container every tool panel docks in (KAM-177): a fixed header with the title and a Close action, and a
// body that scrolls on its own. Panels sit in the side pane above the YAML view, never over the canvas, so no node
// is covered and the Save and Cancel row, which sticks to the bottom of the body, is always reachable however tall
// the form is. Each panel used to draw its own title and decide where to float; KAM-178 moves the rest of their
// chrome (footer, error) into this component.

export interface PanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Panel({ title, onClose, children }: PanelProps) {
  return (
    <section className="md3-panel" aria-label={title}>
      <header className="md3-panel__header">
        <h2 className="md3-title-medium md3-panel__title">{title}</h2>
        <button
          type="button"
          className="md3-button md3-button-text"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div className="md3-panel__body">{children}</div>
    </section>
  );
}
