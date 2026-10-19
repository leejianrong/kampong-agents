import {
  expressionScopeForLoopBody,
  expressionScopeForStepAt,
  type ExpressionScope,
} from "./expression-assist.js";
import type { SpecGraph } from "./graph.js";
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
  /** How the list is named in plain words, for a position: `each_symbol`, `anomaly (else)`. */
  where: string;
  /** The names of the steps already in the list, in order, for "after fetch". */
  steps: string[];
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
        where: ref.name,
        steps: step.foreach.steps.map((s) => s.step),
        scope: expressionScopeForLoopBody(spec, ref.name),
      });
    } else if ("branch" in step) {
      const scope = expressionScopeForStepAt(spec, ref.path);
      const arm = (
        slot: "then" | "else" | "cases" | "default",
        list: readonly { step: string }[] | undefined,
        key?: string,
      ) => {
        const name = key === undefined ? slot : `case ${key}`;
        out.push({
          id: `${ref.name}/${slot}${key === undefined ? "" : `/${key}`}`,
          label: `Inside ${ref.name} (${name})`,
          place: { in: { step: ref.name, slot, ...(key !== undefined && { key }) } },
          where: `${ref.name} (${name})`,
          steps: (list ?? []).map((s) => s.step),
          scope,
        });
      };
      const b = step.branch;
      if ("if" in b) {
        arm("then", b.then);
        arm("else", b.else);
      } else {
        for (const [key, list] of Object.entries(b.cases)) arm("cases", list, key);
        arm("default", b.default);
      }
    }
  }
  return out;
}

/** One choice of position in a list: `index` is where the step goes, and is left out for the end. */
export interface PositionChoice {
  value: string;
  label: string;
  index?: number;
}

/**
 * The positions a new step can take in a list, in plain words and by step name, not by number: the end (first, the
 * default), the start, and after each step already there. `where` is `the workflow` or a target's `where`.
 */
export function positionChoices(where: string, steps: readonly string[]): PositionChoice[] {
  return [
    { value: "end", label: `At the end of ${where}` },
    ...(steps.length > 0 ? [{ value: "start", label: `At the start of ${where}`, index: 0 }] : []),
    ...steps.map((name, i) => ({ value: `after:${i}`, label: `After ${name}`, index: i + 1 })),
  ];
}

/** The place and index as the canvas shows them: next to which node the new step will land. */
export interface InsertionMarker {
  /** The node the marker sits beside. */
  anchor: string;
  side: "above" | "below";
  label: string;
}

/** The last node in run order of the step `id` and everything inside it (a loop's body, a branch's arms). */
function lastNodeOf(graph: SpecGraph, id: string): string {
  const inside = graph.nodes.filter((n) => n.parent === id);
  const last = inside.at(-1);
  return last ? lastNodeOf(graph, last.id) : id;
}

/**
 * Where to draw the "new step goes here" marker for a list (`holder` is the loop or branch it belongs to, or
 * undefined for the workflow) and the names in it: above the step the new one lands before, else below the last
 * step of the list (with all that is inside it), else below the holder, else below the trigger.
 */
export function insertionMarker(
  graph: SpecGraph,
  holder: string | undefined,
  steps: readonly string[],
  index: number | undefined,
): InsertionMarker | undefined {
  const at = index ?? steps.length;
  const label = "New step goes here";
  if (at < steps.length) return { anchor: `workflow:${steps[at]}`, side: "above", label };
  if (steps.length > 0) {
    return {
      anchor: lastNodeOf(graph, `workflow:${steps[steps.length - 1]}`),
      side: "below",
      label,
    };
  }
  const anchor =
    holder !== undefined ? `workflow:${holder}` : graph.nodes.find((n) => n.kind === "agent")?.id;
  return anchor === undefined ? undefined : { anchor, side: "below", label };
}

/** The names of the steps at the top of the workflow, for the default list. */
export function workflowStepNames(spec: AgentSpec): string[] {
  return spec.agent.workflow.map((s) => s.step);
}
