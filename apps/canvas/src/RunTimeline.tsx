import { useEffect, useMemo, useState } from "react";
import type { RunTrace } from "./api.js";
import {
  buildTimeline,
  formatCost,
  formatDuration,
  formatTokens,
  STATUS_WORD,
  type TimelineRow,
} from "./runTrace.js";

// The Timeline view of the run log (KAM-258, ADR-0063): a plain-words summary on top, then one bar per step and
// model call on a shared time axis, with the tokens and cost beside each. It only draws what the server's trace
// says; it never re-runs or edits anything.

const KIND_CLASS: Partial<Record<TimelineRow["kind"], string>> = {
  llm: "ai",
  model: "ai",
  tool: "tool",
  condition: "flow",
  branch: "flow",
  foreach: "flow",
  stop: "flow",
  approval: "approval",
  transform: "data",
  validate: "guard",
  dedupe: "guard",
};

/** Reads the run's trace: once it ends, and every second while it goes (or waits on a person). */
export function useRunTrace(
  fetchTrace: ((id: string) => Promise<RunTrace | undefined>) | undefined,
  runId: string | undefined,
  runStatus: string | undefined,
): { trace: RunTrace | undefined; loaded: boolean } {
  const [trace, setTrace] = useState<RunTrace | undefined>();
  const [loaded, setLoaded] = useState(false);
  const live = runStatus === "running" || runStatus === "awaiting_approval";

  useEffect(() => {
    setTrace(undefined);
    setLoaded(false);
  }, [runId]);

  useEffect(() => {
    if (!fetchTrace || !runId) return;
    let cancelled = false;
    const read = () =>
      fetchTrace(runId)
        .then((t) => {
          if (cancelled) return;
          setTrace(t);
          setLoaded(true);
        })
        .catch(() => !cancelled && setLoaded(true));
    void read();
    if (!live) return () => void (cancelled = true);
    const timer = setInterval(() => void read(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchTrace, runId, runStatus, live]);

  return { trace, loaded };
}

export function RunTimeline({
  trace,
  loaded,
  live,
  replay = false,
  omitFailure = false,
}: {
  trace: RunTrace | undefined;
  loaded: boolean;
  live: boolean;
  replay?: boolean;
  omitFailure?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  // A running span is measured against the clock, which ticks while the run is on.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [live]);
  const timeline = useMemo(
    () => (trace ? buildTimeline(trace, now, { replay, showAll, omitFailure }) : undefined),
    [trace, now, replay, showAll, omitFailure],
  );

  if (!trace || !timeline) {
    return (
      <p className="md3-body-small md3-runlog__note" data-testid="run-timeline-empty">
        {loaded
          ? "No timing was kept for this run. Timing is recorded while a run is on, so it is gone once the server forgets the run."
          : "Loading timing…"}
      </p>
    );
  }

  return (
    <div className="md3-timeline" data-testid="run-timeline">
      <ul className="md3-timeline__facts" aria-label="What happened in this run">
        {timeline.facts.map((fact, i) => (
          <li
            key={i}
            className={`md3-body-medium md3-timeline__fact md3-timeline__fact--${fact.tone}`}
            data-testid="run-timeline-fact"
          >
            {fact.text}
          </li>
        ))}
      </ul>
      <div className="md3-timeline__totals md3-body-small" data-testid="run-timeline-totals">
        <span>{formatDuration(timeline.totalMs)} in all</span>
        {timeline.modelCalls > 0 && (
          <span>
            {timeline.modelCalls} model {timeline.modelCalls === 1 ? "call" : "calls"}
          </span>
        )}
        {timeline.tokens > 0 && <span>{formatTokens(timeline.tokens)} tokens</span>}
        {timeline.costUsd !== undefined && <span>{formatCost(timeline.costUsd)}</span>}
      </div>
      <button
        type="button"
        className="md3-button md3-button-text md3-timeline__more"
        aria-pressed={showAll}
        onClick={() => setShowAll((v) => !v)}
      >
        {showAll ? "Show fewer steps" : "Show every step"}
      </button>
      <ol className="md3-timeline__rows" aria-label="Steps and model calls over time">
        {timeline.rows.map((row) => (
          <li
            key={row.id}
            className={`md3-timeline__row md3-timeline__row--${row.status}`}
            data-testid="run-timeline-row"
            data-row-status={row.status}
            data-row-kind={row.kind}
          >
            <div
              className="md3-timeline__label"
              style={{ paddingLeft: `${row.depth * 1.25}rem` }}
              title={row.error}
            >
              <span className="md3-label-medium md3-timeline__name">{row.label}</span>
              <span className="md3-body-small md3-timeline__kind">
                {row.kindLabel}
                {row.note && ` · ${row.note}`}
              </span>
            </div>
            <div className="md3-timeline__track" aria-hidden="true">
              <span
                className={`md3-timeline__bar md3-timeline__bar--${KIND_CLASS[row.kind] ?? "data"}`}
                style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
              />
            </div>
            <div className="md3-body-small md3-timeline__figures">
              <span>
                {row.statusWord ?? STATUS_WORD[row.status]}
                {row.durationMs !== undefined && ` · ${formatDuration(row.durationMs)}`}
              </span>
              {row.waitedMs !== undefined && (
                <span>{formatDuration(row.waitedMs)} waiting for a person</span>
              )}
              {row.tokens !== undefined && <span>{formatTokens(row.tokens)} tokens</span>}
              {row.costUsd !== undefined && <span>{formatCost(row.costUsd)}</span>}
              {row.approximate && <span>step is approximate</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
