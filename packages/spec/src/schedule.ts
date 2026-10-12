// Schedule computation for `agent.trigger: { type: schedule }` (KAN-1856): a 5-field cron expression read
// in an IANA time zone, or a fixed `every` interval. Hand-rolled and dependency-free so it can be
// vendored into an export unchanged and so the spec validator and the engine agree exactly: a copy of this
// file lives at packages/spec/src/schedule.ts and a test keeps the two byte-identical.
//
// Cron syntax: minute hour day-of-month month day-of-week. Each field takes `*`, a number, a range
// `a-b`, a list `a,b,c`, and steps `*/n` or `a-b/n` (`a/n` runs from a to the field's maximum). Months and
// weekdays may be written as three-letter names; weekday 7 is Sunday. When both day-of-month and
// day-of-week are restricted, a day matches if EITHER does (the classic cron rule).
//
// Daylight saving, in a zone that has it:
//  - A wall-clock time that does not exist (the spring-forward gap) fires once, at the first instant after
//    the gap, so a daily 02:30 job still runs that day. Several matches inside one gap collapse into one run.
//  - A wall-clock time that happens twice (the fall-back overlap) fires once, at its first occurrence. A
//    schedule that must tick on every real hour or every N minutes regardless of the clock should use
//    `every`, which counts elapsed time and never looks at the calendar.

export interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  /** Day-of-month / day-of-week were written as `*`: only the other one restricts the day. */
  domAny: boolean;
  dowAny: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  /** Value of the first name (months start at 1, weekdays at 0). */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { label: "day-of-week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

function parseValue(text: string, f: FieldSpec): number | string {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n < f.min || n > f.max) return `${f.label} value ${n} is out of range ${f.min}-${f.max}`;
    return n;
  }
  const idx = f.names?.indexOf(text.toLowerCase()) ?? -1;
  if (idx >= 0) return idx + (f.nameBase ?? 0);
  return `${f.label} has an unrecognised value "${text}"`;
}

function parseField(text: string, f: FieldSpec): ParseResult<Set<number>> {
  const out = new Set<number>();
  if (text === "") return { ok: false, error: `${f.label} is empty` };
  for (const part of text.split(",")) {
    const [range = "", stepText, ...extra] = part.split("/");
    if (extra.length > 0)
      return { ok: false, error: `${f.label} has more than one "/" in "${part}"` };
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        return {
          ok: false,
          error: `${f.label} step "${stepText}" must be a positive whole number`,
        };
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.label === "day-of-week" ? 6 : f.max;
    } else {
      const [a = "", b, ...more] = range.split("-");
      if (more.length > 0) return { ok: false, error: `${f.label} range "${range}" is malformed` };
      const from = parseValue(a, f);
      if (typeof from === "string") return { ok: false, error: from };
      lo = from;
      if (b !== undefined) {
        const to = parseValue(b, f);
        if (typeof to === "string") return { ok: false, error: to };
        hi = to;
        if (hi < lo) return { ok: false, error: `${f.label} range "${range}" runs backwards` };
      } else {
        hi = stepText === undefined ? lo : f.max;
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(f.label === "day-of-week" && v === 7 ? 0 : v);
  }
  return { ok: true, value: out };
}

export function parseCron(expression: string): ParseResult<CronFields> {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `a cron expression has 5 fields (minute hour day-of-month month day-of-week), got ${expression.trim() === "" ? 0 : parts.length}`,
    };
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i]!, FIELDS[i]!);
    if (!r.ok) return r;
    sets.push(r.value);
  }
  const [minute, hour, dom, month, dow] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const fields: CronFields = {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: dom.size === 31,
    dowAny: dow.size === 7,
  };
  // Reject a schedule that can never fire (Feb 30): better a clear error now than a silent no-op.
  if (nextWallTime(fields, Date.UTC(2024, 0, 1)) === undefined) {
    return { ok: false, error: "this cron expression never matches a real date" };
  }
  return { ok: true, value: fields };
}

const EVERY = /^(\d+)\s*(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const MIN_EVERY_MS = 1000;

/** `30s`, `5m`, `2h`, `1d` as milliseconds; at least one second. */
export function parseEvery(text: string): ParseResult<number> {
  const m = EVERY.exec(text.trim());
  if (!m)
    return {
      ok: false,
      error: `"${text}" is not an interval: use a number and s, m, h or d (e.g. 15m)`,
    };
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(ms) || ms < MIN_EVERY_MS) {
    return { ok: false, error: `an interval must be at least 1s` };
  }
  return { ok: true, value: ms };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (tz === "" || tz !== tz.trim()) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at an instant, in ms (local wall clock minus UTC). */
function offsetAt(tz: string, instant: number): number {
  const secs = Math.floor(instant / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(secs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return wall - secs;
}

/** The instant a local wall-clock time (given as UTC-epoch ms) happens; see the DST notes above. */
function wallToInstant(tz: string, wall: number): number {
  const before = offsetAt(tz, wall - 86_400_000);
  const after = offsetAt(tz, wall + 86_400_000);
  const matches = [...new Set([before, after])]
    .map((off) => wall - off)
    .filter((t) => offsetAt(tz, t) === wall - t);
  if (matches.length > 0) return Math.min(...matches);
  // Inside a spring-forward gap: the first instant on the new offset.
  let lo = wall - 36 * 3_600_000;
  let hi = wall + 36 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(tz, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

function dayMatches(c: CronFields, y: number, mo: number, d: number): boolean {
  const domHit = c.dom.has(d);
  const dowHit = c.dow.has(new Date(Date.UTC(y, mo, d)).getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowHit;
  if (c.dowAny) return domHit;
  return domHit || dowHit;
}

const SEARCH_YEARS = 8;

/** The next wall-clock minute (UTC-epoch ms, zone-less) strictly after `afterWall` that the fields match. */
function nextWallTime(c: CronFields, afterWall: number): number | undefined {
  const start = new Date(afterWall);
  let y = start.getUTCFullYear();
  let mo = start.getUTCMonth();
  let d = start.getUTCDate();
  let h = start.getUTCHours();
  let mi = start.getUTCMinutes() + 1;
  const endYear = y + SEARCH_YEARS;
  while (y <= endYear) {
    if (mi > 59) {
      mi = 0;
      h++;
    }
    if (h > 23) {
      h = 0;
      mi = 0;
      d++;
    }
    if (d > new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()) {
      d = 1;
      h = 0;
      mi = 0;
      mo++;
    }
    if (mo > 11) {
      mo = 0;
      d = 1;
      h = 0;
      mi = 0;
      y++;
      continue;
    }
    if (!c.month.has(mo + 1)) {
      mo++;
      d = 1;
      h = 0;
      mi = 0;
      continue;
    }
    if (!dayMatches(c, y, mo, d)) {
      d++;
      h = 0;
      mi = 0;
      continue;
    }
    if (!c.hour.has(h)) {
      h++;
      mi = 0;
      continue;
    }
    if (!c.minute.has(mi)) {
      mi++;
      continue;
    }
    return Date.UTC(y, mo, d, h, mi);
  }
  return undefined;
}

/** The next time a cron schedule fires strictly after `after` (epoch ms), read in `tz`. */
export function nextCronRun(cron: CronFields, tz: string, after: number): number | undefined {
  let wall = after + offsetAt(tz, after);
  for (let guard = 0; guard < 10_000; guard++) {
    const next = nextWallTime(cron, wall);
    if (next === undefined) return undefined;
    const instant = wallToInstant(tz, next);
    if (instant > after) return instant;
    // A repeated or collapsed wall time resolved to an instant we are already past: keep looking.
    wall = next;
  }
  return undefined;
}

export type Schedule =
  { kind: "cron"; cron: CronFields; tz: string } | { kind: "every"; ms: number };

export interface ScheduleSpec {
  cron?: string | undefined;
  every?: string | undefined;
  tz?: string | undefined;
}

/** Validates a trigger's schedule fields and builds the schedule; the error is one human-readable line. */
export function buildSchedule(spec: ScheduleSpec): ParseResult<Schedule> {
  if ((spec.cron === undefined) === (spec.every === undefined)) {
    return { ok: false, error: "set exactly one of cron or every" };
  }
  if (spec.every !== undefined) {
    if (spec.tz !== undefined) return { ok: false, error: "tz only applies to cron" };
    const r = parseEvery(spec.every);
    return r.ok ? { ok: true, value: { kind: "every", ms: r.value } } : r;
  }
  const tz = spec.tz ?? "UTC";
  if (!isValidTimeZone(tz)) {
    return { ok: false, error: `"${tz}" is not a known IANA time zone (e.g. Asia/Singapore)` };
  }
  const r = parseCron(spec.cron!);
  return r.ok ? { ok: true, value: { kind: "cron", cron: r.value, tz } } : r;
}

/** The first tick strictly after `after` (epoch ms). `every` ticks are anchored at `anchor`. */
export function nextTick(schedule: Schedule, after: number, anchor = 0): number {
  if (schedule.kind === "every") {
    return anchor + (Math.floor((after - anchor) / schedule.ms) + 1) * schedule.ms;
  }
  const next = nextCronRun(schedule.cron, schedule.tz, after);
  if (next === undefined) throw new Error("schedule has no further run");
  return next;
}
