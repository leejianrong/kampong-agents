import type { AgentSpec, WorkflowStep } from "@kampong/spec";
import type { AgentRun } from "./run.js";
import type { ModelClient, ModelUsage } from "./model.js";
import type { RunEvent } from "./workflow.js";

// ADR-0063: the trace data model. A run is a tree of spans: one root `run` span, a span per workflow step
// (nested under its foreach), and a `model` span under the step that made the call. The same shape is meant to
// hold a trace ingested from outside Kampong later (OpenTelemetry GenAI spans map onto it), so nothing here is
// specific to a spec except the optional `step`/`specVersion` fields.
//
// The recorder only listens: it reads the run's existing events and wraps the model client, so the workflow
// engine and the exported runtime stay unchanged. Prompts and outputs are not captured; what a trace may hold
// is a privacy decision that is still open (KAM-255).

export type SpanKind =
  | "run"
  | "model"
  | "llm"
  | "tool"
  | "condition"
  | "approval"
  | "transform"
  | "validate"
  | "dedupe"
  | "foreach"
  | "branch"
  | "stop"
  | "step";

export type SpanStatus = "running" | "ok" | "error" | "rejected" | "paused";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface Span {
  id: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
  /** endedAt - startedAt, including any time spent waiting for a human. */
  durationMs?: number;
  /** Time the span spent paused for an approval; durationMs minus this is the machine time. */
  waitedMs?: number;
  error?: string;
  /** Set on a `model` span. */
  model?: string;
  usage?: TokenUsage;
  /** Estimated from `pricing`; absent when the model has no price. Never guessed. */
  costUsd?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface Trace {
  id: string;
  /** Present for a trace of a Kampong spec; absent for an ingested one. */
  specId?: string;
  specVersion?: string;
  status: SpanStatus;
  startedAt: number;
  endedAt?: number;
  spans: Span[];
  totals: { inputTokens: number; outputTokens: number; costUsd?: number; modelCalls: number };
}

/** Dollars per million tokens, by model name. */
export type Pricing = Record<string, { inputPerMTok: number; outputPerMTok: number }>;

export interface TraceRecorderOptions {
  now?: () => number;
  /** Trace id; defaults to a random one. */
  id?: string;
  pricing?: Pricing;
}

const TOOL_ACTIONS = new Set(["http_request", "component", "slack_post_message", "gmail_send"]);
const SPECIAL_TYPES = new Set(["condition", "approval", "transform", "validate", "dedupe", "tool"]);

/** What kind of span a workflow step makes. */
export function stepKind(step: WorkflowStep | undefined): SpanKind {
  if (!step) return "step";
  if ("foreach" in step) return "foreach";
  if ("branch" in step) return "branch";
  if ("stop" in step) return "stop";
  if ("type" in step && typeof step.type === "string" && SPECIAL_TYPES.has(step.type)) {
    return step.type === "tool" ? "tool" : (step.type as SpanKind);
  }
  if ("action" in step) return TOOL_ACTIONS.has(step.action) ? "tool" : "llm";
  return "step";
}

// Step names are unique in a spec (the validator checks), so every step, nested ones included, is indexed by
// its own name; a loop body step reported as `loop[3].inner` is looked up as `inner`.
function indexSteps(list: readonly WorkflowStep[], into: Map<string, WorkflowStep>): void {
  for (const step of list) {
    into.set(step.step, step);
    const nested: readonly (readonly WorkflowStep[])[] =
      "foreach" in step
        ? [step.foreach.steps as unknown as WorkflowStep[]]
        : "branch" in step
          ? "if" in step.branch
            ? [step.branch.then, step.branch.else ?? []]
            : [...Object.values(step.branch.cases), step.branch.default ?? []]
          : [];
    for (const arm of nested) indexSteps(arm, into);
  }
}

// `loop[3].inner` -> { parent: "loop", own: "inner" }; a plain name has no parent.
function splitName(name: string): { parent?: string; own: string } {
  const match = /^(.*)\[(\d+)\]\.(.+)$/.exec(name);
  return match ? { parent: match[1], own: match[3] ?? name } : { own: name };
}

export function estimateCost(
  pricing: Pricing | undefined,
  model: string | undefined,
  usage: TokenUsage | undefined,
): number | undefined {
  const price = model === undefined ? undefined : pricing?.[model];
  if (!price || !usage) return undefined;
  const input = ((usage.inputTokens ?? 0) * price.inputPerMTok) / 1_000_000;
  const output = ((usage.outputTokens ?? 0) * price.outputPerMTok) / 1_000_000;
  return input + output;
}

export class TraceRecorder {
  private readonly now: () => number;
  private readonly traceId: string;
  private readonly spans: Span[] = [];
  private readonly open = new Map<string, Span>();
  private readonly pausedAt = new Map<string, number>();
  private readonly byName = new Map<string, WorkflowStep>();
  private readonly root: Span;
  private currentModel: Span | undefined;
  private seq = 0;

  constructor(
    private readonly spec: AgentSpec,
    private readonly options: TraceRecorderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.traceId =
      options.id ?? `trace-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    indexSteps(spec.agent.workflow, this.byName);
    this.root = this.begin(spec.agent.id, "run", undefined);
  }

  /** Records `run`'s events from now on. */
  attach(run: AgentRun): this {
    run.on("event", (event: RunEvent) => this.handle(event));
    return this;
  }

  /** Wraps a model client so each call is a `model` span under the step that made it. */
  wrapModel(inner: ModelClient): ModelClient {
    const call = async <T>(model: string | undefined, fn: () => Promise<T>): Promise<T> => {
      const parent = this.currentStepSpan();
      const span = this.begin(model ?? this.spec.agent.model?.name ?? "model", "model", parent?.id);
      span.model = model ?? this.spec.agent.model?.name;
      // A concurrent loop may have several steps open; the call is then attributed to the latest, and says so.
      if (this.leafCount() > 1) span.attributes = { attribution: "approximate" };
      this.currentModel = span;
      try {
        const out = await fn();
        this.end(span, "ok");
        return out;
      } catch (err) {
        this.end(span, "error", err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        if (this.currentModel === span) this.currentModel = undefined;
      }
    };
    return {
      generateText: (input) => call(input.model, () => inner.generateText(input)),
      generateStructured: <T>(input: Parameters<ModelClient["generateStructured"]>[0]) =>
        call(input.model, () => inner.generateStructured(input as never) as Promise<T>),
    } as ModelClient;
  }

  /** Pass this as the model client's `onUsage` so the open model span gets its token counts. */
  readonly reportUsage = (usage: ModelUsage): void => {
    const span = this.currentModel;
    if (!span) return;
    span.usage = {
      ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
    };
    const cost = estimateCost(this.options.pricing, span.model, span.usage);
    if (cost !== undefined) span.costUsd = cost;
  };

  /** A copy of the trace as it stands now; safe to call while the run is going. */
  snapshot(): Trace {
    const spans = this.spans.map((s) => ({ ...s }));
    let inputTokens = 0;
    let outputTokens = 0;
    let cost: number | undefined;
    let modelCalls = 0;
    for (const s of spans) {
      if (s.kind !== "model") continue;
      modelCalls++;
      inputTokens += s.usage?.inputTokens ?? 0;
      outputTokens += s.usage?.outputTokens ?? 0;
      if (s.costUsd !== undefined) cost = (cost ?? 0) + s.costUsd;
    }
    return {
      id: this.traceId,
      specId: this.spec.agent.id,
      specVersion: String(this.spec.version),
      status: this.root.status,
      startedAt: this.root.startedAt,
      ...(this.root.endedAt !== undefined && { endedAt: this.root.endedAt }),
      spans,
      totals: {
        inputTokens,
        outputTokens,
        modelCalls,
        ...(cost !== undefined && { costUsd: cost }),
      },
    };
  }

  private begin(name: string, kind: SpanKind, parentId: string | undefined): Span {
    const span: Span = {
      id: `${this.traceId}:${++this.seq}`,
      name,
      kind,
      status: "running",
      startedAt: this.now(),
      ...(parentId !== undefined && { parentId }),
    };
    this.spans.push(span);
    return span;
  }

  private end(span: Span, status: SpanStatus, error?: string): void {
    const at = this.now();
    const paused = this.pausedAt.get(span.id);
    if (paused !== undefined) {
      span.waitedMs = (span.waitedMs ?? 0) + (at - paused);
      this.pausedAt.delete(span.id);
    }
    span.status = status;
    span.endedAt = at;
    span.durationMs = at - span.startedAt;
    if (error !== undefined) span.error = error;
  }

  private currentStepSpan(): Span | undefined {
    let latest: Span | undefined;
    for (const span of this.open.values()) {
      if (span.kind === "foreach" || span.kind === "branch") continue;
      if (!latest || span.startedAt >= latest.startedAt) latest = span;
    }
    return latest ?? this.root;
  }

  private leafCount(): number {
    let n = 0;
    for (const span of this.open.values())
      if (span.kind !== "foreach" && span.kind !== "branch") n++;
    return n;
  }

  private handle(event: RunEvent): void {
    switch (event.type) {
      case "step_started": {
        const { parent, own } = splitName(event.step);
        const parentSpan = parent === undefined ? undefined : this.open.get(parent);
        const step = this.byName.get(own);
        // A step that starts again under the same name is a retry: the earlier attempt did not succeed.
        const earlier = this.open.get(event.step);
        if (earlier) this.end(earlier, "error", "retried");
        const span = this.begin(event.step, stepKind(step), parentSpan?.id ?? this.root.id);
        this.open.set(event.step, span);
        break;
      }
      case "step_completed": {
        const span = this.open.get(event.step);
        if (!span) break;
        if (event.confidence !== undefined) {
          span.attributes = { ...span.attributes, confidence: event.confidence };
        }
        this.end(span, "ok");
        this.open.delete(event.step);
        break;
      }
      case "awaiting_approval": {
        const span = this.open.get(event.step);
        if (!span) break;
        span.status = "paused";
        span.attributes = { ...span.attributes, approval: event.kind, reason: event.reason };
        this.pausedAt.set(span.id, this.now());
        this.root.status = "paused";
        break;
      }
      case "rejected": {
        const span = this.open.get(event.step);
        if (span) this.end(span, "rejected", event.reason);
        this.open.delete(event.step);
        this.finish("rejected", event.reason);
        break;
      }
      case "failed": {
        const span = event.step ? this.open.get(event.step) : undefined;
        if (span && event.step) {
          this.end(span, "error", event.error);
          this.open.delete(event.step);
        }
        this.finish("error", event.error);
        break;
      }
      case "completed":
        this.noteLoopErrors(event.output);
        this.finish("ok");
        break;
    }
    if (event.type === "step_started" || event.type === "step_completed") {
      if (this.root.status === "paused") this.root.status = "running";
    }
  }

  // A loop item that failed under `on_error: continue` never reports an event of its own; the loop's output lists
  // it (`errors: [{ index, step, message }]`), so its span is marked from there when the run completes.
  private readonly itemErrors = new Map<string, string>();
  private noteLoopErrors(output: Record<string, unknown>): void {
    for (const [loop, value] of Object.entries(output)) {
      const errors = (value as { errors?: unknown } | null)?.errors;
      if (!Array.isArray(errors)) continue;
      for (const e of errors as { index?: unknown; step?: unknown; message?: unknown }[]) {
        if (typeof e?.index === "number" && typeof e.step === "string") {
          this.itemErrors.set(`${loop}[${e.index}].${e.step}`, String(e.message ?? "failed"));
        }
      }
    }
  }

  // Closes every span still open when the run ends, then the root. A loop or branch is as ok as the run; a step
  // that never finished did not succeed.
  private finish(status: SpanStatus, error?: string): void {
    for (const [name, span] of this.open) {
      const container = span.kind === "foreach" || span.kind === "branch";
      if (status === "ok" && !container) {
        this.end(span, "error", this.itemErrors.get(name) ?? "did not finish");
      } else {
        this.end(span, status === "ok" ? "ok" : status);
      }
      this.open.delete(name);
    }
    this.end(this.root, status, error);
  }
}

export function createTraceRecorder(
  spec: AgentSpec,
  options?: TraceRecorderOptions,
): TraceRecorder {
  return new TraceRecorder(spec, options);
}
