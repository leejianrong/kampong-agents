import { useEffect, useId, useRef, useState } from "react";
import type { ActionDescriptor } from "./actions.js";
import type { RunMode } from "./api.js";
import { ApprovalModal } from "./ApprovalModal.js";
import { failedItems } from "./runErrors.js";
import type { RunEntry, RunSession } from "./runSession.js";
import { formatDuration, summarizeRun } from "./runSummary.js";
import { missingSecretNamesIn } from "./secretNames.js";

// The Run bar (KAM-219): a compact strip under the top bar that is always there. It holds what a run needs at a
// glance: the mode (Replay or LIVE, with the confirmation before a live run that can change something outside the
// project), Run, how the last run went, a drawer of this session's runs and, for a credential the run could not
// find, a way to set it. The details (input, vars, trace, output, failed items) are in the Test Run panel that the
// status chip opens, and the per-step marks and data are on the canvas nodes. The run itself lives in the
// session (runSession.ts), so none of this is lost when a panel closes.

const MODE_LABEL: Record<RunMode, string> = { replay: "Replay", live: "Live" };

export interface RunControlsProps {
  session: RunSession;
  /** The "Run" action from the shared list (actions.ts), so the bar, the palette and the menu say the same thing. */
  action?: ActionDescriptor | undefined;
  /** KAM-192: opens the Secrets panel on this name. Absent where there is no Secrets panel (hosted). */
  onSetSecret?: ((name: string) => void) | undefined;
  /** Shows the Test Run panel (the details of the run on show). */
  onOpenDetails: () => void;
}

export function RunControls({ session, action, onSetSecret, onOpenDetails }: RunControlsProps) {
  const { options, mode, canChoose, runs, viewed, latest } = session;
  const root = useRef<HTMLElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const runsButton = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerId = useId();

  // The confirmation takes focus when it opens, and gives it back to Run when it closes.
  const confirming = session.confirmingLive;
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // The drawer closes on a click outside it.
  useEffect(() => {
    if (!drawerOpen) return;
    function onDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setDrawerOpen(false);
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [drawerOpen]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (confirming) {
      event.preventDefault();
      session.cancelLive();
      runButton.current?.focus();
    } else if (drawerOpen) {
      event.preventDefault();
      setDrawerOpen(false);
      runsButton.current?.focus();
    }
  }

  const summary = viewed ? summarizeRun(viewed.state) : null;
  const failed = viewed?.state.status === "completed" ? failedItems(viewed.state.finalOutput) : [];
  // KAM-192: a credential the run could not find is set from here, not in a shell or a .env file.
  const missing = onSetSecret
    ? [
        ...new Set([
          ...missingSecretNamesIn([session.error ?? undefined]),
          ...missingSecretNamesIn([
            viewed?.state.error,
            ...(viewed?.state.trace.map((t) => t.error) ?? []),
            ...failed.map((f) => f.message),
          ]),
        ]),
      ]
    : [];

  const runDisabled = !session.canRun;
  const runTitle = session.blockedReason ?? action?.title ?? "Run the workflow";

  return (
    <section
      ref={root}
      className="md3-runcontrols"
      aria-label="Run"
      data-testid="run-controls"
      onKeyDown={onKeyDown}
    >
      {options && canChoose && (
        <div
          className="md3-segmented-button md3-runcontrols__mode"
          role="group"
          aria-label="Run mode"
        >
          {(options.modes ?? []).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={session.isRunning}
              className={
                mode === value
                  ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                  : "md3-segmented-button__segment"
              }
              onClick={() => session.setMode(value)}
            >
              {MODE_LABEL[value]}
            </button>
          ))}
        </div>
      )}
      {options && mode === "live" && (
        <span
          className="md3-status-pill md3-run-mode md3-run-mode--live"
          data-testid="run-mode-badge"
        >
          LIVE
        </span>
      )}

      <button
        ref={runButton}
        type="button"
        className="md3-button md3-button-filled md3-runcontrols__run"
        disabled={runDisabled}
        title={runTitle}
        aria-keyshortcuts={action?.shortcut}
        data-testid="run-button"
        onClick={() => (action ? action.run() : session.requestRun())}
      >
        {session.isRunning ? "Running…" : "Run"}
      </button>

      <span className="md3-runcontrols__status" role="status">
        {session.optionsPending ? (
          <span className="md3-body-small">Checking what this run can use…</span>
        ) : session.blockedReason ? (
          <span className="md3-body-small" data-testid="runbar-blocked">
            Can't run yet
          </span>
        ) : session.error ? (
          <button
            type="button"
            className="md3-status-pill md3-status-pill--failed md3-runcontrols__chip"
            data-testid="runbar-status"
            onClick={onOpenDetails}
          >
            <span aria-hidden="true">✕</span> Could not start
          </button>
        ) : summary && viewed ? (
          <button
            type="button"
            className={`md3-status-pill md3-status-pill--${summary.kind} md3-runcontrols__chip`}
            data-testid="runbar-status"
            title="Show the run's details"
            onClick={onOpenDetails}
          >
            <span aria-hidden="true">{summary.icon}</span> {summary.label}
            {duration(viewed) && ` · ${duration(viewed)}`}
          </button>
        ) : (
          <span className="md3-body-small">No run yet</span>
        )}
      </span>

      {onSetSecret && missing.length > 0 && (
        <span className="md3-runcontrols__secrets" data-testid="run-set-secret">
          {missing.map((name) => (
            <button
              key={name}
              type="button"
              className="md3-button md3-button-tonal"
              onClick={() => onSetSecret(name)}
            >
              {missing.length === 1 ? "Set it here" : `Set ${name} here`}
            </button>
          ))}
        </span>
      )}

      <span className="md3-runbar__spacer" />

      <button
        ref={runsButton}
        type="button"
        className="md3-button md3-button-tonal"
        aria-expanded={drawerOpen}
        aria-controls={drawerId}
        data-testid="runs-drawer-toggle"
        onClick={() => setDrawerOpen((open) => !open)}
      >
        Runs{runs.length > 0 && <span className="md3-statusbar__badge"> {runs.length}</span>}
      </button>

      {drawerOpen && (
        <div
          id={drawerId}
          role="region"
          aria-label="Recent runs"
          className="md3-runcontrols__drawer md3-elevated-surface"
          data-testid="runs-drawer"
        >
          {runs.length === 0 ? (
            <p className="md3-body-medium">
              No runs yet in this session. Press Run to try the workflow.
            </p>
          ) : (
            <ul className="md3-runcontrols__runs">
              {runs.map((entry, i) => (
                <RunRow
                  key={entry.id}
                  entry={entry}
                  number={runs.length - i}
                  selected={viewed?.id === entry.id}
                  onChoose={() => {
                    session.viewRun(entry.id);
                    setDrawerOpen(false);
                    onOpenDetails();
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {confirming && (
        <div
          ref={confirmRef}
          role="alertdialog"
          aria-label="Run live?"
          tabIndex={-1}
          className="md3-run-confirm md3-runcontrols__confirm"
          data-testid="run-confirm"
        >
          <p className="md3-body-medium">
            <strong>Run live?</strong> This run can change things outside your project. It would
            call:
          </p>
          <ul className="md3-run-tools" data-testid="run-confirm-tools">
            {session.sideEffecting.map((t) => (
              <li key={t.name}>
                <strong>{t.name}</strong> ({t.describes}, {t.effect})
              </li>
            ))}
          </ul>
          <div className="md3-panel__footer">
            <button
              type="button"
              className="md3-button md3-button-filled"
              onClick={() => void session.start()}
            >
              Run live
            </button>
            <button
              type="button"
              className="md3-button md3-button-text"
              onClick={() => {
                session.cancelLive();
                runButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {latest?.state.status === "awaiting_approval" && latest.state.pendingApproval && (
        <ApprovalModal
          approval={latest.state.pendingApproval}
          onDecide={(approved, reason) => void session.decide(approved, reason)}
        />
      )}
    </section>
  );
}

function duration(entry: RunEntry): string | null {
  return entry.endedAt === undefined ? null : formatDuration(entry.endedAt - entry.startedAt);
}

/** One run in the drawer: its number, mode, outcome and length, in words as well as icons. */
function RunRow({
  entry,
  number,
  selected,
  onChoose,
}: {
  entry: RunEntry;
  number: number;
  selected: boolean;
  onChoose: () => void;
}) {
  const summary = summarizeRun(entry.state);
  const took = duration(entry);
  return (
    <li>
      <button
        type="button"
        className="md3-runcontrols__run-row"
        aria-pressed={selected}
        data-testid="run-row"
        onClick={onChoose}
      >
        <span className="md3-label-large">Run {number}</span>
        {entry.mode && (
          <span className={`md3-status-pill md3-run-mode md3-run-mode--${entry.mode}`}>
            {entry.mode === "replay" ? "Replay" : "LIVE"}
          </span>
        )}
        <span className={`md3-status-pill md3-status-pill--${summary.kind}`}>
          <span aria-hidden="true">{summary.icon}</span> {summary.label}
        </span>
        <span className="md3-body-small">
          {took ?? "running"} · {new Date(entry.startedAt).toLocaleTimeString()}
        </span>
      </button>
    </li>
  );
}
