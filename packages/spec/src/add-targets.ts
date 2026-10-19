import {
  expressionScopeForLoopBody,
  expressionScopeForStepAt,
  type ExpressionScope,
} from "./expression-assist.js";
import type { Place } from "./ops.js";
import type { AgentSpec } from "./schema.js";
import { listSteps } from "./step-edit.js";

// Where "Add Workflow Step" can put a new step besides the end of the workflow (KAM-153, KAM-154): the end of a
// foreach's body, or the end of a branch's arm. An else or a default that is not there yet is offered too, since
// adding a step to it creates it (ADR-0055). The place is the ADR's place JSON, ready for a `step.insert`.

export interface AddTarget {
  /** Stable within one spec, for a select's value. */
  id: string;
  label: string;
  place: Place;
  /** What an expression in the new step can read there. */
  scope: ExpressionScope;
}

export function addTargets(spec: AgentSpec): AddTarget[] {
  if (spec.version !== "1.1") return [];
  const out: AddTarget[] = [];
  for (const ref of listSteps(spec)) {
    const step = ref.step;
    if ("foreach" in step) {
      out.push({
        id: `${ref.name}/steps`,
        label: `Inside ${ref.name} (the loop's body)`,
        place: { in: { step: ref.name, slot: "steps" } },
        scope: expressionScopeForLoopBody(spec, ref.name),
      });
    } else if ("branch" in step) {
      const scope = expressionScopeForStepAt(spec, ref.path);
      const arm = (slot: "then" | "else" | "cases" | "default", key?: string) => {
        const name = key === undefined ? slot : `case ${key}`;
        out.push({
          id: `${ref.name}/${slot}${key === undefined ? "" : `/${key}`}`,
          label: `Inside ${ref.name} (${name})`,
          place: { in: { step: ref.name, slot, ...(key !== undefined && { key }) } },
          scope,
        });
      };
      const b = step.branch;
      if ("if" in b) {
        arm("then");
        arm("else");
      } else {
        for (const key of Object.keys(b.cases)) arm("cases", key);
        arm("default");
      }
    }
  }
  return out;
}
