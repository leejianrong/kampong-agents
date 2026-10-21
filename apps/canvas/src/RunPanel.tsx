import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useRef, useState } from "react";
import type { ApiClient, RunMode, RunOptionsResponse } from "./api.js";
import type { RunState } from "./api.js";
import { ApprovalModal } from "./ApprovalModal.js";
import { describeItem, failedItems } from "./runErrors.js";
import { missingSecretNamesIn } from "./secretNames.js";
import { baseStepName } from "./runStatus.js";
import { useRunTracker } from "./runTracker.js";

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
  /** KAM-192: opens the Secrets panel on this name. Absent where there is no Secrets panel (hosted), so no button is offered. */
  onSetSecret?: (name: string) => void;
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

export function RunPanel({ api, blockedReason, onSetSecret }: RunPanelProps) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<RunState | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const runId = record?.id ?? null;
  // KAM-188: what the open spec can do (null until loaded, or on a server that cannot say), the chosen mode,
  // and whether the live-run confirmation is open.
  const [options, setOptions] = useState<RunOptionsResponse | null>(null);
  // Until the options arrive the mode is a guess ("live"), so no run may start: an early click would run live,
  // unconfirmed, instead of the replay the spec is about to offer.
  const [optionsPending, setOptionsPending] = useState(() => api.getRunOptions !== undefined);
  const [mode, setMode] = useState<RunMode>("live");
  const [confirmingLive, setConfirmingLive] = useState(false);
  // KAM-191: the text of each declared var's field, for the next run only (the spec is never changed).
  const [varText, setVarText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // KAM-190: what the run is doing is shared with the canvas, which draws it on the nodes.
  const tracker = useRunTracker();
  const traceRef = useRef<HTMLOListElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);

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
        setVarText(Object.fromEntries((loaded.vars ?? []).map((v) => [v.name, v.default ?? ""])));
        setMode(loaded.defaultMode ?? "live");
      } catch {
        // A server that cannot describe its runs gets the plain panel: no switch, a live run as before.
      } finally {
        if (!cancelled) setOptionsPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const sideEffecting = (options?.tools ?? []).filter((t) => t.sideEffecting);
  const declaredVars = options?.vars ?? [];
  const canChoose = (options?.modes?.length ?? 0) > 1;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (starting || optionsPending) return;
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
    // The last run's marks leave the canvas as the next one starts.
    tracker?.begin(null);
    try {
      // Only the vars changed from their defaults go with the run; the rest keep resolving as the spec says.
      const changed = Object.fromEntries(
        declaredVars
          .filter((v) => (varText[v.name] ?? "") !== (v.default ?? ""))
          .map((v) => [v.name, varText[v.name] ?? ""]),
      );
      const result =
        Object.keys(changed).length > 0
          ? await api.startRun(input, options ? mode : undefined, changed)
          : await api.startRun(input, options ? mode : undefined);
      if (!result.success || !result.id || !result.state) {
        setError(result.error ?? "Failed to start run.");
        return;
      }
      setRecord({ id: result.id, ...(result.mode && { mode: result.mode }) });
      setState(result.state);
      const id = result.id;
      tracker?.begin(id);
      tracker?.publish(id, { type: "state", state: result.state });

      unsubscribeRef.current?.();
      unsubscribeRef.current = api.subscribeToRunEvents(id, (message) => {
        setState(message.state);
        tracker?.publish(id, message);
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
      tracker?.publish(runId, { type: "state", state: result.state });
    } else {
      setError(result.error ?? "Failed to record approval decision.");
    }
  }

  // KAM-189: a run that finished but carried failed items on is amber, not green.
  const failed = state?.status === "completed" ? failedItems(state.finalOutput) : [];
  const completedWithErrors = failed.length > 0;
  // KAM-192: a credential the run could not find is set from here, not in a shell or a .env file.
  const missingAtStart = onSetSecret ? missingSecretNamesIn([error ?? undefined]) : [];
  const missingInRun = onSetSecret
    ? missingSecretNamesIn([
        state?.error,
        ...(state?.trace.map((t) => t.error) ?? []),
        ...failed.map((f) => f.message),
      ])
    : [];

  // KAM-190: a failed node on the canvas links here; show the message it is about.
  const request = tracker?.messageRequest ?? null;
  useEffect(() => {
    if (!request) return;
    const step = request.nodeId.replace(/^workflow:/, "");
    const target = [traceRef.current, errorsRef.current]
      .flatMap((root) => Array.from(root?.querySelectorAll<HTMLElement>("[data-run-failed]") ?? []))
      .find((el) => el.dataset["runStep"] === step);
    if (!target) return;
    target.scrollIntoView?.({ block: "nearest" });
    target.focus();
  }, [request]);

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
        {declaredVars.length > 0 && (
          <fieldset className="md3-run-vars" data-testid="run-vars">
            <legend className="md3-label-large">Vars</legend>
            <p className="md3-body-small md3-run-mode-note">
              Values for this run only. The spec keeps its defaults.
            </p>
            {declaredVars.map((v) => (
              <label key={v.name} className="md3-field">
                <span className="md3-field__label md3-label-large">
                  {v.name}
                  <span className="md3-body-small">
                    {" "}
                    (
                    {v.type === "list" ? `list of ${v.items ?? "string"}, comma separated` : v.type}
                    {v.default === undefined && ", required"})
                  </span>
                </span>
                <input
                  className="md3-text-field"
                  data-testid={`run-var-${v.name}`}
                  value={varText[v.name] ?? ""}
                  disabled={isRunning}
                  onChange={(e) => setVarText((t) => ({ ...t, [v.name]: e.target.value }))}
                />
                {v.description && <span className="md3-body-small">{v.description}</span>}
              </label>
            ))}
          </fieldset>
        )}
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
          <PanelFooter
            save="Run"
            disabled={isRunning || optionsPending || blockedReason !== undefined}
          />
        )}
      </form>

      {blockedReason && <PanelError messages={[blockedReason]} testId="run-blocked" />}
      {error && <PanelError messages={[error]} testId="run-error" />}
      {onSetSecret && <SetSecretActions names={missingAtStart} onSet={onSetSecret} />}

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
            <span
              className={`md3-status-pill md3-status-pill--${
                completedWithErrors ? "completed_with_errors" : state.status
              }`}
            >
              {completedWithErrors
                ? `completed with ${failed.length} ${failed.length === 1 ? "error" : "errors"}`
                : state.status}
            </span>
          </div>
          <ol ref={traceRef} data-testid="run-trace" className="md3-run-trace md3-body-medium">
            {state.trace.map((entry, i) => (
              <li
                key={`${entry.step}-${i}`}
                data-run-step={baseStepName(entry.step)}
                {...(entry.status !== "completed" && { "data-run-failed": "", tabIndex: -1 })}
              >
                {entry.step}: {entry.status}
                {entry.confidence !== undefined && ` (confidence ${entry.confidence})`}
                {entry.error && `: ${entry.error}`}
              </li>
            ))}
          </ol>
          {completedWithErrors && <FailedItemsTable items={failed} rootRef={errorsRef} />}
          {state.status === "completed" &&
            (completedWithErrors ? (
              <details className="md3-run-raw">
                <summary className="md3-body-medium">Full output</summary>
                <pre data-testid="run-final-output" className="md3-code-block">
                  {JSON.stringify(state.finalOutput, null, 2)}
                </pre>
              </details>
            ) : (
              <pre data-testid="run-final-output" className="md3-code-block">
                {JSON.stringify(state.finalOutput, null, 2)}
              </pre>
            ))}
          {(state.status === "rejected" || state.status === "failed") && (
            <PanelError messages={[`Run ${state.status}: ${state.error}`]} testId="run-halted" />
          )}
          {onSetSecret && <SetSecretActions names={missingInRun} onSet={onSetSecret} />}
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

/** One button per credential the run could not find, each opening the Secrets panel on that name (KAM-192). */
function SetSecretActions({ names, onSet }: { names: string[]; onSet: (name: string) => void }) {
  if (names.length === 0) return null;
  return (
    <div className="md3-run-secrets" data-testid="run-set-secret">
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className="md3-button md3-button-tonal"
          onClick={() => onSet(name)}
        >
          {names.length === 1 ? "Set it here" : `Set ${name} here`}
        </button>
      ))}
    </div>
  );
}

/** The items a loop carried on past (KAM-189): which one, which step failed, and why. */
function FailedItemsTable({
  items,
  rootRef,
}: {
  items: ReturnType<typeof failedItems>;
  rootRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className="md3-run-errors" data-testid="run-errors" ref={rootRef}>
      <table className="md3-run-errors__table md3-body-small">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Step</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr
              key={`${f.loop}-${f.index}`}
              data-testid="run-error-row"
              data-run-step={f.step}
              data-run-failed=""
              tabIndex={-1}
            >
              <td>{describeItem(f.item) || `#${f.index + 1}`}</td>
              <td>
                {f.loop}
                {f.step && ` / ${f.step}`}
              </td>
              <td>{f.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
