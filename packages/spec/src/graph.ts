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
  column: number;
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
