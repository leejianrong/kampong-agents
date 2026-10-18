import { isSeq, type Document } from "yaml";
import { EXPRESSION_ROOTS } from "./expression-names.js";
import { applyPatch, type PatchOp } from "./mutate.js";
import { parseSpec, toYamlString, type SpecError } from "./parse.js";
import {
  expressionName,
  lineOfPath,
  occurrencesFor,
  scanOccurrences,
  EXECUTE_TOOL_SOURCE,
  type Occurrence,
  type Reference,
} from "./references.js";
import {
  WORKFLOW_PATH,
  isObj,
  rawTools,
  subtreeSteps,
  walkRawSteps,
  type Path,
  type RawStep,
} from "./step-tree.js";
import type { LayoutMap } from "./layout.js";

// The spec mutation layer (ADR-0055). A request is a list of operations applied in order to one in-memory
// document and validated once at the end; any failure writes nothing. The raw `set`/`add`/`remove` ops keep
// their index-path meaning; the step and tool ops address by name and keep references valid.

export type Slot = "steps" | "then" | "else" | "cases" | "default";

/** Where a step goes: a list and an index in it (default: the end). */
export interface Place {
  in: "workflow" | { step: string; slot: Slot; key?: string };
  index?: number;
}

export type SpecOp =
  | PatchOp
  | { op: "step.insert"; place: Place; step: Record<string, unknown> }
  | { op: "step.remove"; step: string }
  | { op: "step.move"; step: string; to: Place }
  | { op: "step.rename"; step: string; to: string }
  | { op: "tool.remove"; tool: string }
  | { op: "tool.rename"; tool: string; to: string };

export type OpErrorCode =
  | "step_not_found"
  | "tool_not_found"
  | "slot_not_found"
  | "ambiguous_step"
  | "name_taken"
  | "invalid_name"
  | "invalid_step"
  | "bad_index"
  | "move_into_self"
  | "nested_foreach"
  | "approval_in_foreach"
  | "needs_version_1_1"
  | "has_references"
  | "breaks_references"
  | "unrewritable"
  | "stale";

export interface OpError extends SpecError {
  code?: OpErrorCode;
  /** Which op of the request failed. */
  opIndex?: number;
  references?: Reference[];
}

export interface OpChanges {
  renamed: { kind: "step" | "tool"; from: string; to: string }[];
  removed: { kind: "step" | "tool"; name: string }[];
  /** How many reads of a renamed step or tool were rewritten. */
  rewrote: number;
}

/** A layout key to rename, or to drop when `to` is null (ADR-0006 keys: `workflow:<step>`, `tool:<name>`). */
export interface LayoutMove {
  from: string;
  to: string | null;
}

export type ApplyOpsToSourceResult =
  | {
      success: true;
      source: string;
      spec: unknown;
      changes: OpChanges;
      layoutMoves: LayoutMove[];
    }
  | { success: false; errors: OpError[]; source: string };

const SEMANTIC_OPS = new Set([
  "step.insert",
  "step.remove",
  "step.move",
  "step.rename",
  "tool.remove",
  "tool.rename",
]);

export function isPatchOp(op: SpecOp): op is PatchOp {
  return !SEMANTIC_OPS.has(op.op);
}

/** Applies layout renames and drops, leaving every other node where it was. */
export function applyLayoutMoves(layout: LayoutMap, moves: readonly LayoutMove[]): LayoutMap {
  const next: LayoutMap = { ...layout };
  for (const { from, to } of moves) {
    const at = next[from];
    if (at === undefined) continue;
    delete next[from];
    if (to !== null) next[to] = at;
  }
  return next;
}

interface Removal {
  kind: "step" | "tool";
  names: string[];
  opIndex: number;
}

interface Ctx {
  doc: Document;
  changes: OpChanges;
  layoutMoves: LayoutMove[];
  removals: Removal[];
  moves: number[];
}

const fail = (
  code: OpErrorCode,
  message: string,
  opIndex: number,
  path: Path = [],
  extra: Partial<OpError> = {},
): OpError => ({ code, message, path, opIndex, ...extra });

const versionOf = (raw: unknown): "1.0" | "1.1" =>
  isObj(raw) && raw.version === "1.1" ? "1.1" : "1.0";

function locateStep(raw: unknown, name: unknown, opIndex: number): RawStep | OpError {
  const hits = walkRawSteps(raw).filter((e) => e.name === name);
  if (hits.length === 0)
    return fail("step_not_found", `there is no step named "${String(name)}"`, opIndex);
  if (hits.length > 1) {
    return fail(
      "ambiguous_step",
      `${hits.length} steps are named "${String(name)}", so the name does not say which one: rename them first`,
      opIndex,
      hits[0]!.path,
    );
  }
  return hits[0]!;
}

const isError = (v: unknown): v is OpError =>
  isObj(v) && typeof v.code === "string" && typeof v.message === "string" && "opIndex" in v;

function invalidName(name: unknown, version: "1.0" | "1.1", loopVars: readonly string[]) {
  if (typeof name !== "string" || name.trim() === "") return "a name cannot be empty";
  if (/[`\n\r]/.test(name)) return "a name cannot contain a backtick or a line break";
  if (version === "1.1" && (EXPRESSION_ROOTS as readonly string[]).includes(name)) {
    return `"${name}" is a reserved name in a version "1.1" spec (an expression reads ${EXPRESSION_ROOTS.join(", ")} from the root)`;
  }
  if (version === "1.0" && !/^[A-Za-z0-9_]+$/.test(name)) {
    return `"${name}" cannot be written in a version "1.0" spec, whose references name only letters, digits and _`;
  }
  if (loopVars.includes(name)) {
    return `"${name}" is the loop variable of a foreach (its \`as\`), so no step can have that name`;
  }
  return undefined;
}

interface Resolved {
  listPath: Path;
  /** A branch arm that does not exist yet; the insert creates it. */
  create?: Path;
  length: number;
  inLoop: boolean;
  loopVars: string[];
}

function resolvePlace(raw: unknown, place: Place, opIndex: number): Resolved | OpError {
  const agent = isObj(raw) && isObj(raw.agent) ? raw.agent : undefined;
  if (place.in === "workflow") {
    const wf = agent?.workflow;
    return {
      listPath: WORKFLOW_PATH,
      length: Array.isArray(wf) ? wf.length : 0,
      inLoop: false,
      loopVars: [],
    };
  }
  const { step: parentName, slot, key } = place.in;
  const parent = locateStep(raw, parentName, opIndex);
  if (isError(parent)) return parent;
  const s = parent.step;
  const bad = (why: string) =>
    fail("slot_not_found", `step "${parentName}" ${why}`, opIndex, parent.path);
  const inLoop = parent.inLoop || slot === "steps";
  let loopVars = parent.loopVars;
  const done = (list: unknown, path: Path, createOk = false): Resolved | OpError => {
    if (Array.isArray(list)) return { listPath: path, length: list.length, inLoop, loopVars };
    if (createOk) return { listPath: path, create: path, length: 0, inLoop, loopVars };
    return bad(`has no ${slot}`);
  };
  if (slot === "steps") {
    if (!isObj(s.foreach)) return bad("is not a foreach");
    if (typeof s.foreach.as === "string") loopVars = [...loopVars, s.foreach.as];
    return done(s.foreach.steps, [...parent.path, "foreach", "steps"]);
  }
  const b = s.branch;
  if (!isObj(b)) return bad("is not a branch");
  const at = [...parent.path, "branch"];
  if (slot === "then")
    return "if" in b ? done(b.then, [...at, "then"]) : bad("is a switch, with no then");
  if (slot === "else") {
    return "if" in b ? done(b.else, [...at, "else"], true) : bad("is a switch, with no else");
  }
  if (slot === "default") {
    return "switch" in b
      ? done(b.default, [...at, "default"], true)
      : bad("is an if, with no default");
  }
  if (slot === "cases") {
    if (!("switch" in b) || !isObj(b.cases) || key === undefined) {
      return bad("has no such case: name the case in `key`");
    }
    if (!Array.isArray(b.cases[key])) return bad(`has no case "${key}"`);
    return done(b.cases[key], [...at, "cases", key]);
  }
  return bad(`has no slot "${String(slot)}"`);
}

function checkIndex(index: number | undefined, length: number, opIndex: number): number | OpError {
  const at = index ?? length;
  if (!Number.isInteger(at) || at < 0 || at > length) {
    return fail("bad_index", `index ${String(index)} is outside 0 to ${length}`, opIndex);
  }
  return at;
}

const NEW_KINDS = ["transform", "validate", "dedupe"];
const isNewKind = (s: Record<string, unknown>) =>
  "foreach" in s || "branch" in s || "stop" in s || NEW_KINDS.includes(String(s.type));

function checkPlacement(
  raw: unknown,
  subtree: Record<string, unknown>[],
  inLoop: boolean,
  opIndex: number,
): OpError | undefined {
  if (versionOf(raw) === "1.0") {
    const odd = subtree.find(isNewKind);
    if (odd) {
      return fail(
        "needs_version_1_1",
        `step "${String(odd.step)}" is a version "1.1" step kind and this spec is version "1.0": upgrade the spec first`,
        opIndex,
      );
    }
  }
  if (!inLoop) return undefined;
  const nested = subtree.find((s) => "foreach" in s);
  if (nested) {
    return fail(
      "nested_foreach",
      `a foreach inside a foreach is not supported yet (step "${String(nested.step)}")`,
      opIndex,
    );
  }
  const tools = rawTools(raw);
  const needsApproval = (toolName: unknown) =>
    tools.some((t) => t.tool.name === toolName && t.tool.requires_approval === true);
  for (const s of subtree) {
    let why: string | undefined;
    if (s.type === "approval") why = "is an approval step";
    else if (s.type === "tool" && needsApproval(s.tool)) {
      why = `uses tool "${String(s.tool)}", which requires approval`;
    } else if (s.type === "condition") {
      for (const v of [s.then, s.else]) {
        const m = typeof v === "string" ? new RegExp(EXECUTE_TOOL_SOURCE).exec(v) : null;
        if (v === "request_human_approval") why = "asks for human approval";
        else if (m && needsApproval(m[1])) why = `runs tool "${m[1]}", which requires approval`;
      }
    }
    if (why) {
      return fail(
        "approval_in_foreach",
        `step "${String(s.step)}" ${why}, which is not supported inside a foreach body yet (a loop cannot pause for a person; ADR-0043)`,
        opIndex,
      );
    }
  }
  return undefined;
}

const seqAt = (doc: Document, path: Path) => {
  const node = doc.getIn(path, true);
  return isSeq(node) ? node : undefined;
};

/** Reads that the rename cannot spell with the new name, or cannot find in the text. */
function rewrite(
  ctx: Ctx,
  occs: Occurrence[],
  newName: string,
  opIndex: number,
  what: string,
): OpError | undefined {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occs) {
    if (o.simple && !/^[A-Za-z0-9_]+$/.test(newName) && o.kind !== "tool") {
      return fail(
        "invalid_name",
        `"${newName}" cannot be used: ${what} is read as ${o.kind === "execute_tool" ? "execute_tool(name)" : o.text}, which can name only letters, digits and _`,
        opIndex,
        o.path,
      );
    }
    const key = JSON.stringify(o.path);
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  for (const group of groups.values()) {
    const path = group[0]!.path;
    const current = ctx.doc.getIn(path);
    if (typeof current !== "string" || group.some((o) => o.unverified || current !== o.field)) {
      return fail(
        "unrewritable",
        `${what} is read in a place that cannot be rewritten with certainty: edit it by hand`,
        opIndex,
        path,
      );
    }
    let text = current;
    for (const o of [...group].sort((a, b) => b.start - a.start)) {
      const replacement = o.simple ? newName : expressionName(newName);
      text = text.slice(0, o.start) + replacement + text.slice(o.end);
    }
    ctx.doc.setIn(path, text);
    ctx.changes.rewrote += group.length;
  }
  return undefined;
}

/** Every foreach loop variable in the workflow: a step cannot share a name with one (schema rule). */
function allLoopVars(raw: unknown): string[] {
  return walkRawSteps(raw).flatMap((e) =>
    isObj(e.step.foreach) && typeof e.step.foreach.as === "string" ? [e.step.foreach.as] : [],
  );
}

function toolNames(raw: unknown): string[] {
  return rawTools(raw).map((t) => String(t.tool.name));
}

function applySemantic(
  ctx: Ctx,
  op: Exclude<SpecOp, PatchOp>,
  opIndex: number,
): OpError | undefined {
  const raw = ctx.doc.toJS();
  const version = versionOf(raw);

  if (op.op === "step.insert") {
    const step = op.step;
    if (!isObj(step) || typeof step.step !== "string") {
      return fail("invalid_step", "a step to insert must be an object with a `step` name", opIndex);
    }
    const at = resolvePlace(raw, op.place, opIndex);
    if (isError(at)) return at;
    const index = checkIndex(op.place.index, at.length, opIndex);
    if (isError(index)) return index;
    const subtree = subtreeSteps(step);
    const placed = checkPlacement(raw, subtree, at.inLoop, opIndex);
    if (placed) return placed;
    const taken = new Set(walkRawSteps(raw).map((e) => e.name));
    for (const s of subtree) {
      const why = invalidName(s.step, version, allLoopVars(raw));
      if (why) return fail("invalid_name", why, opIndex);
      if (taken.has(String(s.step))) {
        return fail(
          "name_taken",
          `a step is already named "${String(s.step)}" (a step name is used once per workflow, branches and foreach bodies included)`,
          opIndex,
        );
      }
      taken.add(String(s.step));
    }
    for (const s of subtree) {
      const as = isObj(s.foreach) ? s.foreach.as : undefined;
      if (typeof as === "string" && taken.has(as)) {
        return fail(
          "invalid_name",
          `the loop variable "${as}" is also the name of a step: rename one of them`,
          opIndex,
        );
      }
    }
    if (at.create) ctx.doc.setIn(at.create, ctx.doc.createNode([]));
    const seq = seqAt(ctx.doc, at.listPath);
    if (!seq)
      return fail("slot_not_found", "the list to insert into is not a list", opIndex, at.listPath);
    seq.items.splice(index, 0, ctx.doc.createNode(step));
    return undefined;
  }

  if (op.op === "step.remove") {
    const entry = locateStep(raw, op.step, opIndex);
    if (isError(entry)) return entry;
    const seq = seqAt(ctx.doc, entry.list);
    if (!seq) return fail("slot_not_found", "the step is not in a list", opIndex, entry.path);
    seq.items.splice(entry.index, 1);
    const names = subtreeSteps(entry.step).map((s) => String(s.step));
    ctx.removals.push({ kind: "step", names, opIndex });
    ctx.changes.removed.push({ kind: "step", name: entry.name });
    for (const n of names) ctx.layoutMoves.push({ from: `workflow:${n}`, to: null });
    return undefined;
  }

  if (op.op === "step.move") {
    const entry = locateStep(raw, op.step, opIndex);
    if (isError(entry)) return entry;
    const target = resolvePlace(raw, op.to, opIndex);
    if (isError(target)) return target;
    const within = target.listPath.slice(0, entry.path.length);
    if (entry.path.every((seg, i) => within[i] === seg)) {
      return fail(
        "move_into_self",
        `step "${op.step}" cannot move into its own body or arms`,
        opIndex,
        entry.path,
      );
    }
    const placed = checkPlacement(raw, subtreeSteps(entry.step), target.inLoop, opIndex);
    if (placed) return placed;
    const from = seqAt(ctx.doc, entry.list);
    if (!from) return fail("slot_not_found", "the step is not in a list", opIndex, entry.path);
    const [node] = from.items.splice(entry.index, 1);
    // The target is found again now that the list has one fewer item: `index` is the final position.
    const after = resolvePlace(ctx.doc.toJS(), op.to, opIndex);
    if (isError(after)) return after;
    const index = checkIndex(op.to.index, after.length, opIndex);
    if (isError(index)) return index;
    if (after.create) ctx.doc.setIn(after.create, ctx.doc.createNode([]));
    const into = seqAt(ctx.doc, after.listPath);
    if (!into)
      return fail("slot_not_found", "the list to move into is not a list", opIndex, after.listPath);
    into.items.splice(index, 0, node);
    ctx.moves.push(opIndex);
    return undefined;
  }

  if (op.op === "step.rename") {
    const entry = locateStep(raw, op.step, opIndex);
    if (isError(entry)) return entry;
    if (op.to === op.step) return undefined;
    const why = invalidName(op.to, version, allLoopVars(raw));
    if (why) return fail("invalid_name", why, opIndex, [...entry.path, "step"]);
    if (walkRawSteps(raw).some((e) => e.name === op.to)) {
      return fail(
        "name_taken",
        `a step is already named "${op.to}" (a step name is used once per workflow, branches and foreach bodies included)`,
        opIndex,
        [...entry.path, "step"],
      );
    }
    const bad = rewrite(
      ctx,
      occurrencesFor(raw, { step: op.step }),
      op.to,
      opIndex,
      `step "${op.step}"`,
    );
    if (bad) return bad;
    ctx.doc.setIn([...entry.path, "step"], op.to);
    ctx.changes.renamed.push({ kind: "step", from: op.step, to: op.to });
    ctx.layoutMoves.push({ from: `workflow:${op.step}`, to: `workflow:${op.to}` });
    return undefined;
  }

  // tool.remove, tool.rename
  const hits = rawTools(raw).filter((t) => t.tool.name === op.tool);
  const hit = hits[0];
  if (!hit) return fail("tool_not_found", `there is no tool named "${op.tool}"`, opIndex);
  const at: Path = ["agent", "tools", hit.index];
  if (op.op === "tool.remove") {
    ctx.doc.deleteIn(at);
    const rest = ctx.doc.getIn(["agent", "tools"], true);
    if (isSeq(rest) && rest.items.length === 0) ctx.doc.deleteIn(["agent", "tools"]);
    ctx.removals.push({ kind: "tool", names: [op.tool], opIndex });
    ctx.changes.removed.push({ kind: "tool", name: op.tool });
    ctx.layoutMoves.push({ from: `tool:${op.tool}`, to: null });
    return undefined;
  }
  if (op.to === op.tool) return undefined;
  if (typeof op.to !== "string" || op.to.trim() === "") {
    return fail("invalid_name", "a name cannot be empty", opIndex, [...at, "name"]);
  }
  if (toolNames(raw).includes(op.to)) {
    return fail("name_taken", `a tool is already named "${op.to}"`, opIndex, [...at, "name"]);
  }
  const bad = rewrite(
    ctx,
    occurrencesFor(raw, { tool: op.tool }),
    op.to,
    opIndex,
    `tool "${op.tool}"`,
  );
  if (bad) return bad;
  ctx.doc.setIn([...at, "name"], op.to);
  ctx.changes.renamed.push({ kind: "tool", from: op.tool, to: op.to });
  ctx.layoutMoves.push({ from: `tool:${op.tool}`, to: `tool:${op.to}` });
  return undefined;
}

/** Reader/writer pairs where a step reads another that runs after it (document order). */
function orderViolations(raw: unknown): Map<string, Occurrence> {
  const order = new Map<string, number>();
  const dupes = new Set<string>();
  for (const e of walkRawSteps(raw)) {
    if (order.has(e.name)) dupes.add(e.name);
    order.set(e.name, e.order);
  }
  const out = new Map<string, Occurrence>();
  for (const o of scanOccurrences(raw)) {
    if (o.target !== "step" || o.readerOrder === undefined || dupes.has(o.name)) continue;
    const written = order.get(o.name);
    if (written !== undefined && o.readerOrder < written) {
      out.set(`${o.reader}->${o.name}`, o);
    }
  }
  return out;
}

const SCOPE_MESSAGE =
  /not something an expression can read|is a step in another arm|is not available/;
const errorKey = (e: SpecError) => `${JSON.stringify(e.path)}|${e.message}`;

/**
 * Applies `ops` in order to the document in `source`, then validates the result once. Nothing is returned
 * as saved: the caller decides how to persist `source` (ADR-0014, ADR-0055).
 */
export function applyOpsToSource(source: string, ops: SpecOp[]): ApplyOpsToSourceResult {
  const initial = parseSpec(source);
  const doc = initial.doc;
  const ctx: Ctx = {
    doc,
    changes: { renamed: [], removed: [], rewrote: 0 },
    layoutMoves: [],
    removals: [],
    moves: [],
  };
  const hasSemantic = ops.some((op) => !isPatchOp(op));
  if (doc.errors.length > 0) {
    return { success: false, errors: initial.errors, source };
  }
  const before = hasSemantic ? doc.toJS() : undefined;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (isPatchOp(op)) {
      applyPatch(doc, [op]);
      continue;
    }
    const error = applySemantic(ctx, op, i);
    if (error) return { success: false, errors: [error], source };
  }

  const nextSource = toYamlString(doc);
  const result = parseSpec(nextSource);
  if (result.doc.errors.length > 0) {
    return { success: false, errors: result.errors, source };
  }

  if (hasSemantic) {
    const after = result.doc.toJS();
    // A refusal is reported against the file the author has (nothing was written), not the edited copy: a
    // read is matched to the same read in `source` by its reader, its field inside the reader and its offset.
    const pristine = parseSpec(source).doc;
    const keyOf = (o: Occurrence) => `${o.reader}|${JSON.stringify(o.rel)}|${o.start}|${o.name}`;
    const originals = new Map<string, Occurrence>();
    for (const o of scanOccurrences(before)) originals.set(keyOf(o), o);
    const refs = (occs: Occurrence[]): Reference[] => {
      const seen = new Set<string>();
      const out: Reference[] = [];
      for (const o of occs) {
        const orig = originals.get(keyOf(o));
        const path = (orig ?? o).path;
        const key = JSON.stringify(path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path,
          kind: o.kind,
          text: o.text,
          line: orig ? lineOfPath(pristine, source, path) : undefined,
        });
      }
      return out;
    };
    const present = new Set(walkRawSteps(after).map((e) => e.name));
    const presentTools = new Set(toolNames(after));
    const errors: OpError[] = [];
    for (const r of ctx.removals) {
      const gone = r.names.filter((n) => !(r.kind === "step" ? present : presentTools).has(n));
      const occs = gone.flatMap((n) =>
        occurrencesFor(after, r.kind === "step" ? { step: n } : { tool: n }),
      );
      if (occs.length > 0) {
        const where = r.kind === "step" ? "step" : "tool";
        const found = refs(occs);
        errors.push(
          fail(
            "has_references",
            `${where} "${gone[0]}" is read in ${found.length} place${found.length === 1 ? "" : "s"}: edit or remove them first`,
            r.opIndex,
            found[0]!.path,
            { references: found, line: found[0]!.line },
          ),
        );
      }
    }
    if (errors.length > 0) return { success: false, errors, source };

    if (ctx.moves.length > 0 && before) {
      const was = orderViolations(before);
      const broken = [...orderViolations(after)].filter(([key]) => !was.has(key));
      if (broken.length > 0) {
        const found = refs(broken.map(([, o]) => o));
        const names = broken.map(([key]) => key.replace("->", " reads ")).join(", ");
        return {
          success: false,
          errors: [
            fail(
              "breaks_references",
              `the move puts a step before one it reads (${names}): move them together or edit the read`,
              ctx.moves[0]!,
              found[0]!.path,
              { references: found, line: found[0]!.line },
            ),
          ],
          source,
        };
      }
    }
  }

  if (!result.success) {
    if (ctx.moves.length > 0) {
      const known = new Set(initial.errors.map(errorKey));
      const scope = result.errors.filter(
        (e) => !known.has(errorKey(e)) && SCOPE_MESSAGE.test(e.message),
      );
      if (scope.length > 0) {
        return {
          success: false,
          errors: scope.map((e) => ({
            ...e,
            code: "breaks_references" as const,
            opIndex: ctx.moves[0]!,
            references: [
              { path: e.path, kind: "expression" as const, text: e.message, line: e.line },
            ],
          })),
          source,
        };
      }
    }
    return { success: false, errors: result.errors, source };
  }

  return {
    success: true,
    source: nextSource,
    spec: result.spec,
    changes: ctx.changes,
    layoutMoves: ctx.layoutMoves,
  };
}
