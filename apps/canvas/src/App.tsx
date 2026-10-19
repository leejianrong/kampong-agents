import {
  specToGraph,
  expressionScopeFor,
  hasEmptyWorkflow,
  isBlankSource,
  addTargets,
  insertionMarker,
  workflowStepNames,
  outputReferenceOptions,
  removeTriggerPatch,
  removeVarPatch,
  setTriggerPatch,
  setVarPatch,
  specWarnings,
  toolEditPatch,
  type AgentSpec,
  type ComponentCatalog,
  type Guardrails,
  type PatchOp,
  type Place,
  type SpecVar,
  type Tool,
  type Trigger,
  type WorkflowStep,
} from "@kampong/spec";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, type ApiClient, type SpecErrorDto } from "./api.js";
import { Canvas } from "./Canvas.js";
import { EmptyState } from "./EmptyState.js";
import { DoctorPanel } from "./DoctorPanel.js";
import { SecretsPanel } from "./SecretsPanel.js";
import type { PinResult } from "./ComponentTrust.js";
import { GuardrailsForm } from "./GuardrailsForm.js";
import { VarsPanel } from "./VarsPanel.js";
import { TriggerPanel } from "./TriggerPanel.js";
import { StepsPanel } from "./StepsPanel.js";
import {
  moveErrorWords,
  renameErrorWords,
  type MoveOutcome,
  type RemoveOutcome,
  type RenameOutcome,
} from "./DeleteControl.js";
import { RunPanel } from "./RunPanel.js";
import { ToolForm } from "./ToolForm.js";
import { WorkflowStepForm } from "./WorkflowStepForm.js";
import { Panel } from "./Panel.js";
import { UpgradeContext } from "./UpgradeContext.js";
import { ImportPanel } from "./ImportPanel.js";
import { YamlPreview } from "./YamlPreview.js";

// KAM-196: the headline over a spec that does not validate. Saves are refused while it is broken, and the
// canvas keeps showing the last version that was valid.
function errorSummary(errors: { line?: number }[], hasLastValid: boolean): string {
  const line = errors.find((e) => e.line !== undefined)?.line;
  const fix = line !== undefined ? `fix line ${line}` : "fix the errors below";
  return hasLastValid
    ? `Showing the last valid version; ${fix}. Saves are paused until then.`
    : `This spec cannot be shown yet; ${fix}. Saves are paused until then.`;
}

const YAML_DRAWER_KEY = "kampong.yamlDrawer";

function readYamlDrawer(): boolean {
  try {
    return localStorage.getItem(YAML_DRAWER_KEY) === "open";
  } catch {
    return false;
  }
}

// The canvas app's top-level orchestration (PLAN.md Shape S2). Owns the
// fetch-on-mount + SSE-subscribe lifecycle; ADR-0008's auto-reload-by-
// default lives here as the difference between a silent "reload" refetch
// and a "conflict" banner the user has to act on.

export interface AppProps {
  apiBaseUrl?: string;
  /**
   * A pre-built client to drive the editor with. Hosted mode passes a
   * per-spec client here (`HostedClient.specClient(id)`); local mode omits it
   * and one is built from `apiBaseUrl`. Kept behind this seam (ADR-0020) so
   * the editor never branches on which server it's talking to.
   */
  api?: ApiClient;
  /** Shown in the toolbar in hosted mode so the user knows which spec is open. */
  specName?: string;
  /** When provided (hosted mode), renders a "back to specs" action. */
  onNavigateBack?: () => void;
  /** Hosted mode: called when a request comes back 401, to re-gate on login. */
  onUnauthorized?: () => void;
}

type OpenForm =
  | "tool"
  | "workflow"
  | "guardrails"
  | "run"
  | null
  | "checks"
  | "variables"
  | "vars"
  | "trigger"
  | "steps"
  | "edit-tool"
  | "import";

export function App({
  apiBaseUrl = "",
  api: providedApi,
  specName,
  onNavigateBack,
  onUnauthorized,
}: AppProps) {
  const api = useMemo<ApiClient>(
    () => providedApi ?? createApiClient(apiBaseUrl),
    [providedApi, apiBaseUrl],
  );

  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [source, setSource] = useState("");
  const [layout, setLayout] = useState<Record<string, { x: number; y: number }>>({});
  const [errors, setErrors] = useState<SpecErrorDto[]>([]);
  // KAN-1831: a valid spec can still declare fields nothing executes (knowledge_base today).
  const [warnings, setWarnings] = useState<ReturnType<typeof specWarnings>>([]);
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  // KAN-1885: the installed components, fetched each time the tool form opens so a component added
  // while the canvas is running shows up without a reload. Undefined where the server offers none.
  const [catalog, setCatalog] = useState<ComponentCatalog | undefined>(undefined);
  // KAM-175: the index in `agent.tools` of the tool open in the edit form.
  const [editingTool, setEditingTool] = useState<number | null>(null);
  // KAM-173: where the step in the Add form will land (drawn on the canvas), and the node to pan to and flash
  // after an add.
  const [placement, setPlacement] = useState<{
    holder?: string;
    steps: string[];
    index?: number;
  } | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  // KAN-1216: a distinct error state for "the last spec load/save failed" --
  // e.g. the spec file was deleted/renamed out from under a running
  // `kampong dev`, or is otherwise unreadable. Deliberately separate from
  // `conflict` (an in-flight-mutation race ADR-0008 already handles): this
  // is a genuine failure, not a resolvable duplicate edit, so it gets its
  // own banner rather than silently blanking the canvas or closing a form
  // dialog as though the save had succeeded.
  const [specError, setSpecError] = useState<string | null>(null);
  // KAM-196: the spec file does not exist yet. A new workflow, not an error.
  const [missing, setMissing] = useState(false);
  // False until the first load answers, so the "new workflow" state does not flash before the spec arrives.
  const [loaded, setLoaded] = useState(false);
  const [startingBlank, setStartingBlank] = useState(false);
  const [startBlankError, setStartBlankError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.loadSpec();
      setSpecError(null);
      setLoaded(true);
      setMissing(result.missing === true);
      setErrors(result.errors ?? []);
      setSource(result.source);
      setLayout(result.layout);
      if (result.success && result.spec) {
        setSpec(result.spec as AgentSpec);
        setWarnings(specWarnings(result.spec as AgentSpec));
      } else if (
        result.missing ||
        isBlankSource(result.source) ||
        hasEmptyWorkflow(result.source)
      ) {
        // Nothing to draw: drop the last spec so the empty state shows, not a stale canvas.
        setSpec(null);
        setWarnings([]);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      // Deliberately leaves source/layout/spec at their last-good values --
      // the point is to keep showing the last known-good canvas alongside
      // the error, not blank it.
      setSpecError(err instanceof Error ? err.message : "Failed to load the spec.");
    }
  }, [api, onUnauthorized]);

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

  useEffect(() => {
    if ((openForm !== "tool" && openForm !== "edit-tool") || !api.listComponents) return;
    let cancelled = false;
    api
      .listComponents()
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog({
          components: [],
          problems: [
            `Could not list components: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, openForm]);

  const references = useMemo(
    () => (spec && catalog ? outputReferenceOptions(spec, catalog.components) : []),
    [spec, catalog],
  );

  // KAM-196: what to show when there is nothing to draw. A missing or empty file is a new workflow; a workflow
  // with no steps asks for the first one. Neither is an error.
  const emptyKind: "new" | "steps" | null = !loaded
    ? null
    : missing || isBlankSource(source)
      ? "new"
      : hasEmptyWorkflow(source)
        ? "steps"
        : null;

  // Why a test run cannot start, in words, or undefined when it can.
  const parseErrorLine = errors.find((e) => e.line !== undefined)?.line;
  const runBlockedReason =
    emptyKind === "new"
      ? "There is no workflow yet. Start blank or choose a template first."
      : emptyKind === "steps"
        ? "This workflow has no steps yet. Add a step first."
        : errors.length > 0
          ? `The workflow has an error${parseErrorLine ? ` on line ${parseErrorLine}` : ""}, so it cannot run yet. Fix it first.`
          : undefined;

  async function handleStartBlank() {
    if (startingBlank) return;
    setStartingBlank(true);
    setStartBlankError(null);
    try {
      const result = await api.startBlank();
      if (!result.success) {
        setStartBlankError(
          (result.errors ?? []).map((e) => e.message).join("; ") || "Could not start blank.",
        );
        return;
      }
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      setStartBlankError(err instanceof Error ? err.message : "Could not start blank.");
    } finally {
      setStartingBlank(false);
    }
  }

  const graph = useMemo(() => (spec ? specToGraph(spec) : { nodes: [], edges: [] }), [spec]);
  const marker = useMemo(
    () =>
      openForm === "workflow" && placement
        ? insertionMarker(graph, placement.holder, placement.steps, placement.index)
        : undefined,
    [openForm, placement, graph],
  );

  async function applyPatchOrReportError(ops: Parameters<ApiClient["applyPatch"]>[0]) {
    try {
      await api.applyPatch(ops);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return false;
      }
      // A failed save must not close its dialog as if it had succeeded
      // (KAN-1216) -- the caller checks this return value and leaves the
      // form open so the user's input isn't lost.
      setSpecError(err instanceof Error ? err.message : "Failed to save the change.");
      return false;
    }
    return true;
  }

  // Pins one component through the server, which decides whether a wider grant needs consent, and keeps
  // the refreshed catalog so the form shows the new state without reopening.
  async function handlePinComponent(
    use: string,
    allowWiderPermissions: boolean,
    reviewedDigest: string,
  ): Promise<PinResult> {
    if (!api.pinComponent) return { ok: false, error: "This server cannot pin components." };
    try {
      const result = await api.pinComponent(use, {
        allowWiderPermissions,
        expectedDigest: reviewedDigest,
      });
      // On a refusal the server may send the catalog as it is now (the files changed under the review), so
      // the form shows what is really there.
      if (result.catalog) setCatalog(result.catalog);
      if (!result.success)
        return { ok: false, error: result.error ?? "Could not pin the component." };
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Could not pin the component.",
      };
    }
  }

  async function handleAddTool(tool: Tool) {
    if (!(await applyPatchOrReportError([{ op: "add", path: ["agent", "tools"], value: tool }])))
      return;
    setOpenForm(null);
    await refresh();
  }

  async function handleEditTool(index: number, tool: Tool) {
    const before = spec?.agent.tools?.[index];
    if (!before) return;
    const ops = toolEditPatch(["agent", "tools", index], before, tool);
    if (ops.length > 0 && !(await applyPatchOrReportError(ops))) return;
    setOpenForm(null);
    setEditingTool(null);
    if (ops.length > 0) await refresh();
  }

  // A step added inside a foreach body or a branch arm goes in at a place, by name (ADR-0055). A refusal (an
  // approval or a nested loop in a body, a name already used) comes back as plain messages for the form to show.
  const flashStep = (step: WorkflowStep) =>
    setFocus({ id: `workflow:${step.step}`, nonce: Date.now() });

  async function handleAddStepAt(place: Place, step: WorkflowStep): Promise<string[] | void> {
    try {
      const result = await api.applyOps([
        {
          op: "step.insert",
          place,
          step: step as unknown as Record<string, unknown>,
        },
      ]);
      if (!result.success) {
        return (result.errors ?? [])
          .map((e) => e.message)
          .concat(result.stale ? ["The spec changed; reload and try again."] : []);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      return [err instanceof Error ? err.message : "Failed to save the change."];
    }
    flashStep(step);
    setOpenForm(null);
    await refresh();
  }

  async function handleAddWorkflowStep(step: WorkflowStep) {
    if (!(await applyPatchOrReportError([{ op: "add", path: ["agent", "workflow"], value: step }])))
      return;
    flashStep(step);
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

  // The panel stays open after a save (it lists what it saved), so these refresh instead of closing it.
  async function handleSaveVar(name: string, value: SpecVar) {
    const declared = Object.keys(spec?.vars ?? {}).length;
    if (!(await applyPatchOrReportError(setVarPatch(name, value, declared)))) return false;
    await refresh();
    return true;
  }

  async function handleRemoveVar(name: string) {
    const declared = Object.keys(spec?.vars ?? {}).length;
    if (!(await applyPatchOrReportError(removeVarPatch(name, declared)))) return false;
    await refresh();
    return true;
  }

  async function handlePatchSteps(ops: PatchOp[]) {
    if (!(await applyPatchOrReportError(ops))) return false;
    await refresh();
    return true;
  }

  // KAM-171: delete a step or tool by name through the operations API. A refusal is an answer to show (what
  // still uses it), not an error banner, so it comes back as an outcome rather than setting `specError`.
  async function handleRemove(
    op: { op: "step.remove"; step: string } | { op: "tool.remove"; tool: string },
  ): Promise<RemoveOutcome> {
    try {
      const result = await api.applyOps([op]);
      if (result.success) {
        await refresh();
        return { success: true };
      }
      const errors = result.errors ?? [];
      return {
        success: false,
        blocked: errors.some((e) => e.code === "has_references"),
        references: errors.flatMap((e) => e.references ?? []),
        messages: errors.map((e) =>
          e.code === undefined
            ? `Not deleted: the spec would no longer be valid (${e.message})`
            : e.message,
        ),
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      return {
        success: false,
        blocked: false,
        references: [],
        messages: [err instanceof Error ? err.message : "Could not delete."],
      };
    }
  }

  // KAM-172: rename a step or tool; every place that uses the name is rewritten in the same save, and the
  // server moves the layout entry, so the node keeps its position. A refusal comes back as words for the form.
  async function handleRename(
    op:
      | { op: "step.rename"; step: string; to: string }
      | { op: "tool.rename"; tool: string; to: string },
  ): Promise<RenameOutcome> {
    const noun = op.op === "step.rename" ? "step" : "tool";
    try {
      const result = await api.applyOps([op]);
      if (result.success) {
        await refresh();
        return { success: true };
      }
      return {
        success: false,
        messages: (result.errors ?? []).map((e) => renameErrorWords(e, noun, op.to)),
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      return {
        success: false,
        messages: [err instanceof Error ? err.message : "Could not rename."],
      };
    }
  }

  // KAM-174: move a step one place within its list. A move that would put a step before one it reads is
  // refused with the list of reads, which the row shows in words.
  async function handleMove(op: {
    op: "step.move";
    step: string;
    to: Place;
  }): Promise<MoveOutcome> {
    try {
      const result = await api.applyOps([op]);
      if (result.success) {
        await refresh();
        return { success: true };
      }
      return {
        success: false,
        messages: (result.errors ?? []).flatMap((e) => moveErrorWords(e)),
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      return {
        success: false,
        messages: [err instanceof Error ? err.message : "Could not move the step."],
      };
    }
  }

  // KAM-207: export is the spec's own text, as it is stored, so what is downloaded runs under `kampong run`,
  // `kampong serve` and `kampong export` exactly as it is on screen.
  function downloadAsFile() {
    const url = URL.createObjectURL(new Blob([source], { type: "text/yaml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${spec?.agent.id ?? "agent"}.yaml`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveTrigger(value: Trigger) {
    if (!(await applyPatchOrReportError(setTriggerPatch(value)))) return false;
    await refresh();
    return true;
  }

  async function handleRemoveTrigger() {
    if (!(await applyPatchOrReportError(removeTriggerPatch()))) return false;
    await refresh();
    return true;
  }

  // KAM-202: the read-only YAML viewer is a drawer for developers, closed by default and remembered.
  const [yamlOpen, setYamlOpen] = useState(readYamlDrawer);
  useEffect(() => {
    try {
      localStorage.setItem(YAML_DRAWER_KEY, yamlOpen ? "open" : "closed");
    } catch {
      // storage can be blocked; the drawer still works for this visit
    }
  }, [yamlOpen]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyY") {
        event.preventDefault();
        setYamlOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // KAM-199: only where the canvas can write a spec that then runs. The hosted server refuses a 1.1 spec.
  const upgrade = providedApi === undefined ? { source, apply: handlePatchSteps } : null;

  return (
    <UpgradeContext.Provider value={upgrade}>
      <div className="md3-app">
        <div className="md3-app__canvas-pane">
          <div className="md3-app__toolbar">
            {onNavigateBack && (
              <button
                className="md3-button md3-button-text"
                onClick={onNavigateBack}
                data-testid="back-to-specs"
              >
                ← Specs
              </button>
            )}
            <span className="md3-title-large md3-app__title">{specName ?? "Kampong Agents"}</span>
            {emptyKind !== "new" && (
              <div className="md3-toolbar__group" role="group" aria-label="Build">
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "tool"}
                  onClick={() => setOpenForm(openForm === "tool" ? null : "tool")}
                >
                  Add Tool
                </button>
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "workflow"}
                  onClick={() => setOpenForm(openForm === "workflow" ? null : "workflow")}
                >
                  Add Workflow Step
                </button>
              </div>
            )}
            {emptyKind !== "new" && (
              <div className="md3-toolbar__group" role="group" aria-label="Configure">
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "guardrails"}
                  onClick={() => setOpenForm(openForm === "guardrails" ? null : "guardrails")}
                >
                  Set Guardrails
                </button>
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "vars"}
                  onClick={() => setOpenForm(openForm === "vars" ? null : "vars")}
                >
                  Spec Vars
                </button>
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "trigger"}
                  onClick={() => setOpenForm(openForm === "trigger" ? null : "trigger")}
                >
                  Trigger
                </button>
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "steps"}
                  onClick={() => setOpenForm(openForm === "steps" ? null : "steps")}
                >
                  Edit Steps
                </button>
              </div>
            )}
            <span className="md3-app__toolbar-spacer" />
            <div className="md3-toolbar__group" role="group" aria-label="Run">
              <button
                className="md3-button md3-button-tonal md3-toolbar__code"
                aria-pressed={yamlOpen}
                aria-label="For developers: show YAML"
                aria-keyshortcuts="Alt+Y"
                title="For developers: show the spec as YAML (Alt+Y)"
                data-testid="yaml-drawer-toggle"
                onClick={() => setYamlOpen(!yamlOpen)}
              >
                {"</>"}
              </button>
              {api.listSecrets && (
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "variables"}
                  onClick={() => setOpenForm(openForm === "variables" ? null : "variables")}
                >
                  Secrets
                </button>
              )}
              {api.runDoctor && (
                <button
                  className="md3-button md3-button-tonal"
                  aria-pressed={openForm === "checks"}
                  onClick={() => setOpenForm(openForm === "checks" ? null : "checks")}
                >
                  Checks
                </button>
              )}
              <button
                className="md3-button md3-button-filled"
                aria-pressed={openForm === "run"}
                onClick={() => setOpenForm(openForm === "run" ? null : "run")}
              >
                Test Run
              </button>
            </div>
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
          {warnings.length > 0 && (
            <div
              role="status"
              data-testid="spec-warnings"
              className="md3-banner md3-banner--warning"
            >
              <ul className="md3-banner__errors">
                {warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}
          {errors.length > 0 && emptyKind === null && (
            <div role="alert" data-testid="spec-errors" className="md3-banner md3-banner--error">
              <div>
                <p className="md3-title-small" data-testid="spec-errors-summary">
                  {errorSummary(errors, spec !== null)}
                </p>
                <ul className="md3-banner__errors">
                  {errors.map((error, i) => (
                    <li key={i}>
                      {error.path.length > 0 && `${error.path.join(".")}: `}
                      {error.message}
                      {error.line !== undefined && ` (line ${error.line})`}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="md3-app__canvas-surface">
            {emptyKind === null ? (
              <Canvas graph={graph} layout={layout} marker={marker} focus={focus} />
            ) : (
              <EmptyState
                kind={emptyKind}
                busy={startingBlank}
                error={startBlankError}
                onStartBlank={() => void handleStartBlank()}
                onAddStep={() => setOpenForm("workflow")}
                // KAM-216: the template gallery plugs in here (`templates={<TemplateGallery ... />}`).
                templates={undefined}
              />
            )}
          </div>
        </div>
        <div className="md3-app__side-pane">
          {/* The run panel docks in the side pane (above the YAML) rather than
            floating over the canvas, so a run never covers the graph the user
            is watching. Toggling "Test Run" shows/hides it. */}
          {openForm === "tool" && (
            <Panel title="Add Tool" onClose={() => setOpenForm(null)}>
              <ToolForm
                components={catalog?.components}
                componentProblems={catalog?.problems}
                references={references}
                onPinComponent={api.pinComponent ? handlePinComponent : undefined}
                onSubmit={(tool) => void handleAddTool(tool)}
                onCancel={() => setOpenForm(null)}
              />
            </Panel>
          )}
          {openForm === "edit-tool" &&
            spec &&
            editingTool !== null &&
            spec.agent.tools?.[editingTool] &&
            // A component tool waits for the catalog, so its inputs open as fields and not as YAML.
            (spec.agent.tools[editingTool].action !== "component" ||
              catalog !== undefined ||
              !api.listComponents) && (
              <Panel title="Edit Tool" onClose={() => setOpenForm(null)}>
                <ToolForm
                  key={`${editingTool}:${spec.agent.tools[editingTool].name}`}
                  initial={spec.agent.tools[editingTool]}
                  components={catalog?.components}
                  componentProblems={catalog?.problems}
                  references={references}
                  onPinComponent={api.pinComponent ? handlePinComponent : undefined}
                  onSubmit={(tool) => void handleEditTool(editingTool, tool)}
                  onCancel={() => setOpenForm(null)}
                />
              </Panel>
            )}
          {openForm === "workflow" && (
            <Panel title="Add Workflow Step" onClose={() => setOpenForm(null)}>
              <WorkflowStepForm
                version={spec?.version}
                scope={spec?.version === "1.1" ? expressionScopeFor(spec) : undefined}
                targets={spec ? addTargets(spec) : []}
                workflowSteps={spec ? workflowStepNames(spec) : []}
                onPlacementChange={setPlacement}
                onSubmit={(step, place) =>
                  place === undefined ? handleAddWorkflowStep(step) : handleAddStepAt(place, step)
                }
                onCancel={() => setOpenForm(null)}
              />
            </Panel>
          )}
          {openForm === "guardrails" && (
            <Panel title="Set Guardrails" onClose={() => setOpenForm(null)}>
              <GuardrailsForm
                onSubmit={(guardrails) => void handleSetGuardrails(guardrails)}
                onCancel={() => setOpenForm(null)}
              />
            </Panel>
          )}
          {openForm === "run" && (
            <Panel title="Test Run" onClose={() => setOpenForm(null)}>
              <RunPanel api={api} blockedReason={runBlockedReason} />
            </Panel>
          )}
          {openForm === "vars" && spec && (
            <Panel title="Spec Vars" onClose={() => setOpenForm(null)}>
              <VarsPanel
                version={spec.version}
                vars={spec.vars}
                onSave={handleSaveVar}
                onRemove={handleRemoveVar}
              />
            </Panel>
          )}
          {openForm === "trigger" && spec && (
            <Panel title="Trigger" onClose={() => setOpenForm(null)}>
              <TriggerPanel
                version={spec.version}
                trigger={spec.agent.trigger}
                onSave={handleSaveTrigger}
                onRemove={handleRemoveTrigger}
              />
            </Panel>
          )}
          {openForm === "steps" && spec && (
            <Panel title="Edit Steps" onClose={() => setOpenForm(null)}>
              <StepsPanel
                spec={spec}
                onPatch={handlePatchSteps}
                onRemove={handleRemove}
                onRename={handleRename}
                onMove={handleMove}
                onEditTool={(index) => {
                  setEditingTool(index);
                  setOpenForm("edit-tool");
                }}
              />
            </Panel>
          )}
          {openForm === "variables" && api.listSecrets && api.setSecret && api.removeSecret && (
            <Panel title="Secrets" onClose={() => setOpenForm(null)}>
              <SecretsPanel
                list={() => api.listSecrets!()}
                save={(name, value) => api.setSecret!(name, value)}
                remove={(name) => api.removeSecret!(name)}
              />
            </Panel>
          )}
          {openForm === "checks" && api.runDoctor && (
            <Panel title="Checks" onClose={() => setOpenForm(null)}>
              <DoctorPanel run={(options) => api.runDoctor!(options)} />
            </Panel>
          )}
          {openForm === "import" && (
            <Panel title="Import from file" onClose={() => setOpenForm(null)}>
              <ImportPanel
                hasContent={
                  spec
                    ? spec.agent.workflow.length > 0 || (spec.agent.tools?.length ?? 0) > 0
                    : source.trim() !== ""
                }
                hosted={providedApi !== undefined}
                replace={(text) => api.replaceSource(text)}
                onImported={() => {
                  setOpenForm(null);
                  void refresh();
                }}
              />
            </Panel>
          )}
          {yamlOpen && (
            <YamlPreview
              source={source}
              onDownload={downloadAsFile}
              onImport={() => setOpenForm("import")}
            />
          )}
        </div>
      </div>
    </UpgradeContext.Provider>
  );
}
