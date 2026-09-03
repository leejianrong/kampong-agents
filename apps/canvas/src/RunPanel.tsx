import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api.js";
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
}

export function RunPanel({ api }: RunPanelProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<RunState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Closes the SSE subscription on unmount too, not just on the next
  // handleStart -- otherwise navigating away from this panel mid-run (e.g.
  // switching canvas tabs) leaks the EventSource connection indefinitely.
  useEffect(() => {
    return () => unsubscribeRef.current?.();
  }, []);

  async function handleStart(event: React.FormEvent) {
    event.preventDefault();
    if (starting) return;
    // Set synchronously, before the `await` below, so a fast double-click
    // can't get past this guard twice and start two concurrent runs -- the
    // `isRunning` (server-state-derived) disabled check alone has a window
    // between click and the POST /api/runs response resolving.
    setStarting(true);
    setError(null);
    try {
      const result = await api.startRun(input);
      if (!result.success || !result.id || !result.state) {
        setError(result.error ?? "Failed to start run.");
        return;
      }
      setRunId(result.id);
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
    <div className="md3-card md3-stack" data-testid="run-panel">
      <h2 className="md3-title-medium">Test run</h2>
      <form onSubmit={(e) => void handleStart(e)} className="md3-form">
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Input</span>
          <input
            className="md3-text-field"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button type="submit" className="md3-button md3-button-filled" disabled={isRunning}>
          Run
        </button>
      </form>

      {error && (
        <div role="alert" data-testid="run-error" className="md3-banner md3-banner--error">
          {error}
        </div>
      )}

      {state && (
        <>
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
            <div role="alert" data-testid="run-halted" className="md3-banner md3-banner--error">
              Run {state.status}: {state.error}
            </div>
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
