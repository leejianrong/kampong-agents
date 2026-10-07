import { useId, useState } from "react";
import type { ComponentCatalogEntry } from "@kampong/spec";

// KAN-1901: what a component may do and whether a run will accept it, with the same review-then-pin
// step `kampong lock` has. The canvas holds no logic of its own here: the summary, the pin state and the
// refusal to widen permissions without consent all come from the server.

export type PinResult = { ok: true } | { ok: false; error: string };

export interface ComponentTrustProps {
  entry: ComponentCatalogEntry;
  /** Pins this component. Absent where the server cannot (then the form says to run `kampong lock`). */
  onPin?: (
    use: string,
    allowWiderPermissions: boolean,
    reviewedDigest: string,
  ) => Promise<PinResult>;
}

const STATE_LABEL = {
  "first-party": "Built in",
  pinned: "Pinned",
  changed: "Changed since pinned",
  unpinned: "Not pinned",
} as const;

export function ComponentTrust({ entry, onPin }: ComponentTrustProps) {
  const ref = `${entry.id}@${entry.version}`;
  const [reviewing, setReviewing] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acceptId = useId();
  const state = entry.pin?.state;
  const widened = entry.pin?.widened ?? [];
  const revoked = entry.revoked;
  // A revoked component is refused everywhere, so there is nothing to review and pin.
  const needsPin = !revoked && (state === "unpinned" || state === "changed");

  async function pin() {
    if (!onPin) return;
    setBusy(true);
    setError(null);
    const result = await onPin(ref, accepted, entry.digest);
    setBusy(false);
    if (result.ok) {
      setReviewing(false);
      setAccepted(false);
    } else {
      setError(result.error);
    }
  }

  return (
    <section className="md3-trust" aria-label={`Trust for ${ref}`} data-testid="component-trust">
      <div className="md3-trust__head">
        <span className="md3-label-large">What this component may do</span>
        {state && (
          <span
            className={`md3-status-chip md3-status-chip--${state}`}
            data-testid="pin-state"
            role="status"
            aria-live="polite"
          >
            {STATE_LABEL[state]}
          </span>
        )}
      </div>
      <p className="md3-body-medium md3-trust__summary" data-testid="permissions-summary">
        {entry.permissionsSummary}
      </p>

      {revoked && (
        <div role="alert" className="md3-banner md3-banner--error" data-testid="revoked">
          <p>
            <strong>Revoked on {revoked.at}:</strong> {revoked.reason}. A run, a pin and an export
            all refuse it. Remove it from your tools or use a version that has not been revoked.
          </p>
          {revoked.advisory && (
            <p>
              <a href={revoked.advisory} target="_blank" rel="noreferrer noopener">
                Read the advisory
              </a>
            </p>
          )}
        </div>
      )}
      {!revoked && state === "changed" && (
        <div role="alert" className="md3-banner md3-banner--warning">
          <p>
            Its files are different from what was pinned, so a run refuses it until you review and
            pin it again.
          </p>
        </div>
      )}
      {widened.length > 0 && (
        <div role="alert" className="md3-banner md3-banner--error" data-testid="widened">
          <p>It may now do more than what was reviewed:</p>
          <ul className="md3-banner__errors">
            {widened.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {state === undefined && (
        <p className="md3-body-small md3-field__hint">
          Run <code>kampong lock</code> to pin this component; a run refuses a component that is not
          pinned.
        </p>
      )}

      {needsPin && !onPin && (
        <p className="md3-body-small md3-field__hint">
          Run <code>kampong lock</code> to pin it; a run refuses a component that is not pinned.
        </p>
      )}
      {needsPin && onPin && !reviewing && (
        <button
          type="button"
          className="md3-button md3-button-tonal"
          onClick={() => setReviewing(true)}
        >
          Review and pin
        </button>
      )}
      {needsPin && onPin && reviewing && (
        <div className="md3-trust__confirm">
          <p className="md3-body-medium">
            Pin <code>{ref}</code> as it is now? It may: {entry.permissionsSummary}.
          </p>
          {widened.length > 0 && (
            <label className="md3-checkbox-field" htmlFor={acceptId}>
              <input
                id={acceptId}
                type="checkbox"
                className="md3-checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span className="md3-body-medium">I accept the wider permissions</span>
            </label>
          )}
          {error && (
            <p role="alert" className="md3-body-medium md3-trust__error">
              {error}
            </p>
          )}
          <div className="md3-trust__actions">
            <button
              type="button"
              className="md3-button md3-button-filled"
              disabled={busy || (widened.length > 0 && !accepted)}
              onClick={() => void pin()}
            >
              {busy ? "Pinning…" : "Pin"}
            </button>
            <button
              type="button"
              className="md3-button md3-button-text"
              onClick={() => {
                setReviewing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
