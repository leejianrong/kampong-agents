import type { AgentSpec } from "./schema.js";

// Maps a validated AgentSpec to the node/edge graph the canvas renders
// (PLAN.md affordance: "Block canvas (Trigger -> Tools -> Workflow ->
// Guardrails)"). Kept in @kampong/spec, not the canvas app, so both the
// canvas and any future headless tooling (e.g. a `kampong graph` CLI
// command) share one definition of "what a spec looks like as a graph."

export type NodeKind = "agent" | "tool" | "workflow" | "guardrails";

export interface SpecNode {
  id: string;
  kind: NodeKind;
  /** Where it sits: whole numbers are the main columns; a foreach's body steps sit a little to the right of theirs. */
  column: number;
  /** For a step inside a foreach body: the id of that foreach node (KAM-153). */
  parent?: string;
  data: Record<string, unknown>;
}

export interface SpecEdge {
  id: string;
  source: string;
  target: string;
}

export interface SpecGraph {
  nodes: SpecNode[];
  edges: SpecEdge[];
}

const COLUMN: Record<NodeKind, number> = { agent: 0, tool: 1, workflow: 2, guardrails: 3 };
// A foreach body step is its own node, indented from the loop that holds it. Part of a column, so the auto layout
// still gives it a row in run order (layout.ts counts rows by whole column).
const BODY_COLUMN = COLUMN.workflow + 0.2;

export function specToGraph(spec: AgentSpec): SpecGraph {
  const nodes: SpecNode[] = [];
  const edges: SpecEdge[] = [];

  const agentId = `agent:${spec.agent.id}`;
  nodes.push({
    id: agentId,
    kind: "agent",
    column: COLUMN.agent,
    data: { name: spec.agent.name, role: spec.agent.role, goal: spec.agent.goal },
  });

  for (const tool of spec.agent.tools ?? []) {
    nodes.push({
      id: `tool:${tool.name}`,
      kind: "tool",
      column: COLUMN.tool,
      data: { ...tool },
    });
  }

  let previousId = agentId;
  for (const step of spec.agent.workflow) {
    const id = `workflow:${step.step}`;
    nodes.push({ id, kind: "workflow", column: COLUMN.workflow, data: { ...step } });
    edges.push({ id: `${previousId}->${id}`, source: previousId, target: id });
    previousId = id;
    // The body runs inside the loop, so the chain goes through it: loop -> first body step -> ... -> next step.
    // A branch inside the body still lists its own arms in its node; only a foreach's steps are nodes here.
    if ("foreach" in step) {
      for (const inner of step.foreach.steps) {
        const innerId = `workflow:${inner.step}`;
        nodes.push({
          id: innerId,
          kind: "workflow",
          column: BODY_COLUMN,
          parent: id,
          data: { ...(inner as Record<string, unknown>) },
        });
        edges.push({ id: `${previousId}->${innerId}`, source: previousId, target: innerId });
        previousId = innerId;
      }
    }
  }

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
