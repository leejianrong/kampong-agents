import { useMemo } from "react";
import { previewSchedule } from "@kampong/spec";

// Under a schedule field (KAM-197): what the schedule means, when it would next run, and a warning when it runs
// at least once a minute. It reads the same parser the save uses, and says nothing while the text is not yet a
// schedule (half-typed, or wrong): the save reports that, so a problem is shown once, not as the person types.

/** One run time as people read it, in the zone the schedule is read in: "Thu 22 Oct, 09:00". */
export function formatRun(ms: number, timeZone: string): string {
  // Composed from the parts, so the shape does not depend on a browser's idea of where commas go.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${at("weekday")} ${at("day")} ${at("month")}, ${at("hour")}:${at("minute")}`;
}

/** An interval as people say it: "every 90 seconds", "every 15 minutes", "every 2 hours". */
export function describeInterval(ms: number): string {
  const [n, unit] =
    ms % 86_400_000 === 0
      ? [ms / 86_400_000, "day"]
      : ms % 3_600_000 === 0
        ? [ms / 3_600_000, "hour"]
        : ms % 60_000 === 0
          ? [ms / 60_000, "minute"]
          : [ms / 1000, "second"];
  return `every ${n === 1 ? unit : `${n} ${unit}s`}`;
}

export interface SchedulePreviewNoteProps {
  cron?: string | undefined;
  every?: string | undefined;
  tz?: string | undefined;
  /** `now` is a seam for tests. */
  now?: number;
}

export function SchedulePreviewNote({ cron, every, tz, now }: SchedulePreviewNoteProps) {
  const text = cron ?? every ?? "";
  const tzText = tz?.trim();
  const result = useMemo(() => {
    if (text.trim() === "") return null;
    return previewSchedule(
      cron !== undefined ? { cron, ...(tzText ? { tz: tzText } : {}) } : { every },
      now ?? Date.now(),
    );
  }, [cron, every, tzText, text, now]);
  if (!result?.ok) return null;
  const { preview } = result;
  return (
    <div className="md3-schedule-preview" data-testid="schedule-preview" aria-live="polite">
      {preview.intervalMs !== undefined ? (
        <p className="md3-body-small md3-field__hint">
          Runs {describeInterval(preview.intervalMs)}.
        </p>
      ) : (
        <>
          {preview.description && (
            <p className="md3-body-small md3-field__hint" data-testid="schedule-words">
              Runs {preview.description}.
            </p>
          )}
          <p className="md3-body-small md3-field__hint" data-testid="schedule-next">
            Next runs ({preview.timeZone}):{" "}
            {preview.runs.map((r) => formatRun(r, preview.timeZone!)).join("; ")}
          </p>
        </>
      )}
      {preview.warning && (
        <p
          className="md3-body-small md3-field__warning"
          role="status"
          data-testid="schedule-warning"
        >
          <span aria-hidden="true">⚠ </span>
          {preview.warning}
        </p>
      )}
    </div>
  );
}
