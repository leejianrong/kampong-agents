import { listSteps, type AgentSpec, type Place, type Tool, type WorkflowStep } from "@kampong/spec";
import { listOf } from "./StepsPanel.js";

// Duplicate a step or a tool from the node inspector (KAM-211). The copy gets a name nothing else has, so it
// goes through the same `step.insert` (or the raw add for a tool) as any new one and the server's own checks
// still apply.

/** `base_copy`, then `base_copy2`, `base_copy3` ... the first name not in `taken`. The name is added to `taken`. */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = `${base}_copy`;
  for (let n = 2; taken.has(name); n++) name = `${base}_copy${n}`;
  taken.add(name);
  return name;
}

type Raw = Record<string, unknown>;

/** Renames a step and every step inside it (a loop body, a branch's arms), so the whole copy is new names. */
function renameSubtree(step: Raw, taken: Set<string>): Raw {
  const copy: Raw = { ...step, step: uniqueName(String(step.step), taken) };
  const renameList = (list: unknown) => (list as Raw[]).map((child) => renameSubtree(child, taken));
  if (copy.foreach && typeof copy.foreach === "object") {
    const loop = copy.foreach as Raw;
    copy.foreach = { ...loop, steps: renameList(loop.steps) };
  }
  if (copy.branch && typeof copy.branch === "object") {
    const branch = copy.branch as Raw;
    const next: Raw = { ...branch };
    for (const slot of ["then", "else", "default"]) {
      if (Array.isArray(branch[slot])) next[slot] = renameList(branch[slot]);
    }
    if (branch.cases && typeof branch.cases === "object") {
      next.cases = Object.fromEntries(
        Object.entries(branch.cases as Raw).map(([key, arm]) => [key, renameList(arm)]),
      );
    }
    copy.branch = next;
  }
  return copy;
}

/** The copy of a step and where it goes: right after the original, in the same list. Null when there is no such step. */
export function duplicateStep(
  spec: AgentSpec,
  name: string,
): { place: Place; step: WorkflowStep } | null {
  const refs = listSteps(spec);
  const ref = refs.find((r) => r.name === name);
  if (!ref) return null;
  const { place, index } = listOf(refs, ref);
  const taken = new Set(refs.map((r) => r.name));
  const step = renameSubtree(structuredClone(ref.step) as unknown as Raw, taken);
  return { place: { in: place, index: index + 1 }, step: step as unknown as WorkflowStep };
}

/** The copy of a tool, to be added at the end of `agent.tools`. Null when there is no such tool. */
export function duplicateTool(spec: AgentSpec, name: string): Tool | null {
  const tools = spec.agent.tools ?? [];
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  return { ...structuredClone(tool), name: uniqueName(name, new Set(tools.map((t) => t.name))) };
}
