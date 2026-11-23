import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useRef, useState } from "react";
import type { Trigger } from "@kampong/spec";
import type { DoctorCheckDto } from "./api.js";
import { arrange } from "./doctorView.js";
import { missingSecretNames } from "./secretNames.js";

// KAN-1901: `kampong doctor` in the canvas. The default check is offline and runs when the panel opens (KAM-311);
// reaching hosts and sending credentials are two tick boxes, because each one leaves the machine.

export interface DoctorPanelProps {
  run: (options: { online?: boolean; probe?: boolean }) => Promise<DoctorCheckDto[]>;
  /** KAM-192: opens the Secrets panel on a name a check says is not set. Absent where there is no Secrets panel. */
  onSetSecret?: (name: string) => void;
  /** The workflow's trigger, shown as a row of its own: doctor does not check it. */
  trigger?: Trigger | undefined;
}

const WORD = { pass: "Passed", warn: "Warning", fail: "Failed", unchecked: "Not checked" } as const;
const MARK = { pass: "✓", warn: "!", fail: "✗", unchecked: "–" } as const;

export function DoctorPanel({ run, onSetSecret, trigger }: DoctorPanelProps) {
  const [checks, setChecks] = useState<DoctorCheckDto[] | null>(null);
  const [reached, setReached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [probe, setProbe] = useState(false);
  // Sending credentials is the one check that leaves the machine with a secret, so it asks first.
  const [confirmingProbe, setConfirmingProbe] = useState(false);

  async function go(options: { online?: boolean; probe?: boolean }) {
    setBusy(true);
    setError(null);
    try {
      setChecks(await run(options));
      setReached(options.online === true || options.probe === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the checks.");
    } finally {
      setBusy(false);
    }
  }

  // The offline check reads only this machine, so it runs as the panel opens: there is nothing to wait to press.
  const first = useRef(true);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    void go({});
  }, []);

  const options = () => ({
    ...((online || probe) && { online: true }),
    ...(probe && { probe: true }),
  });

  const failed = checks?.filter((c) => c.status === "fail").length ?? 0;
  const warned = checks?.filter((c) => c.status === "warn").length ?? 0;
  const view = checks ? arrange(checks, { reached, trigger }) : null;

  return (
    <div className="md3-doctor" data-testid="doctor-panel">
      <div className="md3-doctor__head">
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={busy}
          onClick={() => (probe ? setConfirmingProbe(true) : void go(options()))}
        >
          {busy ? "Checking…" : "Run checks"}
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Reads this spec and its components on this machine only. Nothing is sent anywhere.
      </p>
      <div className="md3-doctor__more">
        <label className="md3-field md3-field--inline">
          <input
            type="checkbox"
            checked={online || probe}
            disabled={busy || probe}
            onChange={(e) => setOnline(e.target.checked)}
          />
          <span className="md3-body-medium">Also reach each host</span>
        </label>
        <label className="md3-field md3-field--inline">
          <input
            type="checkbox"
            checked={probe}
            disabled={busy}
            onChange={(e) => setProbe(e.target.checked)}
          />
          <span className="md3-body-medium">Also check credentials</span>
        </label>
      </div>
      <p className="md3-body-small md3-field__hint">
        Checking credentials sends one read-only request, carrying each credential, to the service
        it belongs to. Tick what you want, then press Run checks.
      </p>
      {confirmingProbe && (
        <div
          role="alertdialog"
          aria-label="Confirm sending credentials"
          className="md3-trust__confirm"
        >
          <p className="md3-body-medium">
            Send each credential this spec uses to the service it belongs to?
          </p>
          <PanelFooter
            save="Send and check"
            autoFocus
            disabled={busy}
            onSave={() => {
              setConfirmingProbe(false);
              void go({ online: true, probe: true });
            }}
            onCancel={() => setConfirmingProbe(false)}
          />
        </div>
      )}

      {error && <PanelError messages={[error]} />}
      {view && (
        <>
          <p className="md3-body-medium" role="status" data-testid="doctor-summary">
            {failed === 0
              ? warned === 0
                ? "Everything checked out."
                : `No failures, ${warned} to look at.`
              : `${failed} failed${warned > 0 ? `, ${warned} to look at` : ""}.`}
          </p>
          <ul className="md3-doctor__list" data-testid="doctor-checks">
            {view.attention.map((row, i) => (
              <li key={i} className={`md3-doctor__item md3-doctor__item--${row.status}`}>
                <span className="md3-doctor__mark" aria-hidden="true">
                  {MARK[row.status]}
                </span>
                <span className="md3-visually-hidden">{WORD[row.status]}: </span>
                <span className="md3-body-medium" title={row.original}>
                  {row.text}
                </span>
                {onSetSecret &&
                  row.status !== "pass" &&
                  missingSecretNames(row.original).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="md3-button md3-button-text"
                      aria-label={`Set it here for ${name}`}
                      onClick={() => onSetSecret(name)}
                    >
                      Set it here
                    </button>
                  ))}
              </li>
            ))}
          </ul>
          {view.passed.length > 0 && (
            <details className="md3-doctor__passed" data-testid="doctor-passed">
              <summary className="md3-body-medium">
                {view.passed.length} {view.passed.length === 1 ? "check" : "checks"} passed
              </summary>
              <ul className="md3-doctor__list">
                {view.passed.map((row, i) => (
                  <li key={i} className="md3-doctor__item md3-doctor__item--pass">
                    <span className="md3-doctor__mark" aria-hidden="true">
                      {MARK.pass}
                    </span>
                    <span className="md3-visually-hidden">{WORD.pass}: </span>
                    <span className="md3-body-medium" title={row.original}>
                      {row.text}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
