import type { ReactNode } from "react";

// KAM-196: what the canvas shows instead of an error when there is nothing to draw yet.
//   "new"   : no spec file (or an empty one). Choose a template or start blank; the file is created then.
//   "steps" : the spec exists but its workflow has no steps. Add the first one.

export interface EmptyStateProps {
  kind: "new" | "steps";
  busy?: boolean;
  /** Why "Start blank" did not work, if it did not. */
  error?: string | null;
  onStartBlank: () => void;
  onAddStep: () => void;
  /**
   * The slot for the template gallery (KAM-216). It renders under "Start from a template"; until the gallery
   * exists nothing is passed and that section is left out.
   */
  templates?: ReactNode;
}

export function EmptyState({
  kind,
  busy = false,
  error,
  onStartBlank,
  onAddStep,
  templates,
}: EmptyStateProps) {
  return (
    <div className="md3-empty-state" data-testid="empty-state" data-kind={kind}>
      <div className="md3-empty-state__card md3-stack">
        {kind === "new" ? (
          <>
            <h2 className="md3-title-large">Start a new workflow</h2>
            <p className="md3-body-medium">
              Nothing is saved yet. Start with a blank workflow and add steps as you go; it is saved
              the first time you choose.
            </p>
            <div className="md3-form-actions">
              <button
                type="button"
                className="md3-button md3-button-filled"
                disabled={busy}
                onClick={onStartBlank}
                data-testid="start-blank"
              >
                Start blank
              </button>
            </div>
            {error && (
              <div
                role="alert"
                data-testid="empty-state-error"
                className="md3-banner md3-banner--error"
              >
                {error}
              </div>
            )}
            {templates && (
              <section data-testid="empty-state-templates" aria-label="Start from a template">
                <h3 className="md3-title-small">Start from a template</h3>
                {templates}
              </section>
            )}
          </>
        ) : (
          <>
            <h2 className="md3-title-large">This workflow has no steps yet</h2>
            <p className="md3-body-medium">
              A workflow runs its steps in order. Add the first one to see it here and try it out.
            </p>
            <div className="md3-form-actions">
              <button
                type="button"
                className="md3-button md3-button-filled"
                onClick={onAddStep}
                data-testid="empty-add-step"
              >
                Add step
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
