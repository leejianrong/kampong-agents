import { useState } from "react";
import type { DoctorCheckDto } from "./api.js";

// KAN-1901: `kampong doctor` in the canvas. The default check is offline; reaching hosts and sending
// credentials are separate buttons, because each one leaves the machine.

export interface DoctorPanelProps {
  run: (options: { online?: boolean; probe?: boolean }) => Promise<DoctorCheckDto[]>;
}

const MARK = { pass: "✓", warn: "!", fail: "✗" } as const;

export function DoctorPanel({ run }: DoctorPanelProps) {
  const [checks, setChecks] = useState<DoctorCheckDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(options: { online?: boolean; probe?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      setChecks(await run(options));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the checks.");
    } finally {
      setBusy(false);
    }
  }

  const failed = checks?.filter((c) => c.status === "fail").length ?? 0;
  const warned = checks?.filter((c) => c.status === "warn").length ?? 0;

  return (
    <section className="md3-doctor" aria-label="Checks" data-testid="doctor-panel">
      <div className="md3-doctor__head">
        <span className="md3-title-medium">Checks</span>
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={busy}
          onClick={() => void go({})}
        >
          {busy ? "Checking…" : "Run checks"}
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Reads this spec and its components on this machine only. Nothing is sent anywhere.
      </p>
      <div className="md3-doctor__more">
        <button
          type="button"
          className="md3-button md3-button-text"
          disabled={busy}
          onClick={() => void go({ online: true })}
        >
          Also reach each host
        </button>
        <button
          type="button"
          className="md3-button md3-button-text"
          disabled={busy}
          onClick={() => void go({ online: true, probe: true })}
        >
          Also check credentials
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Checking credentials sends one read-only request, carrying each credential, to the service
        it belongs to.
      </p>

      {error && (
        <p role="alert" className="md3-banner md3-banner--error">
          {error}
        </p>
      )}
      {checks && (
        <>
          <p className="md3-body-medium" role="status" data-testid="doctor-summary">
            {failed === 0
              ? warned === 0
                ? "Everything checked out."
                : `No failures, ${warned} to look at.`
              : `${failed} failed${warned > 0 ? `, ${warned} to look at` : ""}.`}
          </p>
          <ul className="md3-doctor__list" data-testid="doctor-checks">
            {checks.map((check, i) => (
              <li key={i} className={`md3-doctor__item md3-doctor__item--${check.status}`}>
                <span aria-label={check.status} className="md3-doctor__mark">
                  {MARK[check.status]}
                </span>
                <span className="md3-body-medium">{check.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
