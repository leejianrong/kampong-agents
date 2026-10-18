import { useMemo, useState } from "react";
import { previewUpgradeTo11 } from "@kampong/spec";
import { useUpgrade } from "./UpgradeContext.js";

// The notice a panel shows on a version "1.0" spec for what only "1.1" has (KAM-198). One component so the panels
// say it the same way. The banner is a flex row, so the sentence must be one child: inline `<code>` runs directly
// inside it each became a column and the text ran off the card.
//
// KAM-199: where the app can write the spec, the notice also offers Upgrade. It shows exactly what would change
// (a line diff) and what was rewritten to keep its meaning, and refuses, with the reasons, if the result would
// not load. Nothing is written until Upgrade is pressed.

export interface VersionGateProps {
  /** What needs 1.1, as the start of the sentence: "Vars", "Per-step settings and an output schema". */
  what: string;
}

export function VersionGate({ what }: VersionGateProps) {
  const upgrade = useUpgrade();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div role="status" className="md3-banner md3-banner--info">
        <p className="md3-banner__text">
          {what} need spec version <code>"1.1"</code>.{" "}
          {upgrade ? (
            <>
              1.1 reads <code>{"{{ }}"}</code> references as expressions, which can change what an
              existing 1.0 spec means; Upgrade shows what would change first.
            </>
          ) : (
            <>
              Change <code>version</code> in the YAML when you are ready: 1.1 reads{" "}
              <code>{"{{ }}"}</code> references as expressions, which can change what an existing
              1.0 spec means.
            </>
          )}
        </p>
        {upgrade && !open && (
          <button
            type="button"
            className="md3-button md3-button-tonal"
            onClick={() => setOpen(true)}
          >
            Upgrade to 1.1…
          </button>
        )}
      </div>
      {upgrade && open && (
        <UpgradePreview
          source={upgrade.source}
          apply={upgrade.apply}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function UpgradePreview({
  source,
  apply,
  onClose,
}: {
  source: string;
  apply: (ops: import("@kampong/spec").PatchOp[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const preview = useMemo(() => previewUpgradeTo11(source), [source]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    if (!preview.success) return;
    setBusy(true);
    setFailed(false);
    const ok = await apply(preview.ops);
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  }

  return (
    <section className="md3-upgrade" aria-label="Upgrade to 1.1">
      <span className="md3-title-small">Upgrade to 1.1</span>
      {preview.success ? (
        <>
          <p className="md3-body-small md3-field__hint">
            {preview.notes.length === 0
              ? "Only the version line changes."
              : "The version changes, and these were rewritten so they mean the same in 1.1:"}
          </p>
          {preview.notes.length > 0 && (
            <ul className="md3-upgrade__notes">
              {preview.notes.map((note) => (
                <li key={note.message} className="md3-body-small">
                  {note.message}
                </li>
              ))}
            </ul>
          )}
          <pre className="md3-upgrade__diff" aria-label="Changes to the YAML" tabIndex={0}>
            {preview.diff.map((line, i) => (
              <span key={i} className={`md3-upgrade__line md3-upgrade__line--${line.kind}`}>
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
          {failed && (
            <p role="alert" className="md3-body-small md3-error-list">
              Could not upgrade the spec, so nothing was changed.
            </p>
          )}
          <div className="md3-trust__actions">
            <button
              type="button"
              className="md3-button md3-button-filled"
              disabled={busy}
              onClick={() => void run()}
            >
              Upgrade
            </button>
            <button type="button" className="md3-button md3-button-text" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="md3-body-small md3-field__hint">
            This spec would not load as 1.1, so nothing was changed. Fix these in the YAML first:
          </p>
          <ul role="alert" className="md3-error-list">
            {preview.errors.map((error, i) => (
              <li key={i}>
                {error.line ? `Line ${error.line}: ` : ""}
                {error.message}
              </li>
            ))}
          </ul>
          {preview.errors.some((e) =>
            e.message.includes("is not something an expression can read"),
          ) && (
            <p className="md3-body-small md3-field__hint">
              A <code>{"{name}"}</code> placeholder in 1.0 read a field of an earlier step. 1.1
              needs the step named too, for example <code>{"{{ classify.name }}"}</code>.
            </p>
          )}
          <div className="md3-trust__actions">
            <button type="button" className="md3-button md3-button-text" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </section>
  );
}
