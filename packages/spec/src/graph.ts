import type { AgentSpec, WorkflowStep } from "./schema.js";
import { triggerSummary } from "./trigger-summary.js";

// Maps a validated AgentSpec to the node/edge graph the canvas renders
// (PLAN.md affordance: "Block canvas (Trigger -> Tools -> Workflow ->
// Guardrails)"). Kept in @kampong/spec, not the canvas app, so both the
// canvas and any future headless tooling (e.g. a `kampong graph` CLI
// command) share one definition of "what a spec looks like as a graph."

export type NodeKind = "agent" | "tool" | "workflow" | "guardrails";

export interface SpecNode {
  id: string;
  kind: NodeKind;
  /** Where it sits: whole numbers are the main columns; steps inside a foreach or a branch arm sit a little to the right of theirs. */
  column: number;
  /** For a step inside a foreach body or a branch arm: the id of that foreach or branch node (KAM-153, KAM-154). */
  parent?: string;
  /** For a step in a branch arm: which one (`then`, `else`, `case bug`, `default`). */
  arm?: string;
  data: Record<string, unknown>;
}

export interface SpecEdge {
  id: string;
  source: string;
  target: string;
  /** For an edge out of a branch: which arm it takes, or what happens when none does. */
  label?: string;
}

export interface SpecGraph {
  nodes: SpecNode[];
  edges: SpecEdge[];
}

const COLUMN: Record<NodeKind, number> = { agent: 0, tool: 1, workflow: 2, guardrails: 3 };
// A step inside a loop or an arm is its own node, set in from the step that holds it, a fifth of a column per level.
// Part of a column, so the auto layout still gives it a row in run order (layout.ts counts rows by whole column).
const INDENT = 0.2;

/** Where the run is after a step: the nodes the next step is reached from, and the label of the edge it takes. */
interface Exit {
  id: string;
  label?: string;
}

/** A branch's arms, in the order the loader and the canvas read them, and whether one is missing (the fall-through). */
function armsOf(step: Extract<WorkflowStep, { branch: unknown }>): {
  arms: { label: string; steps: readonly WorkflowStep[] }[];
  fallsThrough?: string;
} {
  const b = step.branch;
  if ("if" in b) {
    return {
      arms: [
        { label: "then", steps: b.then },
        ...(b.else ? [{ label: "else", steps: b.else }] : []),
      ],
      ...(b.else ? {} : { fallsThrough: "else" }),
    };
  }
  return {
    arms: [
      ...Object.entries(b.cases).map(([value, steps]) => ({ label: `case ${value}`, steps })),
      ...(b.default ? [{ label: "default", steps: b.default }] : []),
    ],
    ...(b.default ? {} : { fallsThrough: "no case" }),
  };
}

export function specToGraph(spec: AgentSpec): SpecGraph {
  const nodes: SpecNode[] = [];
  const edges: SpecEdge[] = [];

  const agentId = `agent:${spec.agent.id}`;
  nodes.push({
    id: agentId,
    kind: "agent",
    column: COLUMN.agent,
    data: {
      name: spec.agent.name,
      role: spec.agent.role,
      goal: spec.agent.goal,
      // What starts a run, in a few words, for the trigger node (KAM-184).
      triggerLabel: triggerSummary(spec.agent.trigger),
    },
  });

  for (const tool of spec.agent.tools ?? []) {
    nodes.push({
      id: `tool:${tool.name}`,
      kind: "tool",
      column: COLUMN.tool,
      data: { ...tool },
    });
  }

  // Walks a list of steps in run order, joining each to where the run was. A foreach's body runs inside the loop
  // (loop -> first body step -> ... -> next step). A branch leads to the first step of each arm, and every arm that
  // does not end the run leads on to the next step; a missing else (or default) goes straight on. A stop ends it.
  const walk = (
    list: readonly WorkflowStep[],
    from: Exit[],
    depth: number,
    holder?: { id: string; arm?: string },
  ): Exit[] => {
    let at = from;
    for (const step of list) {
      const id = `workflow:${step.step}`;
      nodes.push({
        id,
        kind: "workflow",
        column: COLUMN.workflow + INDENT * depth,
        ...(holder && { parent: holder.id }),
        ...(holder?.arm !== undefined && { arm: holder.arm }),
        data: { ...(step as unknown as Record<string, unknown>) },
      });
      for (const exit of at) {
        edges.push({
          id: `${exit.id}->${id}`,
          source: exit.id,
          target: id,
          ...(exit.label !== undefined && { label: exit.label }),
        });
      }
      if ("foreach" in step) {
        at = walk(step.foreach.steps as WorkflowStep[], [{ id }], depth + 1, { id });
      } else if ("branch" in step) {
        const { arms, fallsThrough } = armsOf(step);
        at = arms.flatMap((arm) =>
          walk(arm.steps, [{ id, label: arm.label }], depth + 1, { id, arm: arm.label }),
        );
        if (fallsThrough !== undefined) at.push({ id, label: fallsThrough });
      } else if ("stop" in step) {
        at = [];
      } else {
        at = [{ id }];
      }
    }
    return at;
  };
  walk(spec.agent.workflow, [{ id: agentId }], 0);

  if (spec.agent.guardrails) {
    nodes.push({
      id: `guardrails:${spec.agent.id}`,
      kind: "guardrails",
      column: COLUMN.guardrails,
      data: { ...spec.agent.guardrails },
    });
  }

  return { nodes, edges };
}
