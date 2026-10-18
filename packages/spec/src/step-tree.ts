// A tolerant walk over the raw (parsed, not yet validated) workflow, for the step operations and the
// reference scan (ADR-0055). It reads the document as plain data, so it works on a spec that does not
// validate yet; the validator stays the judge of what is legal.

export type Path = (string | number)[];

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface RawStep {
  name: string;
  /** Where the step is in the document, for `Document.getIn`. */
  path: Path;
  /** The list it sits in, and its index there. */
  list: Path;
  index: number;
  /** Names of the foreach and branch steps it sits inside, outermost first. */
  within: string[];
  /** The `as` of each foreach it sits inside (the loop variables in scope). */
  loopVars: string[];
  /** True inside a foreach body, at any depth. */
  inLoop: boolean;
  /** Position in document order (a parent before its body or arms). */
  order: number;
  step: Record<string, unknown>;
}

/** The step lists a branch holds, each with its key under the step. */
export function armsOf(step: Record<string, unknown>): { key: Path; list: unknown[] }[] {
  const out: { key: Path; list: unknown[] }[] = [];
  const b = step.branch;
  if (!isObj(b)) return out;
  if (Array.isArray(b.then)) out.push({ key: ["branch", "then"], list: b.then });
  if (Array.isArray(b.else)) out.push({ key: ["branch", "else"], list: b.else });
  if (isObj(b.cases)) {
    for (const [key, list] of Object.entries(b.cases)) {
      if (Array.isArray(list)) out.push({ key: ["branch", "cases", key], list });
    }
  }
  if (Array.isArray(b.default)) out.push({ key: ["branch", "default"], list: b.default });
  return out;
}

export const WORKFLOW_PATH: Path = ["agent", "workflow"];

/** Every step, in document order, with a foreach body and a branch's arms after their parent. */
export function walkRawSteps(raw: unknown): RawStep[] {
  const out: RawStep[] = [];
  const agent = isObj(raw) ? raw.agent : undefined;
  const root = isObj(agent) ? agent.workflow : undefined;
  const walk = (
    list: unknown[],
    listPath: Path,
    within: string[],
    loopVars: string[],
    inLoop: boolean,
  ) => {
    list.forEach((s, index) => {
      if (!isObj(s) || typeof s.step !== "string") return;
      const path = [...listPath, index];
      out.push({
        name: s.step,
        path,
        list: listPath,
        index,
        within,
        loopVars,
        inLoop,
        order: out.length,
        step: s,
      });
      const inside = [...within, s.step];
      if (isObj(s.foreach) && Array.isArray(s.foreach.steps)) {
        const as = typeof s.foreach.as === "string" ? [s.foreach.as] : [];
        walk(s.foreach.steps, [...path, "foreach", "steps"], inside, [...loopVars, ...as], true);
      }
      for (const arm of armsOf(s)) {
        walk(arm.list, [...path, ...arm.key], inside, loopVars, inLoop);
      }
    });
  };
  if (Array.isArray(root)) walk(root, WORKFLOW_PATH, [], [], false);
  return out;
}

/** A step and every step inside it (its foreach body and branch arms). */
export function subtreeSteps(step: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [step];
  const inner: unknown[] = [];
  if (isObj(step.foreach) && Array.isArray(step.foreach.steps)) inner.push(...step.foreach.steps);
  for (const arm of armsOf(step)) inner.push(...arm.list);
  for (const s of inner) if (isObj(s)) out.push(...subtreeSteps(s));
  return out;
}

/** Every tool with its index in `agent.tools`. */
export function rawTools(raw: unknown): { index: number; tool: Record<string, unknown> }[] {
  const agent = isObj(raw) ? raw.agent : undefined;
  const tools = isObj(agent) ? agent.tools : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool, index) => (isObj(tool) ? [{ index, tool }] : []));
}
