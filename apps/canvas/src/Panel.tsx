import type { ReactNode } from "react";

// The one container every tool panel docks in (KAM-177): a fixed header with the title and a Close action, and a
// body that scrolls on its own. Panels sit in the side pane above the YAML view, never over the canvas, so no node
// is covered and the Save and Cancel row, which sticks to the bottom of the body, is always reachable however tall
// the form is. KAM-178: the rest of a panel's chrome lives here too. A panel puts its Save and Cancel row in a
// PanelFooter and its failures in a PanelError, and draws neither itself, so every panel looks and behaves alike.

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

export interface PanelErrorProps {
  /** One entry per problem; an empty list renders nothing. */
  messages: ReactNode[];
  /** A sentence above the list, for a failure that needs context. */
  intro?: ReactNode;
  testId?: string;
}

/** The one error box: an alert in the error container colours. */
export function PanelError({ messages, intro, testId }: PanelErrorProps) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="md3-panel__error" data-testid={testId}>
      {intro !== undefined && <p className="md3-body-small md3-panel__error-intro">{intro}</p>}
      <ul className="md3-panel__error-list">
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export interface PanelFooterProps {
  /** The primary action. Omit for a footer of custom actions in `children`. */
  save?: string;
  /** A submit button when inside a form, otherwise `onSave` makes it a plain button. */
  onSave?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
  cancelLabel?: string;
  children?: ReactNode;
}

/** The one footer: the primary action then Cancel, pinned to the bottom of the panel body. */
export function PanelFooter({
  save,
  onSave,
  disabled,
  autoFocus,
  onCancel,
  cancelLabel = "Cancel",
  children,
}: PanelFooterProps) {
  return (
    <div className="md3-panel__footer">
      {save !== undefined && (
        <button
          type={onSave ? "button" : "submit"}
          className="md3-button md3-button-filled"
          disabled={disabled}
          autoFocus={autoFocus}
          onClick={onSave}
        >
          {save}
        </button>
      )}
      {children}
      {onCancel && (
        <button type="button" className="md3-button md3-button-text" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
    </div>
  );
}
