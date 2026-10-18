import type { PatchOp } from "./mutate.js";
import { parseSpec, type SpecError } from "./parse.js";
import { applyPatchToSource } from "./repository.js";
import type { AgentSpec } from "./schema.js";

// Upgrading a version "1.0" spec to "1.1" from the canvas (KAM-199, ADR-0027).
//
// Changing `version` alone is not safe: 1.1 stops substituting a `{step.field}` placeholder (it is left as text) and
// reads a condition's `if` as a JSONata expression, where equality is `=`, not `==`. So the upgrade rewrites those
// two constructs to say the same thing in 1.1, then loads the result under the 1.1 rules. If it does not load, there
// is nothing to apply and the problems are returned, so a spec is never upgraded into one that fails to load.

export interface UpgradeNote {
  path: (string | number)[];
  /** What was rewritten, in words. */
  message: string;
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

export type UpgradePreview =
  | {
      success: true;
      /** The patch the canvas applies: the version, plus the rewrites. */
      ops: PatchOp[];
      notes: UpgradeNote[];
      source: string;
      /** The changed lines with two lines of context around each change. */
      diff: DiffLine[];
    }
  | { success: false; errors: SpecError[]; notes: UpgradeNote[] };

// The 1.0 condition grammar (packages/engine/src/condition.ts): `<step>.<field> <op> <literal>`.
const LEGACY_CONDITION = /^\s*([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/;
const SINGLE_BRACE = /(?<!\{)\{([A-Za-z0-9_.]+)\}(?!\})/g;

/** A path in words for a note: a tool by its name, anything else as `tools[0].url`. */
function where(spec: AgentSpec, path: (string | number)[]): string {
  const tool =
    path[1] === "tools" && typeof path[2] === "number" ? spec.agent.tools?.[path[2]] : undefined;
  const rest = path.slice(tool ? 3 : 1).map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`));
  return `${tool ? `Tool "${tool.name}"` : "agent"}${rest.join("")}`;
}

/** The patch ops and notes for a 1.0 spec: the version, each legacy condition and each `{step.field}` placeholder. */
export function planUpgradeTo11(spec: AgentSpec): { ops: PatchOp[]; notes: UpgradeNote[] } {
  const ops: PatchOp[] = [{ op: "set", path: ["version"], value: "1.1" }];
  const notes: UpgradeNote[] = [];

  spec.agent.workflow.forEach((step, i) => {
    if (!("if" in step) || typeof step.if !== "string") return;
    const match = LEGACY_CONDITION.exec(step.if);
    if (!match) return; // not the old grammar: left as written, and the 1.1 load says what is wrong with it
    const [, left, op, right] = match as unknown as [string, string, string, string];
    const next = `${left} ${op === "==" ? "=" : op} ${right}`;
    if (next === step.if) return;
    const path = ["agent", "workflow", i, "if"];
    ops.push({ op: "set", path, value: next });
    notes.push({ path, message: `Condition "${step.step}": ${step.if} becomes ${next}` });
  });

  const scan = (value: unknown, path: (string | number)[]) => {
    if (typeof value === "string") {
      if (!new RegExp(SINGLE_BRACE.source).test(value)) return;
      const next = value.replace(SINGLE_BRACE, "{{ $1 }}");
      ops.push({ op: "set", path, value: next });
      const found = [...value.matchAll(SINGLE_BRACE)].map((m) => m[0]).join(", ");
      notes.push({ path, message: `${where(spec, path)}: ${found} becomes {{ … }}` });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, [...path, i]));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, [...path, k]);
    }
  };
  scan(spec.agent.tools, ["agent", "tools"]);
  return { ops, notes };
}

/** A line diff of two texts with `context` unchanged lines kept around each change; unchanged runs are dropped. */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // Longest common subsequence of the changed middle only, so a spec with one edit stays cheap.
  const lcs: number[][] = Array.from({ length: midA.length + 1 }, () =>
    new Array<number>(midB.length + 1).fill(0),
  );
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      out.push({ kind: "same", text: midA[i]! });
      i++;
      j++;
    } else if (i < midA.length && (j === midB.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ kind: "del", text: midA[i++]! });
    } else {
      out.push({ kind: "add", text: midB[j++]! });
    }
  }
  const lead = a.slice(Math.max(0, start - context), start).map((text) => ({ kind: "same", text }));
  const tail = a.slice(endA, endA + context).map((text) => ({ kind: "same", text }));
  return [...lead, ...out, ...tail] as DiffLine[];
}

/** What upgrading `source` would do, or why it cannot be done. Nothing is written. */
export function previewUpgradeTo11(source: string): UpgradePreview {
  const parsed = parseSpec(source);
  // The version is read from the document, not the validated spec: a 1.1 spec with a problem has no spec, and
  // "fix this first" would be the wrong answer to someone who is not upgrading anything.
  const version = parsed.doc.get("version");
  if (version !== undefined && String(version) !== "1.0") {
    return {
      success: false,
      errors: [{ path: ["version"], message: `This spec is already version "${String(version)}"` }],
      notes: [],
    };
  }
  if (!parsed.spec) return { success: false, errors: parsed.errors, notes: [] };
  const { ops, notes } = planUpgradeTo11(parsed.spec);
  const applied = applyPatchToSource(source, ops);
  if (!applied.success) return { success: false, errors: applied.errors, notes };
  return {
    success: true,
    ops,
    notes,
    source: applied.source,
    diff: diffLines(source, applied.source),
  };
}
