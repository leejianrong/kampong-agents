import { addTargets, listSteps, type AgentSpec } from "@kampong/spec";
import { listOf } from "./StepsPanel.js";

/**
 * The "Add to" and "Position" values of the Add Workflow Step form that put a new step right before the step
 * called `name`, in whichever list that step is in (the workflow, a loop's body, a branch's arm), so the insert
 * is the existing `step.insert` op at that place (KAM-213). Undefined when there is no such step.
 */
export function spotBeforeStep(
  spec: AgentSpec,
  name: string,
): { targetId: string; position: string } | undefined {
  const refs = listSteps(spec);
  const ref = refs.find((r) => r.name === name);
  if (!ref) return undefined;
  const { place, index } = listOf(refs, ref);
  const position = index === 0 ? "start" : `after:${index - 1}`;
  if (place === "workflow") return { targetId: "", position };
  const target = addTargets(spec).find((t) => {
    const p = t.place.in;
    return (
      typeof p === "object" && p.step === place.step && p.slot === place.slot && p.key === place.key
    );
  });
  // A list the form cannot name (a 1.0 spec has none inside a step): leave the choice to the user.
  return target ? { targetId: target.id, position } : undefined;
}
