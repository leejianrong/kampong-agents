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
  // KAN-1216: a distinct error state for "the last spec load/save failed" --
  // e.g. the spec file was deleted/renamed out from under a running
  // `kampong dev`, or is otherwise unreadable. Deliberately separate from
  // `conflict` (an in-flight-mutation race ADR-0008 already handles): this
  // is a genuine failure, not a resolvable duplicate edit, so it gets its
  // own banner rather than silently blanking the canvas or closing a form
  // dialog as though the save had succeeded.
  const [specError, setSpecError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.loadSpec();
      setSpecError(null);
      setErrors(result.errors ?? []);
      setSource(result.source);
      setLayout(result.layout);
      if (result.success && result.spec) {
        setSpec(result.spec as AgentSpec);
      }
    } catch (err) {
      // Deliberately leaves source/layout/spec at their last-good values --
      // the point is to keep showing the last known-good canvas alongside
      // the error, not blank it.
      setSpecError(err instanceof Error ? err.message : "Failed to load the spec.");
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
        return;
      }
      if (event.type === "missing") {
        // Surfaced even with no canvas-triggered mutation in flight -- the
        // file-watcher now reacts to a genuine deletion instead of going
        // silently deaf (KAN-1216). No auto-reload attempt here: there's
        // nothing to reload into. Recreating the file lets the existing
        // "reload" path pick it back up once it reappears.
        setSpecError(
          "The spec file no longer exists on disk (deleted or moved). Restore or recreate it to keep editing -- this will pick it back up automatically.",
        );
      }
    });
    return unsubscribe;
  }, [api, refresh]);

  const graph = useMemo(() => (spec ? specToGraph(spec) : { nodes: [], edges: [] }), [spec]);

  async function applyPatchOrReportError(ops: Parameters<ApiClient["applyPatch"]>[0]) {
    try {
      await api.applyPatch(ops);
    } catch (err) {
      // A failed save must not close its dialog as if it had succeeded
      // (KAN-1216) -- the caller checks this return value and leaves the
      // form open so the user's input isn't lost.
      setSpecError(err instanceof Error ? err.message : "Failed to save the change.");
      return false;
    }
    return true;
  }

  async function handleAddTool(tool: Tool) {
    if (!(await applyPatchOrReportError([{ op: "add", path: ["agent", "tools"], value: tool }])))
      return;
    setOpenForm(null);
    await refresh();
  }

  async function handleAddWorkflowStep(step: WorkflowStep) {
    if (!(await applyPatchOrReportError([{ op: "add", path: ["agent", "workflow"], value: step }])))
      return;
    setOpenForm(null);
    await refresh();
  }

  async function handleSetGuardrails(guardrails: Guardrails) {
    if (
      !(await applyPatchOrReportError([
        { op: "set", path: ["agent", "guardrails"], value: guardrails },
      ]))
    )
      return;
    setOpenForm(null);
    await refresh();
  }

  return (
    <div className="md3-app">
      <div className="md3-app__canvas-pane">
        <div className="md3-app__toolbar">
          <span className="md3-title-large md3-app__title">Kampong Agents</span>
          <button className="md3-button md3-button-tonal" onClick={() => setOpenForm("tool")}>
            Add Tool
          </button>
          <button className="md3-button md3-button-tonal" onClick={() => setOpenForm("workflow")}>
            Add Workflow Step
          </button>
          <button className="md3-button md3-button-tonal" onClick={() => setOpenForm("guardrails")}>
            Set Guardrails
          </button>
          <span className="md3-app__toolbar-spacer" />
          <button
            className="md3-button md3-button-filled"
            onClick={() => setOpenForm(openForm === "run" ? null : "run")}
          >
            Test Run
          </button>
        </div>

        {specError && (
          <div
            role="alert"
            data-testid="spec-error-banner"
            className="md3-banner md3-banner--error"
          >
            <span>{specError}</span>
            <button className="md3-banner__action" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        {conflict && (
          <div role="alert" data-testid="conflict-banner" className="md3-banner md3-banner--info">
            <span>This spec changed externally while you were editing it.</span>
            <button
              className="md3-banner__action"
              onClick={() => void refresh().then(() => setConflict(false))}
            >
              Reload
            </button>
          </div>
        )}
        {errors.length > 0 && (
          <div role="alert" data-testid="spec-errors" className="md3-banner md3-banner--error">
            <ul className="md3-banner__errors">
              {errors.map((error, i) => (
                <li key={i}>
                  {error.path.join(".")}: {error.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="md3-app__canvas-surface">
          {openForm === "run" && (
            <div className="md3-app__overlay">
              <RunPanel api={api} />
            </div>
          )}

          {openForm === "tool" && (
            <div className="md3-app__overlay">
              <ToolForm
                onSubmit={(tool) => void handleAddTool(tool)}
                onCancel={() => setOpenForm(null)}
              />
            </div>
          )}
          {openForm === "workflow" && (
            <div className="md3-app__overlay">
              <WorkflowStepForm
                onSubmit={(step) => void handleAddWorkflowStep(step)}
                onCancel={() => setOpenForm(null)}
              />
            </div>
          )}
          {openForm === "guardrails" && (
            <div className="md3-app__overlay">
              <GuardrailsForm
                onSubmit={(guardrails) => void handleSetGuardrails(guardrails)}
                onCancel={() => setOpenForm(null)}
              />
            </div>
          )}

          <Canvas graph={graph} layout={layout} />
        </div>
      </div>
      <div className="md3-app__side-pane">
        <YamlPreview source={source} />
      </div>
    </div>
  );
}
