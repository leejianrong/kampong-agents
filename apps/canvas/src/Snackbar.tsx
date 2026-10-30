// KAM-181: the confirmation after a save. An M3 snackbar: a short line at the bottom that goes away on its own.
// The live region is always in the page and only its text changes, which is what makes a screen reader announce it
// (a region added together with its text is often missed). It is polite: it never interrupts what is being read.
// KAM-183: an optional action (Undo after a save, Redo after an undo) is an M3 snackbar's text button.

export interface SnackbarAction {
  label: string;
  onClick: () => void;
  /** The pointer or keyboard focus is on the link: the caller keeps the toast up until it leaves. */
  onHold?: (held: boolean) => void;
}

export function Snackbar({ message, action }: { message: string | null; action?: SnackbarAction }) {
  return (
    <div className="md3-snackbar-host">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="save-toast">
        {message !== null && (
          <p className="md3-snackbar md3-body-medium">
            <span>{message}</span>
            {action && (
              <button
                type="button"
                className="md3-snackbar__action md3-label-large"
                data-testid="toast-action"
                onClick={action.onClick}
                onMouseEnter={() => action.onHold?.(true)}
                onMouseLeave={() => action.onHold?.(false)}
                onFocus={() => action.onHold?.(true)}
                onBlur={() => action.onHold?.(false)}
              >
                {action.label}
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
