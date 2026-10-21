import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useRef, useState } from "react";
import type { ApiClient, RunMode, RunOptionsResponse } from "./api.js";
import type { RunState } from "./api.js";
import { ApprovalModal } from "./ApprovalModal.js";

// The in-canvas test-run panel (PLAN.md Affordances "Test-run sandbox +
// approval modal", SLICES.md V2 KAN-1107): starts a run against the spec
// currently on disk, shows live per-step state, and surfaces the approval
// modal whenever the engine pauses (guardrail breach or a requires_approval
// tool). SSE is the source of truth for live updates; the POST response is
// just the state at the moment the request returns.

export interface RunPanelProps {
  api: ApiClient;
  /** KAM-196: why a run cannot start right now (no workflow, no steps, a spec error). Shown instead of the Run button. */
  blockedReason?: string;
}

/**
 * What this panel remembers about the run on screen beside its engine state. The chain of run-panel cards
 * (KAM-189 onward) adds its fields here, so the result block reads one record rather than loose state.
 */
interface RunRecord {
  id: string;
  /** The mode the run was started in (KAM-188), as the server reported it; absent from a server with only live runs. */
  mode?: RunMode;
}

const MODE_LABEL: Record<RunMode, string> = { replay: "Replay", live: "Live" };

export function RunPanel({ api, blockedReason }: RunPanelProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<RunState | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const runId = record?.id ?? null;
  // KAM-188: what the open spec can do (null until loaded, or on a server that cannot say), the chosen mode,
  // and whether the live-run confirmation is open.
  const [options, setOptions] = useState<RunOptionsResponse | null>(null);
  const [mode, setMode] = useState<RunMode>("live");
  const [confirmingLive, setConfirmingLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Closes the SSE subscription on unmount too, not just on the next
  // handleStart -- otherwise navigating away from this panel mid-run (e.g.
  // switching canvas tabs) leaks the EventSource connection indefinitely.
  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.getRunOptions?.();
        if (cancelled || !loaded?.success) return;
        setOptions(loaded);
        setMode(loaded.defaultMode ?? "live");
      } catch {
        // A server that cannot describe its runs gets the plain panel: no switch, a live run as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const sideEffecting = (options?.tools ?? []).filter((t) => t.sideEffecting);
  const canChoose = (options?.modes?.length ?? 0) > 1;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (starting) return;
    // A live run that can change something outside the project asks first, naming what it would call.
    if (options && mode === "live" && sideEffecting.length > 0) {
      setConfirmingLive(true);
      return;
    }
    void handleStart();
  }

  async function handleStart() {
    setConfirmingLive(false);
    if (starting) return;
    // Set synchronously, before the `await` below, so a fast double-click
    // can't get past this guard twice and start two concurrent runs -- the
    // `isRunning` (server-state-derived) disabled check alone has a window
    // between click and the POST /api/runs response resolving.
    setStarting(true);
    setError(null);
    try {
      const result = await api.startRun(input, options ? mode : undefined);
      if (!result.success || !result.id || !result.state) {
        setError(result.error ?? "Failed to start run.");
        return;
      }
      setRecord({ id: result.id, ...(result.mode && { mode: result.mode }) });
      setState(result.state);

      unsubscribeRef.current?.();
      unsubscribeRef.current = api.subscribeToRunEvents(result.id, (message) => {
        setState(message.state);
      });
    } finally {
      setStarting(false);
    }
  }

  async function handleDecide(approved: boolean, reason?: string) {
    if (!runId) return;
    const result = await api.approveRun(runId, approved, reason);
    if (result.success && result.state) {
      setState(result.state);
    } else {
      setError(result.error ?? "Failed to record approval decision.");
    }
  }

  const isRunning =
    starting || state?.status === "running" || state?.status === "awaiting_approval";

  return (
    <div className="md3-stack" data-testid="run-panel">
      <form onSubmit={handleSubmit} className="md3-form">
        {canChoose && (
          <div className="md3-field">
            <span className="md3-field__label md3-label-large">Mode</span>
            <div className="md3-segmented-button" role="group" aria-label="Run mode">
              {(options?.modes ?? []).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  disabled={isRunning}
                  className={
                    mode === value
                      ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                      : "md3-segmented-button__segment"
                  }
                  onClick={() => setMode(value)}
                >
                  {MODE_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Input</span>
          <input
            className="md3-text-field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        {options && mode === "replay" && (
          <p className="md3-body-small md3-run-mode-note" data-testid="run-replay-note">
            Replay answers from the {options.fixtures?.count} recorded fixtures in{" "}
            <code>{options.fixtures?.dir}</code>. No keys, no network, nothing is sent.
          </p>
        )}
        {options && mode === "live" && (
          <div className="md3-run-live" data-testid="run-live-banner">
            <div>
              <strong>LIVE</strong>: this run calls real services
              {!canChoose && " (no recorded fixtures to replay)"}.
              <RunToolList options={options} />
            </div>
          </div>
        )}
        {confirmingLive ? (
          <div
            role="alertdialog"
            aria-label="Run live?"
            className="md3-run-confirm"
            data-testid="run-confirm"
          >
            <p className="md3-body-medium">
              <strong>Run live?</strong> This run can change things outside your project. It would
              call:
            </p>
            <ul className="md3-run-tools" data-testid="run-confirm-tools">
              {sideEffecting.map((t) => (
                <li key={t.name}>
                  <strong>{t.name}</strong> ({t.describes}, {t.effect})
                </li>
              ))}
            </ul>
            <PanelFooter
              save="Run live"
              onSave={() => void handleStart()}
              onCancel={() => setConfirmingLive(false)}
            />
          </div>
        ) : (
          <PanelFooter save="Run" disabled={isRunning || blockedReason !== undefined} />
        )}
      </form>

      {blockedReason && <PanelError messages={[blockedReason]} testId="run-blocked" />}
      {error && <PanelError messages={[error]} testId="run-error" />}

      {state && (
        <>
          {record?.mode && (
            <div className="md3-body-medium" data-testid="run-mode">
              Mode:{" "}
              <span className={`md3-status-pill md3-run-mode md3-run-mode--${record.mode}`}>
                {record.mode === "live" ? "LIVE" : "Replay (recorded fixtures)"}
              </span>
            </div>
          )}
          <div className="md3-body-medium" data-testid="run-status">
            Status:{" "}
            <span className={`md3-status-pill md3-status-pill--${state.status}`}>
              {state.status}
            </span>
          </div>
          <ol data-testid="run-trace" className="md3-run-trace md3-body-medium">
            {state.trace.map((entry, i) => (
              <li key={`${entry.step}-${i}`}>
                {entry.step}: {entry.status}
                {entry.confidence !== undefined && ` (confidence ${entry.confidence})`}
                {entry.error && `: ${entry.error}`}
              </li>
            ))}
          </ol>
          {state.status === "completed" && (
            <pre data-testid="run-final-output" className="md3-code-block">
              {JSON.stringify(state.finalOutput, null, 2)}
            </pre>
          )}
          {(state.status === "rejected" || state.status === "failed") && (
            <PanelError messages={[`Run ${state.status}: ${state.error}`]} testId="run-halted" />
          )}
        </>
      )}

      {state?.status === "awaiting_approval" && state.pendingApproval && (
        <ApprovalModal
          approval={state.pendingApproval}
          onDecide={(approved, reason) => void handleDecide(approved, reason)}
        />
      )}
    </div>
  );
}

/** The tools a live run would call, each marked when it changes something outside the project. */
function RunToolList({ options }: { options: RunOptionsResponse }) {
  const tools = options.tools ?? [];
  if (tools.length === 0 && !options.modelCalls) return null;
  return (
    <ul className="md3-run-tools" data-testid="run-live-tools">
      {tools.map((t) => (
        <li key={t.name}>
          <strong>{t.name}</strong> ({t.describes}){" "}
          {t.sideEffecting ? `changes things (${t.effect})` : "read only"}
          {t.requiresApproval && ", asks for approval first"}
        </li>
      ))}
      {options.modelCalls && <li>Model calls go to the configured model provider.</li>}
    </ul>
  );
}
