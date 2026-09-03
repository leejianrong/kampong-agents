import {
  specToGraph,
  type AgentSpec,
  type Guardrails,
  type Tool,
  type WorkflowStep,
} from "@kampong/spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, type ApiClient } from "./api.js";
import { Canvas } from "./Canvas.js";
import { GuardrailsForm } from "./GuardrailsForm.js";
import { RunPanel } from "./RunPanel.js";
import { ToolForm } from "./ToolForm.js";
import { WorkflowStepForm } from "./WorkflowStepForm.js";
import { YamlPreview } from "./YamlPreview.js";

// The canvas app's top-level orchestration (PLAN.md Shape S2). Owns the
// fetch-on-mount + SSE-subscribe lifecycle; ADR-0008's auto-reload-by-
// default lives here as the difference between a silent "reload" refetch
// and a "conflict" banner the user has to act on.

export interface AppProps {
  apiBaseUrl?: string;
}

type OpenForm = "tool" | "workflow" | "guardrails" | "run" | null;

export function App({ apiBaseUrl = "" }: AppProps) {
  const api = useMemo<ApiClient>(() => createApiClient(apiBaseUrl), [apiBaseUrl]);

  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [source, setSource] = useState("");
  const [layout, setLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [errors, setErrors] = useState<{ path: (string | number)[]; message: string }[]>([]);
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  const [conflict, setConflict] = useState(false);

  const refresh = useCallback(async () => {
    const result = await api.loadSpec();
    setErrors(result.errors ?? []);
    setSource(result.source);
    setLayout(result.layout);
    if (result.success && result.spec) {
      setSpec(result.spec as AgentSpec);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const unsubscribe = api.subscribeToEvents((event) => {
      if (event.type === "conflict") {
        setConflict(true);
        return;
      }
      if (event.type === "reload") {
        void refresh();
      }
    });
    return unsubscribe;
  }, [api, refresh]);

  const graph = useMemo(() => (spec ? specToGraph(spec) : { nodes: [], edges: [] }), [spec]);

  async function handleAddTool(tool: Tool) {
    await api.applyPatch([{ op: "add", path: ["agent", "tools"], value: tool }]);
    setOpenForm(null);
    await refresh();
  }

  async function handleAddWorkflowStep(step: WorkflowStep) {
    await api.applyPatch([{ op: "add", path: ["agent", "workflow"], value: step }]);
    setOpenForm(null);
    await refresh();
  }

  async function handleSetGuardrails(guardrails: Guardrails) {
    await api.applyPatch([{ op: "set", path: ["agent", "guardrails"], value: guardrails }]);
    setOpenForm(null);
    await refresh();
  }

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <div style={{ flex: 2, position: "relative" }}>
        {conflict && (
          <div role="alert" data-testid="conflict-banner">
            This spec changed externally while you were editing it.{" "}
            <button onClick={() => void refresh().then(() => setConflict(false))}>Reload</button>
          </div>
        )}
        {errors.length > 0 && (
          <div role="alert" data-testid="spec-errors">
            {errors.map((error, i) => (
              <div key={i}>
                {error.path.join(".")}: {error.message}
              </div>
            ))}
          </div>
        )}
        <button onClick={() => setOpenForm("tool")}>Add Tool</button>
        <button onClick={() => setOpenForm("workflow")}>Add Workflow Step</button>
        <button onClick={() => setOpenForm("guardrails")}>Set Guardrails</button>
        <button
          className="md3-button md3-button-filled"
          onClick={() => setOpenForm(openForm === "run" ? null : "run")}
        >
          Test Run
        </button>

        {openForm === "run" && <RunPanel api={api} />}

        {openForm === "tool" && (
          <ToolForm
            onSubmit={(tool) => void handleAddTool(tool)}
            onCancel={() => setOpenForm(null)}
          />
        )}
        {openForm === "workflow" && (
          <WorkflowStepForm
            onSubmit={(step) => void handleAddWorkflowStep(step)}
            onCancel={() => setOpenForm(null)}
          />
        )}
        {openForm === "guardrails" && (
          <GuardrailsForm
            onSubmit={(guardrails) => void handleSetGuardrails(guardrails)}
            onCancel={() => setOpenForm(null)}
          />
        )}

        <Canvas graph={graph} layout={layout} />
      </div>
      <div style={{ flex: 1, borderLeft: "1px solid #ccc" }}>
        <YamlPreview source={source} />
      </div>
    </div>
  );
}
