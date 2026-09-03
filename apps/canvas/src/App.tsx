import "@xyflow/react/dist/style.css";
import { ReactFlow, type Node } from "@xyflow/react";

// Local web canvas app (PLAN.md Shape S2, ADR-0005/0007: React + @xyflow/react
// served locally by the CLI, not a desktop shell). Any UI built here uses
// Material Design 3 rather than ad hoc styling. Real read/write against
// AgentSpec YAML lands with SLICES.md V1 — this is scaffolding only, to prove
// the build/lint/test pipeline with the chosen stack wired in.

const SCAFFOLD_NODES: Node[] = [
  { id: "trigger", position: { x: 0, y: 0 }, data: { label: "Trigger" } },
];

export function App() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow nodes={SCAFFOLD_NODES} />
    </div>
  );
}
