import { useEffect, useMemo, useRef, useState } from "react";
import { buildRunLog, loopStates, rowForStep, visibleRows, type LogRow } from "./runLog.js";
import type { RunSession } from "./runSession.js";
import { STATUS_ICON, STATUS_LABEL } from "./runStatus.js";
import { useRunTracker } from "./runTracker.js";
import { RunTimeline, useRunTrace } from "./RunTimeline.js";
import { outcomeOf } from "./runOutcome.js";
import { summarizeRun } from "./runSummary.js";
import { DataFields, isEmptyData } from "./DataFields.js";
import { explainError, trimUrls } from "./runReason.js";
import { nextRow, tabListKeys } from "./tabKeys.js";

// The bottom run log (KAM-243): one row per step, and per item inside a loop, with its status and time; the row
// picked shows its Input, Output and Error. It reads the run on show, live or replayed, and a failed node on the
// canvas picks its row. Nothing here edits data or re-runs a step.

type Tab = "input" | "output" | "error";
type View = "steps" | "timeline";

const TABS: { id: Tab; label: string }[] = [
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "error", label: "Error" },
];

function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function RunLog({
  session,
  open,
  onToggle,
}: {
  session: RunSession;
  open: boolean;
  onToggle: () => void;
}) {
  const record = session.viewed;
  const tracker = useRunTracker();
  const rows = useMemo(
    () => (record ? buildRunLog(record.tracker, record.input) : []),
    [record?.tracker, record?.input],
  );
  const [view, setView] = useState<View>("steps");
  // KAM-269: a loop's items sit under its row, closed unless one of them failed (or is the row on show).
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null: the tab the row suggests (Error for a failed one, else Output) until a tab is picked.
  const [pickedTab, setTab] = useState<Tab | null>(null);
  const selected: LogRow | undefined =
    rows.find((r) => r.id === selectedId) ?? rows.find((r) => r.status === "failed") ?? rows[0];
  // KAM-271: an Input that is only the run's empty input says nothing, so the tab is left out.
  const tabs = TABS.filter((t) => t.id !== "input" || (selected && !isEmptyData(selected.input)));
  const wanted: Tab = pickedTab ?? (selected?.status === "failed" ? "error" : "output");
  const tab: Tab = tabs.some((t) => t.id === wanted) ? wanted : "output";
  const viewButtons = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});
  const tabButtons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const rowButtons = useRef<Map<string, HTMLButtonElement>>(new Map());

  const loops = useMemo(() => loopStates(rows, opened, selected?.id), [rows, opened, selected?.id]);
  const visible = useMemo(() => visibleRows(rows, loops), [rows, loops]);

  const { trace, loaded } = useRunTrace(
    session.fetchTrace,
    open && view === "timeline" ? record?.id : undefined,
    record?.state.status,
  );

  // The row picked, a failed one by default, is brought into view in a long list.
  const pickedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    pickedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected?.id, open]);

  function toggleLoop(id: string) {
    setOpened((was) => {
      const next = new Set(was);
      if (loops.get(id)?.open) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function pick(row: LogRow) {
    setSelectedId(row.id);
    setTab(null);
  }

  // Another run on show starts with its own first failure, or its first row.
  useEffect(() => {
    setSelectedId(null);
    setOpened(new Set());
  }, [record?.id]);

  // A failed node on the canvas asks for its message: pick its row.
  const request = tracker?.messageRequest ?? null;
  useEffect(() => {
    if (!request) return;
    const row = rowForStep(rows, request.nodeId.replace(/^workflow:/, ""));
    if (row) pick(row);
    // Only a new request moves the pick, not a row arriving while the run goes on.
  }, [request]);

  if (!record) return null;
  const state = record.state;
  const summary = summarizeRun(state);
  const outcome = outcomeOf(state, rows);
  const topSteps = rows.filter((r) => r.depth === 0).length;
  const ended = record.endedAt !== undefined ? record.endedAt - record.startedAt : undefined;

  return (
    <section className="md3-runlog" aria-label="Run log" data-testid="run-log" data-open={open}>
      <header className="md3-runlog__head">
        <h2 className="md3-label-large md3-runlog__title">Run log</h2>
        {record.mode && (
          <span className={`md3-status-pill md3-run-mode md3-run-mode--${record.mode}`}>
            {record.mode === "live" ? "LIVE" : "Replay · recorded data"}
          </span>
        )}
        <span
          className={`md3-status-pill md3-status-pill--${summary.kind} md3-runlog__outcome-pill`}
          data-testid="run-log-summary"
          title={`Started ${new Date(record.startedAt).toLocaleTimeString()}${
            ended !== undefined ? ` · ${duration(ended)}` : ""
          } · ${topSteps} ${topSteps === 1 ? "step" : "steps"}`}
        >
          <span aria-hidden="true">{summary.icon}</span> {summary.label}
        </span>
        {session.fetchTrace && (
          <div
            className="md3-runlog__views"
            role="tablist"
            aria-label="Run log view"
            onKeyDown={tabListKeys(
              ["steps", "timeline"] as const,
              view,
              (id) => {
                setView(id);
                if (!open) onToggle();
              },
              (id) => viewButtons.current[id] ?? null,
            )}
          >
            {(
              [
                ["steps", "Steps"],
                ["timeline", "Timeline"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                ref={(el) => {
                  viewButtons.current[id] = el;
                }}
                id={`run-log-view-tab-${id}`}
                aria-selected={view === id}
                tabIndex={view === id ? 0 : -1}
                data-testid={`run-log-view-${id}`}
                onClick={() => {
                  setView(id);
                  if (!open) onToggle();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="md3-runlog__toggle"
          aria-expanded={open}
          aria-label={open ? "Collapse run log" : "Expand run log"}
          data-testid="run-log-toggle"
          onClick={onToggle}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
            <path
              d={
                open
                  ? "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"
                  : "M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"
              }
              fill="currentColor"
            />
          </svg>
        </button>
      </header>
      {open && (
        <p
          className={`md3-runlog__outcome md3-runlog__outcome--${outcome.tone}`}
          data-testid="run-log-outcome"
        >
          <strong>{outcome.headline}</strong>
          {outcome.detail && <span> {outcome.detail}</span>}
        </p>
      )}
      {open && (
        <div
          className="md3-runlog__body"
          data-view={view}
          {...(session.fetchTrace && {
            role: "tabpanel",
            "aria-labelledby": `run-log-view-tab-${view}`,
          })}
        >
          {view === "timeline" ? (
            <RunTimeline
              trace={trace}
              loaded={loaded}
              live={state.status === "running" || state.status === "awaiting_approval"}
              replay={record.mode === "replay"}
              omitFailure
            />
          ) : (
            <>
              <ul
                className="md3-runlog__rows"
                aria-label="Steps in this run"
                onKeyDown={(event) => {
                  const at = visible.findIndex((r) => r.id === selected?.id);
                  const loop = selected ? loops.get(selected.id) : undefined;
                  // Right opens a loop and Left closes it, as in a tree.
                  if (loop && event.key === (loop.open ? "ArrowLeft" : "ArrowRight")) {
                    event.preventDefault();
                    toggleLoop(selected!.id);
                    return;
                  }
                  const to = nextRow(event.key, visible.length, at < 0 ? 0 : at);
                  const row = to === undefined ? undefined : visible[to];
                  if (!row) return;
                  event.preventDefault();
                  pick(row);
                  rowButtons.current.get(row.id)?.focus();
                }}
              >
                {visible.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) rowButtons.current.set(row.id, el);
                        else rowButtons.current.delete(row.id);
                        if (selected?.id === row.id) pickedRow.current = el;
                      }}
                      tabIndex={selected?.id === row.id ? 0 : -1}
                      className={`md3-runlog__row md3-runlog__row--${row.status}`}
                      style={{ paddingLeft: `${0.75 + row.depth * 1.25}rem` }}
                      aria-current={selected?.id === row.id}
                      data-testid="run-log-row"
                      data-run-step={row.step}
                      data-row-status={row.status}
                      {...(loops.get(row.id) && { "aria-expanded": loops.get(row.id)!.open })}
                      onClick={() => {
                        pick(row);
                        if (loops.has(row.id)) toggleLoop(row.id);
                      }}
                    >
                      <span className="md3-runlog__dot" aria-hidden="true">
                        {STATUS_ICON[row.status]}
                      </span>
                      <span className="md3-runlog__name">{row.label}</span>
                      {loops.get(row.id) && (
                        <span className="md3-body-small md3-runlog__items">
                          {loops.get(row.id)!.summary}
                        </span>
                      )}
                      <span className="md3-visually-hidden">{STATUS_LABEL[row.status]}</span>
                      <span className="md3-body-small md3-runlog__time">
                        {duration(row.durationMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {selected && (
                <div className="md3-runlog__detail" data-testid="run-log-detail">
                  <div className="md3-runlog__detail-head">
                    <h3 className="md3-label-large">{selected.label}</h3>
                    <span className={`md3-runlog__chip md3-runlog__chip--${selected.status}`}>
                      {STATUS_LABEL[selected.status]}
                    </span>
                    <div
                      className="md3-runlog__tabs"
                      role="tablist"
                      aria-label="Step data"
                      onKeyDown={tabListKeys(
                        tabs.map((t) => t.id),
                        tab,
                        (id) => setTab(id),
                        (id) => tabButtons.current[id] ?? null,
                      )}
                    >
                      {tabs.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          ref={(el) => {
                            tabButtons.current[t.id] = el;
                          }}
                          id={`run-log-tab-btn-${t.id}`}
                          aria-controls="run-log-data-panel"
                          aria-selected={tab === t.id}
                          tabIndex={tab === t.id ? 0 : -1}
                          data-testid={`run-log-tab-${t.id}`}
                          onClick={() => setTab(t.id)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div
                    role="tabpanel"
                    id="run-log-data-panel"
                    aria-labelledby={`run-log-tab-btn-${tab}`}
                    tabIndex={0}
                    className="md3-runlog__panel"
                  >
                    {tab === "input" && (
                      <>
                        <p className="md3-body-small md3-runlog__note">
                          What the step could read: the run's input and the results before it.
                        </p>
                        <DataFields value={selected.input} testId="run-log-input" />
                      </>
                    )}
                    {tab === "output" &&
                      (selected.output !== undefined ? (
                        <DataFields value={selected.output} testId="run-log-output" />
                      ) : (
                        <p className="md3-body-small md3-runlog__note">No output for this step.</p>
                      ))}
                    {tab === "error" &&
                      (selected.error !== undefined ? (
                        <ErrorDetail message={selected.error} />
                      ) : (
                        <p className="md3-body-small md3-runlog__note">This step did not fail.</p>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** KAM-270: what went wrong and what to do in a line each; the raw message is behind "Show technical detail". */
function ErrorDetail({ message }: { message: string }) {
  const reason = explainError(message);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard: the detail below can still be selected.
    }
  }
  return (
    <div className="md3-runlog__error" data-testid="run-log-error">
      <p className="md3-runlog__error-headline">
        <strong>{reason.headline}</strong>
        {reason.action && <span> {reason.action}</span>}
      </p>
      <details className="md3-runlog__error-detail">
        <summary>Show technical detail</summary>
        <pre className="md3-runlog__error-raw">{trimUrls(message)}</pre>
        <button type="button" className="md3-button md3-button-text" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy the full message"}
        </button>
      </details>
    </div>
  );
}
