import type { ActionDescriptor } from "./actions.js";

// The status bar (KAM-214): what the workflow is set up with and whether it is ready, each a button that opens
// its panel. Vars, Secrets (with a count of the ones the workflow reads that have no value), Guardrails, Checks
// and Trigger. A strip along the bottom of the window; it wraps rather than overlapping at a narrow width.

export function StatusBar({
  actions,
  note,
}: {
  actions: ActionDescriptor[];
  /** What the next run will do, in a few words: shown at the right end. */
  note?: string | undefined;
}) {
  const items = actions.filter((a) => a.surface === "status");
  if (items.length === 0) return null;
  return (
    <footer className="md3-statusbar" aria-label="Workflow settings">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`md3-statusbar__item${item.tone ? ` md3-statusbar__item--${item.tone}` : ""}`}
          aria-pressed={item.pressed}
          // The name starts with the words on the button, as WCAG 2.5.3 wants, then says what the count means.
          aria-label={item.badge ? `${item.label} ${item.badge.words}` : undefined}
          data-testid={`status-${item.id}`}
          onClick={item.run}
        >
          {item.label}
          {item.detail && (
            <span className="md3-statusbar__detail" title={item.detail}>
              {" "}
              {item.detail}
            </span>
          )}
          {item.badge && (
            <>
              {/* A space, so the words on the button read "Secrets 4" and the name "Secrets 4 missing" contains them. */}{" "}
              <span className="md3-statusbar__badge" aria-hidden="true">
                {item.badge.count}
              </span>
            </>
          )}
        </button>
      ))}
      {note && (
        <span className="md3-statusbar__note" data-testid="status-note">
          {note}
        </span>
      )}
    </footer>
  );
}
