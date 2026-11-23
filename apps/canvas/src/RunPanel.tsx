import { PanelError } from "./Panel";
import { useEffect, useRef } from "react";
import type { RunOptionsResponse } from "./api.js";
import { describeItem, failedItems, groupFailures } from "./runErrors.js";
import type { RunSession } from "./runSession.js";
import { baseStepName } from "./runStatus.js";
import { useRunTracker } from "./runTracker.js";
import { summarizeRun } from "./runSummary.js";
import { explainError } from "./runReason.js";
import { ReasonFix } from "./ReasonFix.js";

// The Test Run panel (PLAN.md Affordances "Test-run sandbox + approval modal", SLICES.md V2 KAN-1107): the details
// of a run, shown from the session the Run bar starts (KAM-219). SSE is the source of truth for live updates; the
// POST response is just the state at the moment the request returns.

export interface RunPanelProps {
  /** The run session the Run bar shares (KAM-219): its fields, runs and the run on show. */
  session: RunSession;
}

/**
 * The details of the run on show: the input and var fields for the next run, the trace, the output and the failed
 * items. Starting a run, the mode switch and the live confirmation live on the Run bar (KAM-219), so this panel
 * can stay closed and a run still starts, streams and is judged.
 */
export function RunPanel({ session }: RunPanelProps) {
  const { options, mode, canChoose, declaredVars, varText, isRunning, viewed, latest } = session;
  const state = viewed?.state ?? null;
  const record = viewed;
  const tracker = useRunTracker();
  const traceRef = useRef<HTMLOListElement>(null);
  const errorsRef = useRef<HTMLDivElement>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    session.requestRun();
  }

  // KAM-189: a run that finished but carried failed items on is amber, not green.
  const failed = state?.status === "completed" ? failedItems(state.finalOutput) : [];
  const reason = state?.error ? explainError(state.error) : undefined;
  const completedWithErrors = failed.length > 0;
  const summary = state ? summarizeRun(state) : undefined;

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

  return (
    <div className="md3-stack" data-testid="run-panel">
      <form
        onSubmit={handleSubmit}
        onKeyDown={(event) => {
          // With no submit button in the form, Enter in a field would do nothing once there are two fields.
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            session.requestRun();
          }
        }}
        className="md3-form"
      >
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Input</span>
          <input
            className="md3-text-field"
            value={session.input}
            onChange={(e) => session.setInput(e.target.value)}
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
                  onChange={(e) => session.setVarText((t) => ({ ...t, [v.name]: e.target.value }))}
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
        <p className="md3-body-small md3-run-mode-note">
          Press Run in the bar above (or Enter in a field) to start a run.
        </p>
      </form>

      {session.blockedReason && (
        <PanelError messages={[session.blockedReason]} testId="run-blocked" />
      )}
      {session.error && <PanelError messages={[session.error]} testId="run-error" />}

      {state && record && (
        <>
          {record.id !== latest?.id && (
            <p className="md3-body-small md3-run-mode-note" data-testid="run-earlier">
              Showing an earlier run from {new Date(record.startedAt).toLocaleTimeString()}.
            </p>
          )}
          {record.mode && (
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
                completedWithErrors && summary ? summary.kind : state.status
              }`}
            >
              {completedWithErrors && summary ? summary.label : state.status}
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
                {entry.error && `: ${shortReason(entry.error)}`}
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
          {(state.status === "rejected" || state.status === "failed") &&
            (reason?.known ? (
              <div className="md3-run-errors md3-runlog__error" data-testid="run-halted">
                <p className="md3-runlog__error-headline">
                  <strong>{reason.headline}</strong>
                  {reason.action && <span> {reason.action}</span>}
                </p>
                <ReasonFix reason={reason} session={session} />
                <details className="md3-runlog__error-detail">
                  <summary>Show technical detail</summary>
                  <pre className="md3-runlog__error-raw">{state.error}</pre>
                </details>
              </div>
            ) : (
              <PanelError messages={[`Run ${state.status}: ${state.error}`]} testId="run-halted" />
            ))}
        </>
      )}
    </div>
  );
}

/** A step's failure for the trace list: the plain headline for a kind we know, else the message as it came. */
function shortReason(message: string): string {
  const reason = explainError(message);
  return reason.known ? reason.headline : message;
}

/** The items a loop carried on past (KAM-189): which one, which step failed, and why. */
function FailedItemsTable({
  items,
  rootRef,
}: {
  items: ReturnType<typeof failedItems>;
  rootRef: React.Ref<HTMLDivElement>;
}) {
  const groups = groupFailures(items);
  return (
    <div className="md3-run-errors" data-testid="run-errors" ref={rootRef}>
      {groups.map((g) => (
        <section key={g.reason} className="md3-run-failgroup" data-testid="run-error-group">
          <p className="md3-body-medium md3-run-failgroup__head">
            <strong>
              {g.items.length} {g.items.length === 1 ? "item" : "items"}
            </strong>
            {": "}
            {g.reason}
          </p>
          {g.action && <p className="md3-body-small md3-run-failgroup__action">{g.action}</p>}
          {/* A few failures are shown; many are one fold away, so the panel stays short. */}
          <details className="md3-run-failgroup__items" open={g.items.length <= 3}>
            <summary className="md3-body-small">
              {g.items.length === 1 ? "Show the item" : `Show the ${g.items.length} items`}
            </summary>
            <ul>
              {g.items.map((f) => (
                <li
                  key={`${f.loop}-${f.index}`}
                  data-testid="run-error-row"
                  data-run-step={f.step}
                  data-run-failed=""
                  tabIndex={-1}
                >
                  <span className="md3-run-failgroup__item">
                    {describeItem(f.item) || `#${f.index + 1}`}
                  </span>
                  <span className="md3-body-small md3-run-failgroup__step">
                    {f.loop}
                    {f.step && ` / ${f.step}`}
                  </span>
                  <details className="md3-run-failgroup__raw">
                    <summary className="md3-body-small">Show technical detail</summary>
                    <pre className="md3-code-block">{f.message}</pre>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ))}
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
