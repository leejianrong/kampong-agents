import type { RunTrace, SpanKind, SpanStatus, TraceSpan } from "./api.js";

// ADR-0063 / KAM-258: turns a run's trace into what the Timeline view draws: one bar per span, placed on a shared
// time axis, and a few plain-words facts (what was slow, what used the most, what failed) so a person need not
// read the bars to answer "what happened?". Pure: the component only renders this.

export interface TimelineRow {
  id: string;
  label: string;
  /** What kind of span, in a word a non-engineer knows. */
  kindLabel: string;
  kind: SpanKind;
  status: SpanStatus;
  depth: number;
  /** Where the bar starts and how wide it is, as a share of the whole run. */
  leftPct: number;
  widthPct: number;
  durationMs?: number;
  /** Time spent waiting for a person (an approval); the rest is the step's own time. */
  waitedMs?: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
  /** True for a model call whose step could not be told for sure (steps running at the same time). */
  approximate?: boolean;
  /** The status in words when the bare status would mislead ("Done, 1 of 10 failed" for a loop). */
  statusWord?: string;
  /** A loop's size in words: "10 items". */
  note?: string;
  /** For a row that stands for several (the same step failing on many items): each one, for the expander. */
  group?: TimelineRow[];
}

export interface TimelineOptions {
  /** A Replay run: there are no real tokens or prices to say anything about. */
  replay?: boolean;
  /** The run log's banner already says what failed; leave that line out of the facts. */
  omitFailure?: boolean;
  /** List every step of a loop, not just the ones that failed. */
  showAll?: boolean;
  /** Step id to plain-words title (KAM-301), so a row reads as the person named the step. */
  titles?: Readonly<Record<string, string>>;
  /** The item a loop step ran on, by the span's name (`each[2].fetch`), when the run says (a failed item). */
  itemValue?: (spanName: string) => string | undefined;
}

export interface Fact {
  tone: "info" | "warn" | "error";
  text: string;
}

export interface Timeline {
  rows: TimelineRow[];
  totalMs: number;
  facts: Fact[];
  /** Totals for the header. */
  tokens: number;
  modelCalls: number;
  costUsd?: number;
}

const KIND_LABEL: Record<SpanKind, string> = {
  run: "Run",
  model: "AI call",
  llm: "AI step",
  tool: "Tool",
  condition: "Condition",
  approval: "Approval",
  transform: "Prepare data",
  validate: "Check",
  dedupe: "Skip repeats",
  foreach: "Loop",
  branch: "Branch",
  stop: "Stop",
  step: "Step",
};

export const STATUS_WORD: Record<SpanStatus, string> = {
  running: "Running",
  ok: "Done",
  error: "Failed",
  rejected: "Rejected",
  paused: "Waiting for approval",
};

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Keeps a long error (a provider's whole notice) to a line; the full text stays in the Steps view. */
const shorten = (text: string, max = 140): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export const formatTokens = (n: number): string => n.toLocaleString("en-US");

const tokensOf = (s: TraceSpan): number | undefined =>
  s.usage ? (s.usage.inputTokens ?? 0) + (s.usage.outputTokens ?? 0) : undefined;

/** A span with the time it was running, using `now` for one still going. */
const elapsed = (s: TraceSpan, now: number): number => (s.endedAt ?? now) - s.startedAt;

/**
 * A step as a person names it: `each[2].fetch` is "fetch, item 3", or with the step's title and the item's value
 * (KAM-301) "Look up the latest price · MSFT".
 */
export function displayName(
  name: string,
  options: Pick<TimelineOptions, "titles" | "itemValue"> = {},
): string {
  const m = /\[(\d+)\]\.([^[\]]*)$/.exec(name);
  const title = (id: string) => options.titles?.[id] ?? id;
  if (!m) return title(name);
  const value = options.itemValue?.(name);
  return `${title(m[2]!)}${value !== undefined ? ` · ${value}` : `, item ${Number(m[1]) + 1}`}`;
}

/** Steps this quick are not worth a number. */
const QUICK_MS = 100;

export function buildTimeline(
  trace: RunTrace,
  now: number = Date.now(),
  options: TimelineOptions = {},
): Timeline {
  const root = trace.spans.find((s) => s.kind === "run") ?? trace.spans[0];
  const begin = root?.startedAt ?? trace.startedAt;
  const totalMs = Math.max(
    1,
    (trace.endedAt ?? Math.max(now, ...trace.spans.map((s) => s.endedAt ?? s.startedAt))) - begin,
  );
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
  const depthOf = (s: TraceSpan): number => {
    let depth = 0;
    for (
      let p = s.parentId ? byId.get(s.parentId) : undefined;
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    ) {
      if (p.kind !== "run") depth++;
    }
    return depth;
  };

  // KAM-274: a loop's items fold into its row, which says how many there were and how many failed; only the
  // items that failed stay listed, unless every step is asked for.
  const insideLoop = (s: TraceSpan): boolean => {
    for (
      let p = s.parentId ? byId.get(s.parentId) : undefined;
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    ) {
      if (p.kind === "foreach") return true;
    }
    return false;
  };
  const ancestors = (s: TraceSpan): TraceSpan[] => {
    const out: TraceSpan[] = [];
    for (
      let p = s.parentId ? byId.get(s.parentId) : undefined;
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    )
      out.push(p);
    return out;
  };
  const failedBelow = (loop: TraceSpan): number => {
    const items = new Set<string>();
    for (const s of trace.spans) {
      if (s.status !== "error" || s.kind === "model" || !ancestors(s).includes(loop)) continue;
      const item = /\[(\d+)\]\./.exec(s.name)?.[1];
      items.add(item ?? s.id);
    }
    return items.size;
  };
  const itemsOf = (loop: TraceSpan): number => {
    const items = new Set<string>();
    for (const s of trace.spans) {
      if (!ancestors(s).includes(loop)) continue;
      const item = /\[(\d+)\]\./.exec(s.name)?.[1];
      if (item !== undefined) items.add(item);
    }
    return items.size;
  };
  const shown = (s: TraceSpan): boolean =>
    s.kind !== "run" &&
    (options.showAll === true || !insideLoop(s) || (s.status === "error" && s.kind !== "model"));

  const shownSpans = trace.spans.filter(shown);
  const built: TimelineRow[] = shownSpans.map((s) => {
    const dur = elapsed(s, now);
    const tokens = tokensOf(s);
    const loop = s.kind === "foreach";
    const failed = loop ? failedBelow(s) : 0;
    const items = loop ? itemsOf(s) : 0;
    const status: SpanStatus = loop && failed > 0 && s.status === "ok" ? "error" : s.status;
    return {
      id: s.id,
      label: s.kind === "model" ? (s.model ?? s.name) : displayName(s.name, options),
      kindLabel: KIND_LABEL[s.kind] ?? "Step",
      kind: s.kind,
      status,
      depth: depthOf(s),
      leftPct: ((s.startedAt - begin) / totalMs) * 100,
      widthPct: Math.max((dur / totalMs) * 100, 0.8),
      ...(s.status !== "running" && dur >= QUICK_MS && { durationMs: dur }),
      ...(s.waitedMs ? { waitedMs: s.waitedMs } : {}),
      ...(tokens !== undefined && { tokens }),
      ...(s.costUsd !== undefined && { costUsd: s.costUsd }),
      ...(s.error !== undefined && { error: s.error }),
      ...(s.attributes?.["attribution"] === "approximate" && { approximate: true }),
      ...(loop && items > 0 && { note: `${items} ${items === 1 ? "item" : "items"}` }),
      ...(loop &&
        failed > 0 &&
        s.status === "ok" && { statusWord: `Done, ${failed} of ${items || failed} failed` }),
    };
  });

  // KAM-301: the same step failing on many items is one row ("Look up the latest price: 23 failed") with the items
  // under an expander, not 23 near-identical bars. Listing every step (showAll) keeps them all as they ran.
  const rows: TimelineRow[] = [];
  if (options.showAll === true) rows.push(...built);
  else {
    const groups = new Map<string, number[]>();
    shownSpans.forEach((s, i) => {
      if (s.status !== "error" || s.kind === "model" || !insideLoop(s)) return;
      const step = /\[\d+\]\.([^[\]]*)$/.exec(s.name)?.[1];
      if (step === undefined) return;
      const key = `${s.parentId ?? ""}|${step}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    const folded = new Set<number>();
    const heads = new Map<number, TimelineRow>();
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const items = members.map((i) => built[i]!);
      const first = items[0]!;
      const step = /\[\d+\]\.([^[\]]*)$/.exec(shownSpans[members[0]!]!.name)![1]!;
      const left = Math.min(...items.map((r) => r.leftPct));
      const right = Math.max(...items.map((r) => r.leftPct + r.widthPct));
      members.forEach((i) => folded.add(i));
      heads.set(members[0]!, {
        ...first,
        id: `${first.id}:failed`,
        label: `${options.titles?.[step] ?? step}: ${items.length} failed`,
        kindLabel: "Failed items",
        leftPct: left,
        widthPct: right - left,
        statusWord: `${items.length} failed`,
        group: items,
      });
    }
    built.forEach((row, i) => {
      const head = heads.get(i);
      if (head) rows.push(head);
      else if (!folded.has(i)) rows.push(row);
    });
  }

  return {
    rows,
    totalMs,
    facts: factsOf(trace, now, options),
    tokens: trace.totals.inputTokens + trace.totals.outputTokens,
    modelCalls: trace.totals.modelCalls,
    ...(trace.totals.costUsd !== undefined && { costUsd: trace.totals.costUsd }),
  };
}

// Containers (a loop, a branch) and model calls are not "a step that was slow": the step that called the model is.
const isStepSpan = (s: TraceSpan): boolean =>
  s.kind !== "run" && s.kind !== "model" && s.kind !== "foreach" && s.kind !== "branch";

function factsOf(trace: RunTrace, now: number, options: TimelineOptions): Fact[] {
  const facts: Fact[] = [];
  const failures = trace.spans.filter(
    (s) => s.kind !== "run" && s.kind !== "model" && s.status === "error",
  );
  const rejected = trace.spans.find((s) => s.status === "rejected");
  const failed = failures[0];
  const detail = (s: TraceSpan) => (s.error ? `: ${shorten(s.error)}` : ".");
  if (options.omitFailure) {
    // Said above, in the run log's banner.
  } else if (failed && trace.status === "error") {
    facts.push({
      tone: "error",
      text: `Stopped at "${displayName(failed.name, options)}"${detail(failed)}`,
    });
  } else if (failed) {
    // The run went on past these (a loop set to continue on error).
    const n = failures.length;
    facts.push({
      tone: "warn",
      text: `${n} ${n === 1 ? "step" : "steps"} failed but the run carried on. First: "${displayName(failed.name, options)}"${detail(failed)}`,
    });
  } else if (rejected) {
    facts.push({
      tone: "warn",
      text: `"${displayName(rejected.name, options)}" was rejected${detail(rejected)}`,
    });
  }

  // Own time, so a step that waited on a person is not called slow.
  const own = (s: TraceSpan) => elapsed(s, now) - (s.waitedMs ?? 0);
  const steps = trace.spans.filter((s) => isStepSpan(s) && s.status !== "running");
  const slowest = steps.reduce<TraceSpan | undefined>(
    (best, s) => (!best || own(s) > own(best) ? s : best),
    undefined,
  );
  if (slowest && steps.length > 1) {
    facts.push({
      tone: "info",
      text: `Slowest step: "${displayName(slowest.name, options)}", ${formatDuration(own(slowest))}.`,
    });
  }

  // Tokens are summed per calling step, since a step may call the model more than once (a retry).
  const perStep = new Map<string, { name: string; tokens: number }>();
  for (const s of trace.spans) {
    if (s.kind !== "model" || !s.parentId) continue;
    const parent = trace.spans.find((p) => p.id === s.parentId);
    if (!parent || parent.kind === "run") continue;
    const entry = perStep.get(parent.id) ?? { name: displayName(parent.name, options), tokens: 0 };
    entry.tokens += tokensOf(s) ?? 0;
    perStep.set(parent.id, entry);
  }
  const heaviest = [...perStep.values()].sort((a, b) => b.tokens - a.tokens)[0];
  if (heaviest && heaviest.tokens > 0 && perStep.size > 1) {
    facts.push({
      tone: "info",
      text: `Used the most: "${heaviest.name}", ${formatTokens(heaviest.tokens)} tokens.`,
    });
  }

  const waited = trace.spans.reduce((sum, s) => sum + (s.waitedMs ?? 0), 0);
  if (waited > 0) {
    facts.push({ tone: "info", text: `Waited ${formatDuration(waited)} for a person to decide.` });
  }

  if (trace.totals.modelCalls > 0 && !options.replay) {
    const tokens = trace.totals.inputTokens + trace.totals.outputTokens;
    if (trace.totals.costUsd !== undefined) {
      facts.push({ tone: "info", text: `Estimated cost ${formatCost(trace.totals.costUsd)}.` });
    } else if (tokens > 0) {
      facts.push({
        tone: "info",
        text: `${formatTokens(tokens)} tokens. No price is set for this model, so there is no cost estimate.`,
      });
    } else {
      facts.push({ tone: "info", text: "This model did not report how many tokens it used." });
    }
  }
  return facts;
}
