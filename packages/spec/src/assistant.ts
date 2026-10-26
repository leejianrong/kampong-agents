import { z } from "zod";
import { applyOpsToSource, type OpError, type Place, type SpecOp } from "./ops.js";
import { parseSpec, type SpecError } from "./parse.js";
import type { PatchOp } from "./mutate.js";
import { diffPatch, listSteps } from "./step-edit.js";
import { planUpgradeTo11 } from "./upgrade.js";
import type { AgentSpec } from "./schema.js";

// The workflow assistant's vocabulary (KAM-249, ADR-0060). A model is asked for a short list of edits in terms a
// person would use (add this step, replace that tool), not index paths into a file. They are turned into the
// mutation layer's own operations (ADR-0055), applied to a copy, and the copy must load as an AgentSpec; nothing
// is returned as applied. This file is pure: no network, no files, so a recorded reply gives the same answer.

const record = z.record(z.string(), z.unknown());
const name = z.string().min(1);

const placeSchema: z.ZodType<Place> = z.object({
  in: z.union([
    z.literal("workflow"),
    z.object({
      step: name,
      slot: z.enum(["steps", "then", "else", "cases", "default"]),
      key: z.string().optional(),
    }),
  ]),
  index: z.number().int().min(0).optional(),
});

export const assistantEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upgrade_to_1_1") }),
  z.object({
    kind: z.literal("set_agent"),
    fields: z
      .object({
        name: name.optional(),
        role: name.optional(),
        goal: name.optional(),
        trigger: record.optional(),
        guardrails: record.optional(),
      })
      .strict(),
  }),
  z.object({ kind: z.literal("set_var"), name, var: record }),
  z.object({ kind: z.literal("remove_var"), name }),
  z.object({ kind: z.literal("add_tool"), tool: record }),
  z.object({ kind: z.literal("replace_tool"), tool: name, with: record }),
  z.object({ kind: z.literal("remove_tool"), tool: name }),
  z.object({ kind: z.literal("rename_tool"), tool: name, to: name }),
  z.object({ kind: z.literal("add_step"), place: placeSchema.optional(), step: record }),
  z.object({ kind: z.literal("replace_step"), step: name, with: record }),
  z.object({ kind: z.literal("remove_step"), step: name }),
  z.object({ kind: z.literal("move_step"), step: name, to: placeSchema }),
  z.object({ kind: z.literal("rename_step"), step: name, to: name }),
]);

export type AssistantEdit = z.infer<typeof assistantEditSchema>;

export const assistantPlanSchema = z.object({
  /** One or two sentences for the person: what this plan does. */
  summary: z.string(),
  edits: z.array(assistantEditSchema),
});

export type AssistantPlan = z.infer<typeof assistantPlanSchema>;

/** Parses the model's reply: JSON, bare or inside a code fence, with the plan's shape. */
export function parseAssistantReply(
  text: string,
): { ok: true; plan: AssistantPlan } | { ok: false; error: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The reply holds no JSON object." };
  let json: unknown;
  try {
    json = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    return {
      ok: false,
      error: `The reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = assistantPlanSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false,
      error: `The reply is not a plan: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    };
  }
  return { ok: true, plan: parsed.data };
}

/** What a plan changes, by name, for the canvas to mark and a person to read before applying. */
export interface AssistantDiffItem {
  kind: "step" | "tool" | "var" | "agent";
  name: string;
}

export interface AssistantDiff {
  added: AssistantDiffItem[];
  changed: AssistantDiffItem[];
  removed: AssistantDiffItem[];
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

function itemsOf(spec: AgentSpec): Map<string, { item: AssistantDiffItem; value: string }> {
  const out = new Map<string, { item: AssistantDiffItem; value: string }>();
  const put = (kind: AssistantDiffItem["kind"], n: string, value: unknown) =>
    out.set(`${kind}:${n}`, { item: { kind, name: n }, value: canonical(value) });
  for (const ref of listSteps(spec)) put("step", ref.name, ref.step);
  for (const tool of spec.agent.tools ?? []) put("tool", tool.name, tool);
  for (const [n, v] of Object.entries(spec.vars ?? {})) put("var", n, v);
  const agent: Record<string, unknown> = { ...spec.agent };
  delete agent.workflow;
  delete agent.tools;
  put("agent", "agent", { ...agent, version: spec.version });
  return out;
}

export function diffSpecs(before: AgentSpec, after: AgentSpec): AssistantDiff {
  const a = itemsOf(before);
  const b = itemsOf(after);
  const diff: AssistantDiff = { added: [], changed: [], removed: [] };
  for (const [key, { item, value }] of b) {
    const had = a.get(key);
    if (!had) diff.added.push(item);
    else if (had.value !== value) diff.changed.push(item);
  }
  for (const [key, { item }] of a) if (!b.has(key)) diff.removed.push(item);
  return diff;
}

export type PlanResult =
  | {
      success: true;
      ops: SpecOp[];
      /** The file as it would be after applying `ops`. */
      source: string;
      spec: AgentSpec;
      diff: AssistantDiff;
    }
  | { success: false; errors: string[] };

const where = (e: SpecError): string =>
  `${e.path.length > 0 ? e.path.join(".") + ": " : ""}${e.message}`;

/**
 * Turns a plan's edits into mutation ops for the spec in `source` and proves they apply: the result must load as
 * an AgentSpec. Edits that rewrite a place by position (replace, set, upgrade) come first, against the file as it
 * is; the ones that address by name or by place (add, remove, move, rename) follow, in the order given. A plan
 * that does not apply returns every reason in words a model can act on, and nothing else.
 */
export function planToOps(source: string, plan: AssistantPlan): PlanResult {
  const current = parseSpec(source);
  if (!current.success || !current.spec) {
    return { success: false, errors: ["The workflow has errors, so it cannot be edited yet."] };
  }
  const spec = current.spec;
  const steps = listSteps(spec);
  const errors: string[] = [];
  const positional: PatchOp[] = [];
  const named: SpecOp[] = [];

  for (const edit of plan.edits) {
    switch (edit.kind) {
      case "upgrade_to_1_1":
        if (spec.version === "1.1") errors.push("The workflow is already version 1.1.");
        else positional.push(...planUpgradeTo11(spec).ops);
        break;
      case "set_agent": {
        const agent = spec.agent as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(edit.fields)) {
          positional.push(...diffPatch(["agent", key], agent[key], value));
        }
        break;
      }
      case "set_var":
        positional.push(
          ...diffPatch(
            ["vars", edit.name],
            (spec.vars as Record<string, unknown> | undefined)?.[edit.name],
            edit.var,
          ),
        );
        break;
      case "remove_var":
        if (spec.vars?.[edit.name] === undefined)
          errors.push(`There is no var named "${edit.name}".`);
        else positional.push({ op: "remove", path: ["vars", edit.name] });
        break;
      case "add_tool":
        named.push({ op: "add", path: ["agent", "tools"], value: edit.tool });
        break;
      case "replace_tool": {
        const i = (spec.agent.tools ?? []).findIndex((t) => t.name === edit.tool);
        if (i < 0)
          errors.push(`There is no tool named "${edit.tool}" (use add_tool for a new one).`);
        else if (edit.with.name !== edit.tool) {
          errors.push(`replace_tool keeps the name "${edit.tool}"; use rename_tool to change it.`);
        } else {
          positional.push(
            ...diffPatch(["agent", "tools", i], (spec.agent.tools ?? [])[i], edit.with),
          );
        }
        break;
      }
      case "remove_tool":
        named.push({ op: "tool.remove", tool: edit.tool });
        break;
      case "rename_tool":
        named.push({ op: "tool.rename", tool: edit.tool, to: edit.to });
        break;
      case "add_step":
        named.push({ op: "step.insert", place: edit.place ?? { in: "workflow" }, step: edit.step });
        break;
      case "replace_step": {
        const ref = steps.find((s) => s.name === edit.step);
        if (!ref)
          errors.push(`There is no step named "${edit.step}" (use add_step for a new one).`);
        else if (edit.with.step !== edit.step) {
          errors.push(`replace_step keeps the name "${edit.step}"; use rename_step to change it.`);
        } else positional.push(...diffPatch(ref.path, ref.step, edit.with));
        break;
      }
      case "remove_step":
        named.push({ op: "step.remove", step: edit.step });
        break;
      case "move_step":
        named.push({ op: "step.move", step: edit.step, to: edit.to });
        break;
      case "rename_step":
        named.push({ op: "step.rename", step: edit.step, to: edit.to });
        break;
    }
  }
  if (errors.length > 0) return { success: false, errors };

  const ops: SpecOp[] = [...positional, ...named];
  if (ops.length === 0) return { success: false, errors: ["The plan changes nothing."] };
  const applied = applyOpsToSource(source, ops);
  if (!applied.success) {
    return {
      success: false,
      errors: applied.errors.map(
        (e: OpError) => (e.opIndex !== undefined ? `operation ${e.opIndex + 1}: ` : "") + where(e),
      ),
    };
  }
  const next = parseSpec(applied.source);
  if (!next.success || !next.spec) {
    return { success: false, errors: next.errors.map(where) };
  }
  // The loader does not check that a tool step names a declared tool; a model that forgets to add the tool would
  // produce a plan that loads and then fails mid-run, so it is caught here.
  const declared = new Set((next.spec.agent.tools ?? []).map((t) => t.name));
  const dangling = listSteps(next.spec).flatMap((ref) =>
    "type" in ref.step && ref.step.type === "tool" && !declared.has(ref.step.tool)
      ? [
          `step "${ref.name}" calls the tool "${ref.step.tool}", which is not declared (add it with add_tool).`,
        ]
      : [],
  );
  if (dangling.length > 0) return { success: false, errors: dangling };
  return {
    success: true,
    ops,
    source: applied.source,
    spec: next.spec,
    diff: diffSpecs(spec, next.spec),
  };
}
