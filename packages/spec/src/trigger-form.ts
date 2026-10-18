import {
  componentRefSchema,
  envVarPlaceholderSchema,
  triggerSchema,
  type Trigger,
} from "./schema.js";
import { parseExpression } from "./expression.js";
import { buildSchedule, parseEvery } from "./schedule.js";
import { resolveWebhookAuth, type WebhookAuthInput, type WebhookPreset } from "./webhook-auth.js";
import type { PatchOp } from "./mutate.js";

// The canvas trigger panel's form logic (KAM-161, a slice of KAM-110), in the same shape as the vars and
// workflow forms: plain text in, a validated `agent.trigger` or a list of messages out, with no way to submit
// what the spec loader would refuse. The cross-field rules are the loader's own (the same schedule, interval,
// webhook-auth and expression functions), and a test builds every shape into a whole spec to keep the two
// agreeing. The panel sends the result as a patch, so the rest of the file is left as it was.
//
// A secret is never a value here: `secret_env` is the NAME of an environment variable and a poll's `secrets`
// are `${ENV}` placeholders, both refused otherwise, and an error never repeats what was typed in them.

export type TriggerType = "webhook" | "schedule" | "poll";

export interface TriggerFormInput {
  type: TriggerType;

  // webhook
  respond?: "async" | "sync";
  /** Milliseconds as text; only with `respond: sync`. */
  timeout_ms?: string;
  preset?: WebhookPreset | "";
  auth?: "" | "none" | "bearer" | "hmac";
  secret_env?: string;
  header?: string;
  algo?: "" | "sha256" | "sha1";
  prefix?: string;
  encoding?: "" | "hex" | "base64";
  timestamp_header?: string;
  /** Seconds as text; needs a timestamp header. */
  window_s?: string;
  payload?: string;
  when?: string;
  /** `name: expression`, one per line. */
  map?: string;

  // schedule
  schedule?: "cron" | "every";
  cron?: string;
  tz?: string;
  overlap?: "" | "skip" | "queue";

  // schedule and poll
  every?: string;

  // poll
  use?: string;
  op?: string;
  /** The op's arguments, as a JSON object. */
  with?: string;
  /** `name: value`, one per line. */
  config?: string;
  /** `name: ${ENV_VAR}`, one per line. */
  secrets?: string;
  items?: string;
  id?: string;
  dedupe?: "" | "unique" | "greatest" | "last" | "time_window";
  window?: string;
  one_run_per_item?: boolean;
}

export type TriggerFormResult =
  { success: true; value: Trigger } | { success: false; errors: string[] };

const text = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
};

/** `name: value` lines to a record. A line with no colon, a blank name or a repeated name is a problem. */
function parseLines(
  source: string | undefined,
  field: string,
  errors: string[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  (source ?? "").split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    const colon = raw.indexOf(":");
    const name = colon < 0 ? "" : raw.slice(0, colon).trim();
    const value = colon < 0 ? "" : raw.slice(colon + 1).trim();
    if (name === "" || value === "") {
      errors.push(`${field} line ${i + 1} needs the form name: value`);
    } else if (name in out || name === "__proto__") {
      errors.push(`${field} names "${name}" more than once`);
    } else {
      out[name] = value;
    }
  });
  return Object.keys(out).length === 0 ? undefined : out;
}

function integer(value: string | undefined, field: string, errors: string[]): number | undefined {
  const t = text(value);
  if (t === undefined) return undefined;
  const n = /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isFinite(n)) errors.push(`${field} "${t}" is not a whole number`);
  return Number.isFinite(n) ? n : undefined;
}

function checkExpression(source: string | undefined, where: string, errors: string[]): void {
  if (source === undefined) return;
  const parsed = parseExpression(source);
  if (!parsed.ok) for (const e of parsed.errors) errors.push(`${where}: ${e.message}`);
}

function webhook(input: TriggerFormInput, version: string, errors: string[]): object {
  const preset = text(input.preset) as WebhookPreset | undefined;
  const authType = text(input.auth);
  const secretEnv = text(input.secret_env);
  const header = text(input.header);
  const algo = text(input.algo);
  const prefix = input.prefix === undefined || input.prefix === "" ? undefined : input.prefix;
  const encoding = text(input.encoding);
  const timestamp = text(input.timestamp_header);
  const windowS = integer(input.window_s, "window_s", errors);
  const payload = text(input.payload);
  const when = text(input.when);
  const map = parseLines(input.map, "map", errors);
  const timeoutMs = integer(input.timeout_ms, "timeout_ms", errors);

  const auth: WebhookAuthInput | "none" | undefined =
    authType === "none"
      ? "none"
      : authType === undefined && secretEnv === undefined && header === undefined
        ? undefined
        : {
            ...(authType && { type: authType as "bearer" | "hmac" }),
            ...(secretEnv && { secret_env: secretEnv }),
            ...(header && { header }),
            ...(algo && { algo: algo as "sha256" | "sha1" }),
            ...(prefix !== undefined && { prefix }),
            ...(encoding && { encoding: encoding as "hex" | "base64" }),
            ...(timestamp && { timestamp_header: timestamp }),
            ...(windowS !== undefined && { window_s: windowS }),
            ...(payload && { payload }),
          };

  const hasAuth = preset !== undefined || auth !== undefined;
  if (hasAuth) {
    const resolved = resolveWebhookAuth(preset, auth);
    if (!resolved.ok) errors.push(...resolved.issues.map((i) => i.message));
  }
  checkExpression(when, "when", errors);
  for (const [name, source] of Object.entries(map ?? {})) {
    if (name === "headers" || name === "body") {
      errors.push(`map cannot set "${name}": trigger.${name} is always the request's own`);
    }
    checkExpression(source, `map.${name}`, errors);
  }
  if (timeoutMs !== undefined && input.respond !== "sync") {
    errors.push('timeout_ms only applies with respond: "sync"');
  }
  if (version !== "1.1") {
    const needs11 = [
      ["respond", input.respond === "sync"],
      ["preset", preset !== undefined],
      ["auth", auth !== undefined],
      ["when", when !== undefined],
      ["map", map !== undefined],
    ] as const;
    for (const [field, used] of needs11) if (used) errors.push(`${field} needs version "1.1"`);
  }
  return {
    type: "webhook",
    ...(input.respond === "sync" && { respond: "sync" }),
    ...(timeoutMs !== undefined && { timeout_ms: timeoutMs }),
    ...(preset && { preset }),
    ...(auth !== undefined && { auth }),
    ...(when && { when }),
    ...(map && { map }),
  };
}

function schedule(input: TriggerFormInput, version: string, errors: string[]): object {
  const by = input.schedule ?? "cron";
  const cron = by === "cron" ? text(input.cron) : undefined;
  const every = by === "every" ? text(input.every) : undefined;
  const tz = by === "cron" ? text(input.tz) : undefined;
  if (version !== "1.1") errors.push('a schedule trigger needs version "1.1"');
  if (cron === undefined && every === undefined) {
    errors.push(
      by === "cron" ? "A schedule needs a cron expression" : "A schedule needs an interval",
    );
  } else {
    const built = buildSchedule({
      ...(cron && { cron }),
      ...(every && { every }),
      ...(tz && { tz }),
    });
    if (!built.ok) errors.push(built.error);
  }
  const overlap = text(input.overlap);
  return {
    type: "schedule",
    ...(cron && { cron }),
    ...(every && { every }),
    ...(tz && { tz }),
    ...(overlap && { overlap }),
  };
}

function poll(input: TriggerFormInput, version: string, errors: string[]): object {
  if (version !== "1.1") errors.push('a poll trigger needs version "1.1"');
  const every = text(input.every);
  if (every === undefined) errors.push("A poll needs an interval (30s, 15m, 6h, 1d)");
  else {
    const parsed = parseEvery(every);
    if (!parsed.ok) errors.push(parsed.error);
  }
  const use = text(input.use);
  if (use === undefined) errors.push("A poll needs a component, like kampong/github@1.0.0");
  else {
    const ref = componentRefSchema.safeParse(use);
    if (!ref.success) errors.push(...ref.error.issues.map((i) => i.message));
  }
  const op = text(input.op);
  if (op === undefined) errors.push("A poll needs the component's op to call");

  let withArgs: Record<string, unknown> | undefined;
  const withText = text(input.with);
  if (withText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(withText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      withArgs = parsed as Record<string, unknown>;
    } catch {
      errors.push('with must be a JSON object, like {"repo": "owner/name"}');
    }
  }
  const config = parseLines(input.config, "config", errors);
  const secretLines = parseLines(input.secrets, "secrets", errors);
  for (const [name, value] of Object.entries(secretLines ?? {})) {
    // The value is not repeated: it may be a literal secret that was pasted in by mistake.
    if (!envVarPlaceholderSchema.safeParse(value).success) {
      errors.push(`secrets.${name} must reference an environment variable as \${ENV_VAR}`);
    }
  }

  const items = text(input.items);
  const id = text(input.id);
  checkExpression(items, "items", errors);
  if (id === undefined) errors.push("A poll needs an id expression: what makes an item new");
  else checkExpression(id, "id", errors);

  const dedupe = text(input.dedupe);
  if (dedupe === undefined) errors.push("A poll needs a dedupe rule");
  const window = text(input.window);
  if (dedupe === "time_window") {
    if (window === undefined) errors.push("dedupe time_window needs a window (e.g. 24h)");
  } else if (window !== undefined) {
    errors.push("window only applies to dedupe time_window");
  }
  if (window !== undefined) {
    const parsed = parseEvery(window);
    if (!parsed.ok) errors.push(parsed.error);
  }
  return {
    type: "poll",
    ...(every && { every }),
    ...(use && { use }),
    ...(op && { op }),
    ...(withArgs && { with: withArgs }),
    ...(config && { config }),
    ...(secretLines && { secrets: secretLines }),
    ...(items && { items }),
    ...(id && { id }),
    ...(dedupe && { dedupe }),
    ...(window && { window }),
    ...(input.one_run_per_item === false && { one_run_per_item: false }),
  };
}

/** Validates the form for a spec of `version` and builds the `agent.trigger` value. */
export function buildTriggerFromForm(input: TriggerFormInput, version: string): TriggerFormResult {
  const errors: string[] = [];
  const candidate =
    input.type === "webhook"
      ? webhook(input, version, errors)
      : input.type === "schedule"
        ? schedule(input, version, errors)
        : poll(input, version, errors);
  if (errors.length > 0) return { success: false, errors };
  const result = triggerSchema.safeParse(candidate);
  if (!result.success) return { success: false, errors: result.error.issues.map((i) => i.message) };
  return { success: true, value: result.data };
}

const lines = (record: Record<string, string> | undefined): string =>
  Object.entries(record ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

/** The form's text for an existing trigger, to edit it in place. */
export function triggerToFormInput(trigger: Trigger): TriggerFormInput {
  if (trigger.type === "schedule") {
    return {
      type: "schedule",
      schedule: trigger.every !== undefined ? "every" : "cron",
      ...(trigger.cron !== undefined && { cron: trigger.cron }),
      ...(trigger.every !== undefined && { every: trigger.every }),
      ...(trigger.tz !== undefined && { tz: trigger.tz }),
      ...(trigger.overlap !== undefined && { overlap: trigger.overlap }),
    };
  }
  if (trigger.type === "poll") {
    return {
      type: "poll",
      every: trigger.every,
      use: trigger.use,
      op: trigger.op,
      ...(trigger.with !== undefined && { with: JSON.stringify(trigger.with, null, 2) }),
      ...(trigger.config !== undefined && { config: lines(trigger.config) }),
      ...(trigger.secrets !== undefined && { secrets: lines(trigger.secrets) }),
      ...(trigger.items !== undefined && { items: trigger.items }),
      id: trigger.id,
      dedupe: trigger.dedupe,
      ...(trigger.window !== undefined && { window: trigger.window }),
      ...(trigger.one_run_per_item === false && { one_run_per_item: false }),
    };
  }
  const auth: WebhookAuthInput | undefined =
    trigger.auth === "none" ? { type: "none" } : trigger.auth;
  return {
    type: "webhook",
    ...(trigger.respond !== undefined && { respond: trigger.respond }),
    ...(trigger.timeout_ms !== undefined && { timeout_ms: String(trigger.timeout_ms) }),
    ...(trigger.preset !== undefined && { preset: trigger.preset }),
    ...(auth?.type !== undefined && { auth: auth.type }),
    ...(auth?.secret_env !== undefined && { secret_env: auth.secret_env }),
    ...(auth?.header !== undefined && { header: auth.header }),
    ...(auth?.algo !== undefined && { algo: auth.algo }),
    ...(auth?.prefix !== undefined && { prefix: auth.prefix }),
    ...(auth?.encoding !== undefined && { encoding: auth.encoding }),
    ...(auth?.timestamp_header !== undefined && { timestamp_header: auth.timestamp_header }),
    ...(auth?.window_s !== undefined && { window_s: String(auth.window_s) }),
    ...(auth?.payload !== undefined && { payload: auth.payload }),
    ...(trigger.when !== undefined && { when: trigger.when }),
    ...(trigger.map !== undefined && { map: lines(trigger.map) }),
  };
}

export const setTriggerPatch = (value: Trigger): PatchOp[] => [
  { op: "set", path: ["agent", "trigger"], value },
];
export const removeTriggerPatch = (): PatchOp[] => [{ op: "remove", path: ["agent", "trigger"] }];
