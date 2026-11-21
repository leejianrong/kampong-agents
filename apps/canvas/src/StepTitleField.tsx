import { useState } from "react";

// KAM-290: a step's plain-words title, edited from the inspector. It is shown first on the step's card and in the
// run log; the step's id stays what other steps read. Saved when the field is left or Enter is pressed, and a blank
// one takes the title off.

export const MAX_TITLE = 80;

export function StepTitleField({
  stepId,
  initial,
  onSave,
}: {
  stepId: string;
  initial: string;
  /** Saves the title ("" removes it). Resolves false when the save failed. */
  onSave: (title: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const next = value.trim();
    if (busy || next === saved) return;
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    if (ok) {
      setSaved(next);
      setValue(next);
    } else {
      setValue(saved);
    }
  }

  return (
    <label className="md3-field md3-step-title" data-testid="step-title-field">
      <span className="md3-body-small md3-field__label">Title (optional)</span>
      <input
        className="md3-text-field"
        value={value}
        maxLength={MAX_TITLE}
        disabled={busy}
        placeholder="A few plain words for the card, such as Look up the order"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
      />
      <span className="md3-body-small md3-field__hint">
        Shown first on the card and in the run log. The step's id stays "{stepId}", which other
        steps use to read its result.
      </span>
    </label>
  );
}
