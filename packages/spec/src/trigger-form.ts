import type { PatchOp } from "./mutate.js";
import { buildSchedule } from "./schedule.js";
import { triggerSchema, type AgentSpec, type Trigger } from "./schema.js";
import { diffFieldOps } from "./output-schema-form.js";
import { ensureVersion11Ops } from "./var-form.js";
import { resolveWebhookAuth, type WebhookAuthInput, type WebhookPreset } from "./webhook-auth.js";

// The trigger form's write side (KAN-1850; webhook auth, `when` and `map` are KAN-1848/ADR-0047, schedule is
// KAN-1856/ADR-0040). Builds a trigger from form text and checks what the validator checks about it, so the
// form can say what is wrong before anything is written.

export interface WebhookTriggerFormInput {
  kind: "webhook";
  respond?: "async" | "sync";
  timeoutMs?: number;
  preset?: WebhookPreset;
  /** "none", "bearer" or "hmac"; blank means the preset's (or no auth at all without one). */
  authType?: "none" | "bearer" | "hmac" | "";
  /** The NAME of the environment variable that holds the secret; never the secret. */
  secretEnv?: string;
  /** hmac only: the header that carries the signature, and how it is computed. */
  header?: string;
  algo?: "sha256" | "sha1" | "";
  prefix?: string;
  encoding?: "hex" | "base64" | "";
  /** A predicate over the request that drops a request that should not start a run. */
  when?: string;
  /** One `name: expression` per line; builds the `trigger.*` the workflow reads. */
  map?: string;
}

export interface ScheduleTriggerFormInput {
  kind: "schedule";
  mode: "cron" | "every";
  cron?: string;
  every?: string;
  /** cron only; blank means UTC. */
  tz?: string;
  overlap?: "skip" | "queue" | "";
}

export type TriggerFormInput = WebhookTriggerFormInput | ScheduleTriggerFormInput;

export interface TriggerFormResult {
  success: boolean;
  trigger?: Trigger;
  errors?: string[];
}

export function parseMapLines(text: string): { map: Record<string, string>; errors: string[] } {
  const map: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim();
    const expression = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || expression === "") {
      errors.push(`"${line}" is not "name: expression"`);
    } else if (["headers", "body"].includes(name)) {
      errors.push(`map cannot set "${name}": trigger.${name} is always the request's own`);
    } else {
      map[name] = expression;
    }
  }
  return { map, errors };
}

export function buildTriggerFromForm(input: TriggerFormInput): TriggerFormResult {
  if (input.kind === "schedule") {
    const text = input.mode === "cron" ? input.cron?.trim() : input.every?.trim();
    if (!text) {
      return {
        success: false,
        errors: [input.mode === "cron" ? "Enter a cron schedule" : "Enter an interval like 15m"],
      };
    }
    const tz = input.mode === "cron" ? input.tz?.trim() : undefined;
    const built = buildSchedule({
      ...(input.mode === "cron" ? { cron: text } : { every: text }),
      ...(tz && { tz }),
    });
    if (!built.ok) return { success: false, errors: [built.error] };
    const parsed = triggerSchema.safeParse({
      type: "schedule",
      ...(input.mode === "cron" ? { cron: text } : { every: text }),
      ...(tz && { tz }),
      ...(input.overlap && { overlap: input.overlap }),
    });
    return parsed.success
      ? { success: true, trigger: parsed.data }
      : { success: false, errors: parsed.error.issues.map((i) => i.message) };
  }

  const errors: string[] = [];
  const mapped = parseMapLines(input.map ?? "");
  errors.push(...mapped.errors);
  const auth: WebhookAuthInput = {
    ...(input.authType && { type: input.authType }),
    ...(input.secretEnv?.trim() && { secret_env: input.secretEnv.trim() }),
    ...(input.header?.trim() && { header: input.header.trim() }),
    ...(input.algo && { algo: input.algo }),
    ...(input.prefix?.trim() && { prefix: input.prefix.trim() }),
    ...(input.encoding && { encoding: input.encoding }),
  };
  const hasAuth = Object.keys(auth).length > 0;
  if (input.preset !== undefined || hasAuth) {
    const resolved = resolveWebhookAuth(input.preset, hasAuth ? auth : undefined);
    if (!resolved.ok) errors.push(...resolved.issues.map((i) => i.message));
  }
  if (errors.length > 0) return { success: false, errors };
  const candidate = {
    type: "webhook" as const,
    ...(input.respond && { respond: input.respond }),
    ...(input.timeoutMs !== undefined && { timeout_ms: input.timeoutMs }),
    ...(input.preset && { preset: input.preset }),
    ...(hasAuth && {
      auth: auth.type === "none" && Object.keys(auth).length === 1 ? "none" : auth,
    }),
    ...(input.when?.trim() && { when: input.when.trim() }),
    ...(Object.keys(mapped.map).length > 0 && { map: mapped.map }),
  };
  const parsed = triggerSchema.safeParse(candidate);
  if (!parsed.success) return { success: false, errors: parsed.error.issues.map((i) => i.message) };
  return { success: true, trigger: parsed.data };
}

/** The form's starting values for the trigger a spec already has. */
export function triggerFormFromSpec(trigger: Trigger | undefined): TriggerFormInput {
  if (trigger?.type === "schedule") {
    return {
      kind: "schedule",
      mode: trigger.every !== undefined ? "every" : "cron",
      ...(trigger.cron !== undefined && { cron: trigger.cron }),
      ...(trigger.every !== undefined && { every: trigger.every }),
      ...(trigger.tz !== undefined && { tz: trigger.tz }),
      ...(trigger.overlap !== undefined && { overlap: trigger.overlap }),
    };
  }
  if (trigger?.type === "webhook") {
    const auth = trigger.auth === "none" ? { type: "none" as const } : (trigger.auth ?? {});
    return {
      kind: "webhook",
      ...(trigger.respond && { respond: trigger.respond }),
      ...(trigger.timeout_ms !== undefined && { timeoutMs: trigger.timeout_ms }),
      ...(trigger.preset && { preset: trigger.preset }),
      ...(auth.type && { authType: auth.type }),
      ...(auth.secret_env && { secretEnv: auth.secret_env }),
      ...(auth.header && { header: auth.header }),
      ...(auth.algo && { algo: auth.algo }),
      ...(auth.prefix && { prefix: auth.prefix }),
      ...(auth.encoding && { encoding: auth.encoding }),
      ...(trigger.when && { when: trigger.when }),
      ...(trigger.map && {
        map: Object.entries(trigger.map)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      }),
    };
  }
  return { kind: "webhook" };
}

/**
 * The patch ops that make `trigger` the spec's trigger. A trigger of the same type is patched key by key so
 * comments inside it survive; a different type replaces it. Every field beyond `type: webhook` plus `respond` /
 * `timeout_ms` needs version "1.1", and a schedule needs it too, so a "1.0" spec is raised.
 */
export function triggerOps(
  spec: Pick<AgentSpec, "version"> & { agent: { trigger?: Trigger } },
  trigger: Trigger,
): PatchOp[] {
  const before = spec.agent.trigger;
  const needs11 =
    trigger.type === "schedule" ||
    trigger.preset !== undefined ||
    trigger.auth !== undefined ||
    trigger.when !== undefined ||
    trigger.map !== undefined;
  return [
    ...(needs11 ? ensureVersion11Ops(spec) : []),
    ...(before !== undefined && before.type === trigger.type
      ? diffFieldOps(
          ["agent", "trigger"],
          before as Record<string, unknown>,
          trigger as Record<string, unknown>,
        )
      : [{ op: "set" as const, path: ["agent", "trigger"], value: trigger }]),
  ];
}
