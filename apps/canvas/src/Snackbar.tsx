// KAM-181: the confirmation after a save. An M3 snackbar: a short line at the bottom that goes away on its own.
// The live region is always in the page and only its text changes, which is what makes a screen reader announce it
// (a region added together with its text is often missed). It is polite: it never interrupts what is being read.

export function Snackbar({ message }: { message: string | null }) {
  return (
    <div className="md3-snackbar-host">
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="save-toast">
        {message !== null && <p className="md3-snackbar md3-body-medium">{message}</p>}
      </div>
    </div>
  );
}
