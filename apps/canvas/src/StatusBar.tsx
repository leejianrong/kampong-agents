import type { ActionDescriptor } from "./actions.js";

// The status bar (KAM-214): what the workflow is set up with and whether it is ready, each a button that opens
// its panel. Vars, Secrets (with a count of the ones the workflow reads that have no value), Guardrails, Checks
// and Trigger. A strip along the bottom of the window; it wraps rather than overlapping at a narrow width.

export function StatusBar({ actions }: { actions: ActionDescriptor[] }) {
  const items = actions.filter((a) => a.surface === "status");
  if (items.length === 0) return null;
  return (
    <footer className="md3-statusbar" aria-label="Workflow settings">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="md3-statusbar__item"
          aria-pressed={item.pressed}
          // The name starts with the words on the button, as WCAG 2.5.3 wants, then says what the count means.
          aria-label={item.badge ? `${item.label} ${item.badge.words}` : undefined}
          data-testid={`status-${item.id}`}
          onClick={item.run}
        >
          {item.label}
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
    </footer>
  );
}
