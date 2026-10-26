import { useEffect, useMemo, useRef, useState } from "react";
import { buildRunLog, rowForStep, type LogRow } from "./runLog.js";
import type { RunSession } from "./runSession.js";
import { STATUS_ICON, STATUS_LABEL } from "./runStatus.js";
import { useRunTracker } from "./runTracker.js";

// The bottom run log (KAM-243): one row per step, and per item inside a loop, with its status and time; the row
// picked shows its Input, Output and Error. It reads the run on show, live or replayed, and a failed node on the
// canvas picks its row. Nothing here edits data or re-runs a step.

type Tab = "input" | "output" | "error";

const TABS: { id: Tab; label: string }[] = [
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "error", label: "Error" },
];

function show(value: unknown): string {
  return value === undefined ? "" : (JSON.stringify(value, null, 2) ?? String(value));
}

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null: the tab the row suggests (Error for a failed one, else Output) until a tab is picked.
  const [pickedTab, setTab] = useState<Tab | null>(null);
  const selected: LogRow | undefined =
    rows.find((r) => r.id === selectedId) ?? rows.find((r) => r.status === "failed") ?? rows[0];
  const tab: Tab = pickedTab ?? (selected?.status === "failed" ? "error" : "output");

  // The row picked, a failed one by default, is brought into view in a long list.
  const pickedRow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    pickedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected?.id, open]);

  function pick(row: LogRow) {
    setSelectedId(row.id);
    setTab(null);
  }

  // Another run on show starts with its own first failure, or its first row.
  useEffect(() => setSelectedId(null), [record?.id]);

  // A failed node on the canvas asks for its message: pick its row.
  const request = tracker?.messageRequest ?? null;
  useEffect(() => {
    if (!request) return;
    const row = rowForStep(rows, request.nodeId.replace(/^workflow:/, ""));
    if (row) pick(row);
    // Only a new request moves the pick, not a row arriving while the run goes on.
  }, [request]);

  if (!record) return null;
  const errors = rows.filter((r) => r.status === "failed").length;
  const state = record.state;
  const finished = state.status === "completed" || state.status === "failed";
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
        <span className="md3-body-small md3-runlog__summary" data-testid="run-log-summary">
          Started {new Date(record.startedAt).toLocaleTimeString()}
          {ended !== undefined && ` · ${duration(ended)}`} · {rows.length}{" "}
          {rows.length === 1 ? "step" : "steps"}
          {errors > 0 && ` · ${errors} ${errors === 1 ? "error" : "errors"}`}
          {!finished && state.status === "running" && " · running"}
        </span>
        <button
          type="button"
          className="md3-runlog__toggle"
          aria-expanded={open}
          aria-label={open ? "Collapse run log" : "Expand run log"}
          data-testid="run-log-toggle"
          onClick={onToggle}
        >
          <span aria-hidden="true">{open ? "▾" : "▴"}</span>
        </button>
      </header>
      {open && (
        <div className="md3-runlog__body">
          <ul className="md3-runlog__rows" aria-label="Steps in this run">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  ref={selected?.id === row.id ? pickedRow : null}
                  className={`md3-runlog__row md3-runlog__row--${row.status}`}
                  style={{ paddingLeft: `${0.75 + row.depth * 1.25}rem` }}
                  aria-current={selected?.id === row.id}
                  data-testid="run-log-row"
                  data-run-step={row.step}
                  data-row-status={row.status}
                  onClick={() => pick(row)}
                >
                  <span className="md3-runlog__dot" aria-hidden="true">
                    {STATUS_ICON[row.status]}
                  </span>
                  <span className="md3-runlog__name">{row.label}</span>
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
                <div className="md3-runlog__tabs" role="tablist" aria-label="Step data">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      data-testid={`run-log-tab-${t.id}`}
                      onClick={() => setTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <div role="tabpanel" className="md3-runlog__panel">
                {tab === "input" && (
                  <>
                    <p className="md3-body-small md3-runlog__note">
                      What the step could read: the run's input and the results before it.
                    </p>
                    <pre className="md3-code-block" data-testid="run-log-input">
                      {show(selected.input)}
                    </pre>
                  </>
                )}
                {tab === "output" &&
                  (selected.output !== undefined ? (
                    <pre className="md3-code-block" data-testid="run-log-output">
                      {show(selected.output)}
                    </pre>
                  ) : (
                    <p className="md3-body-small md3-runlog__note">No output for this step.</p>
                  ))}
                {tab === "error" &&
                  (selected.error !== undefined ? (
                    <div className="md3-runlog__error" data-testid="run-log-error">
                      {selected.error}
                    </div>
                  ) : (
                    <p className="md3-body-small md3-runlog__note">This step did not fail.</p>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
