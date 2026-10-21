import { buildSchedule, nextTick, type CronFields } from "./schedule.js";

// What the Trigger form tells a person about a schedule as they type it (KAM-197): the words for it, the next
// three times it would run, and a warning when it runs more often than anyone usually means. It reads the same
// parser the engine and the validator use (schedule.ts), so a schedule that previews fine is one that will load.

export interface SchedulePreview {
  /** The schedule in words, when it is a shape that has a plain reading ("every day at 09:00"). */
  description?: string;
  /** The next runs (epoch ms), soonest first: up to three. For `every`, ticks counted from `now`. */
  runs: number[];
  /** The time zone the runs are read in (cron), or null for `every`, which ignores the calendar. */
  timeZone: string | null;
  /** For `every`: the interval in milliseconds. */
  intervalMs?: number;
  /** Set when it runs at least once a minute: more than most schedules mean, and each run can cost money. */
  warning?: string;
}

export type SchedulePreviewResult =
  { ok: true; preview: SchedulePreview } | { ok: false; error: string };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const two = (n: number) => String(n).padStart(2, "0");

function sorted(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function isRange(values: number[], from: number, to: number): boolean {
  return values.length === to - from + 1 && values[0] === from && values[values.length - 1] === to;
}

/** A cron in plain words for the common shapes, or undefined for one that has no short reading. */
export function describeCron(fields: CronFields): string | undefined {
  const minutes = sorted(fields.minute);
  const hours = sorted(fields.hour);
  const everyDay = fields.domAny && fields.month.size === 12;
  const days = fields.dowAny
    ? ""
    : isRange(sorted(fields.dow), 1, 5)
      ? " on weekdays"
      : sorted(fields.dow).join(",") === "0,6"
        ? " on weekends"
        : ` on ${sorted(fields.dow)
            .map((d) => DAY_NAMES[d])
            .join(", ")}`;
  if (!everyDay) return undefined;
  if (minutes.length === 60 && hours.length === 24) return `every minute${days}`;
  if (hours.length === 24 && minutes.length > 1) {
    const step = minutes[1]! - minutes[0]!;
    if (minutes[0] === 0 && minutes.every((m, i) => m === i * step) && 60 % step === 0) {
      return `every ${step} minutes${days}`;
    }
    return undefined;
  }
  if (hours.length === 24 && minutes.length === 1) {
    return `at minute ${minutes[0]} of every hour${days}`;
  }
  if (minutes.length === 1 && hours.length === 1) {
    return `at ${two(hours[0]!)}:${two(minutes[0]!)}${days || " every day"}`;
  }
  if (minutes.length === 1 && hours.length <= 6) {
    return `at ${hours.map((h) => `${two(h)}:${two(minutes[0]!)}`).join(", ")}${days || " every day"}`;
  }
  return undefined;
}

const SEC = 1000;

/**
 * The preview of one schedule as the form holds it: `cron` (with an optional time zone) or `every`. A schedule that
 * would not load is an error in the validator's own words, so the form says the same thing the save would.
 */
export function previewSchedule(
  schedule: { cron?: string | undefined; every?: string | undefined; tz?: string | undefined },
  now: number,
): SchedulePreviewResult {
  const built = buildSchedule(schedule);
  if (!built.ok) return { ok: false, error: built.error };
  const runs: number[] = [];
  let at = now;
  for (let i = 0; i < 3; i++) {
    try {
      at = nextTick(built.value, at, now);
    } catch {
      break;
    }
    runs.push(at);
  }
  if (built.value.kind === "every") {
    const ms = built.value.ms;
    const seconds = ms / SEC;
    return {
      ok: true,
      preview: {
        runs,
        timeZone: null,
        intervalMs: ms,
        ...(ms < 60 * SEC && {
          warning: `This runs every ${seconds} second${seconds === 1 ? "" : "s"}, more than once a minute. Every run can call models and services, so cost and rate limits add up fast. Most schedules mean minutes or hours.`,
        }),
      },
    };
  }
  const description = describeCron(built.value.cron);
  const everyMinute =
    runs.length >= 2 && runs.every((r, i) => i === 0 || r - runs[i - 1]! <= 60 * SEC);
  return {
    ok: true,
    preview: {
      ...(description !== undefined && { description }),
      runs,
      timeZone: built.value.tz,
      ...(everyMinute && {
        warning:
          "This runs every minute. Every run can call models and services, so cost and rate limits add up fast. Most schedules mean hourly or daily.",
      }),
    },
  };
}
