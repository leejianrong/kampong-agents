import { useCallback, useEffect, useRef, useState } from "react";
import { PanelError } from "./Panel";
import type { DeployApi, DeployApprovalDto, DeployRunDto, DeploymentDto } from "./api.js";

// KAM-326: the hosted Deploy panel. Go live, see the address, keep the signing secret (shown once), pause, rotate and
// delete, and watch what the deployment does: its recent runs and the ones waiting for a person. Everything here is a
// call the server already had (KAM-324); the panel adds no state of its own beyond what the server says.

export interface DeployPanelProps {
  api: DeployApi;
  /** Approve or reject a run waiting for a person. */
  approve: (runId: string, approved: boolean) => Promise<unknown>;
  /** The page's origin, used to make the address whole when the server was not told its public URL. */
  origin?: string;
  /** How often the lists refresh while the panel is open, in milliseconds. 0 turns it off. */
  refreshMs?: number;
}

const SOURCE: Record<string, string> = {
  webhook: "Web address",
  schedule: "Schedule",
  manual: "Test run",
};

export function DeployPanel({
  api,
  approve,
  origin = window.location.origin,
  refreshMs = 10_000,
}: DeployPanelProps) {
  const [deployment, setDeployment] = useState<DeploymentDto | null | undefined>(undefined);
  const [runs, setRuns] = useState<DeployRunDto[]>([]);
  const [approvals, setApprovals] = useState<DeployApprovalDto[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const live = useRef(true);

  const refreshLists = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([api.listRuns(), api.listApprovals()]);
      if (live.current) {
        setRuns(r);
        setApprovals(a);
      }
    } catch (err) {
      if (live.current) setError(messageOf(err, "Could not load the runs."));
    }
  }, [api]);

  useEffect(() => {
    live.current = true;
    api.get().then(
      (d) => {
        if (!live.current) return;
        setDeployment(d);
        if (d) void refreshLists();
      },
      (err: unknown) => {
        if (!live.current) return;
        setDeployment(null);
        setError(messageOf(err, "Could not load the deployment."));
      },
    );
    return () => {
      live.current = false;
    };
  }, [api, refreshLists]);

  const deployed = deployment !== undefined && deployment !== null;
  useEffect(() => {
    if (!deployed || refreshMs <= 0) return;
    const timer = setInterval(() => void refreshLists(), refreshMs);
    return () => clearInterval(timer);
  }, [deployed, refreshMs, refreshLists]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(messageOf(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  const goLive = () =>
    act(async () => {
      const d = await api.deploy();
      setDeployment(d);
      setSecret(d.webhookSecret ?? null);
      await refreshLists();
    });

  const setStatus = (status: "live" | "paused") =>
    act(async () => {
      await api.setStatus(status);
      setDeployment((d) => (d ? { ...d, status } : d));
    });

  const rotate = () =>
    act(async () => {
      setSecret(await api.rotateSecret());
    });

  const remove = () =>
    act(async () => {
      await api.remove();
      setDeployment(null);
      setSecret(null);
      setRuns([]);
      setApprovals([]);
      setConfirming(false);
    });

  const decide = (runId: string, approved: boolean) =>
    act(async () => {
      await approve(runId, approved);
      await refreshLists();
    });

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setError("Could not copy. Select the text and copy it by hand.");
    }
  }

  if (deployment === undefined) {
    return <p className="md3-body-medium">Loading…</p>;
  }

  const address = deployment ? (deployment.webhookUrl ?? `${origin}${deployment.webhookPath}`) : "";
  const paused = deployment?.status !== "live";

  return (
    <div className="md3-deploy" data-testid="deploy-panel-body">
      {error && <PanelError messages={[error]} />}

      {!deployment && (
        <>
          <p className="md3-body-medium">
            Not live. Going live gives this workflow a web address that starts a run, and starts its
            schedule if it has one.
          </p>
          <div>
            <button
              type="button"
              className="md3-button md3-button-filled"
              disabled={busy}
              onClick={() => void goLive()}
            >
              Go live
            </button>
          </div>
        </>
      )}

      {deployment && (
        <>
          <div className="md3-deploy__row">
            <span
              className={`md3-status-chip md3-status-chip--${paused ? "unpinned" : "pinned"}`}
              data-testid="deploy-status"
            >
              {paused ? "Paused" : "Live"}
            </span>
            <button
              type="button"
              className="md3-button md3-button-tonal"
              disabled={busy}
              onClick={() => void setStatus(paused ? "live" : "paused")}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>

          <div className="md3-deploy__block">
            <span className="md3-body-small md3-field__label">
              Address (send a POST here to start a run)
            </span>
            <div className="md3-deploy__code-row">
              <code className="md3-deploy__code" data-testid="deploy-address">
                {address}
              </code>
              <button
                type="button"
                className="md3-button md3-button-text"
                onClick={() => void copy("address", address)}
              >
                {copied === "address" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {secret && (
            <div
              className="md3-banner md3-banner--warning md3-deploy__secret"
              role="status"
              data-testid="deploy-secret"
            >
              <div>
                <p className="md3-body-medium">
                  <strong>Signing secret. It is shown once.</strong> Copy it now and put it where
                  the sender is set up. If you lose it, rotate it.
                </p>
                <code className="md3-deploy__code">{secret}</code>
              </div>
              <button
                type="button"
                className="md3-button md3-button-tonal"
                onClick={() => void copy("secret", secret)}
              >
                {copied === "secret" ? "Copied" : "Copy secret"}
              </button>
              <button type="button" className="md3-banner__action" onClick={() => setSecret(null)}>
                I have saved it
              </button>
            </div>
          )}

          <div className="md3-deploy__row">
            <button
              type="button"
              className="md3-button md3-button-text"
              disabled={busy}
              onClick={() => void rotate()}
            >
              Rotate secret
            </button>
            {!confirming && (
              <button
                type="button"
                className="md3-button md3-button-text"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Delete deployment
              </button>
            )}
          </div>
          {confirming && (
            <div
              className="md3-banner md3-banner--error"
              role="alertdialog"
              aria-label="Delete deployment"
            >
              <span>
                Delete this deployment? Its address stops working for good, and going live again
                makes a new one.
              </span>
              <button
                type="button"
                className="md3-banner__action"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete
              </button>
              <button
                type="button"
                className="md3-banner__action"
                onClick={() => setConfirming(false)}
              >
                Keep it
              </button>
            </div>
          )}

          <section aria-labelledby="deploy-waiting">
            <h3 id="deploy-waiting" className="md3-title-small">
              Waiting for you
            </h3>
            {approvals.length === 0 ? (
              <p className="md3-body-medium" data-testid="deploy-no-approvals">
                Nothing is waiting for a decision.
              </p>
            ) : (
              <ul className="md3-doctor__list" data-testid="deploy-approvals">
                {approvals.map((a) => (
                  <li key={a.runId} className="md3-deploy__item">
                    <span className="md3-body-medium">
                      {a.reason ?? "A run is waiting for approval"}
                      {a.step ? ` (step ${a.step})` : ""}
                    </span>
                    <span className="md3-deploy__actions">
                      <button
                        type="button"
                        className="md3-button md3-button-tonal"
                        disabled={busy}
                        onClick={() => void decide(a.runId, true)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="md3-button md3-button-text"
                        disabled={busy}
                        onClick={() => void decide(a.runId, false)}
                      >
                        Reject
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="deploy-runs">
            <div className="md3-doctor__head">
              <h3 id="deploy-runs" className="md3-title-small">
                Recent runs
              </h3>
              <button
                type="button"
                className="md3-button md3-button-text"
                onClick={() => void refreshLists()}
              >
                Refresh
              </button>
            </div>
            {runs.length === 0 ? (
              <p className="md3-body-medium" data-testid="deploy-no-runs">
                No runs yet.
              </p>
            ) : (
              <ul className="md3-doctor__list" data-testid="deploy-runs">
                {runs.map((r) => (
                  <li key={r.id} className="md3-deploy__item">
                    <span className="md3-body-medium">{r.outcome}</span>
                    <span className="md3-body-small md3-deploy__meta">
                      {SOURCE[r.source] ?? r.source} · {when(r.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
