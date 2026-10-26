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
  parseSpec,
  planPreview,
  type SpecVar,
  type Tool,
  type Trigger,
  type WorkflowStep,
} from "@kampong/spec";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeInspector } from "./NodeInspector.js";
import { duplicateStep, duplicateTool } from "./duplicate.js";
import {
  ApiError,
  createApiClient,
  type ApiClient,
  type AssistantDiffDto,
  type AssistantStatus,
  type SecretStatusDto,
  type SpecErrorDto,
  type TemplateSummary,
} from "./api.js";
import { TemplateGallery } from "./TemplateGallery.js";
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
import { RunLog } from "./RunLog.js";
import { RunPanel } from "./RunPanel.js";
import { RunControls } from "./RunControls.js";
import { CoachMarks } from "./CoachMarks.js";
import { useCoachMarks } from "./coachMarks.js";
import { SampleDataContext } from "./sampleData.js";
import { useRunSession } from "./runSession.js";
import { deriveNodeStatuses } from "./runStatus.js";
import { brandsFromCatalog } from "./connectorBrand.js";
import { RunTrackerProvider, useRunTrackerStore } from "./runTracker.js";
import { ToolForm } from "./ToolForm.js";
import { connectorOptions, type ToolStart } from "./stepKinds.js";
import { WorkflowStepForm } from "./WorkflowStepForm.js";
import { NodePalette } from "./NodePalette.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { spotBeforeStep } from "./insertSpot.js";
import type { StepKind } from "./stepKinds.js";
import { Panel, SaveErrorContext } from "./Panel.js";
import { UpgradeContext } from "./UpgradeContext.js";
import { ImportPanel } from "./ImportPanel.js";
import { YamlPreview } from "./YamlPreview.js";
import { buildActions, type OpenForm } from "./actions.js";
import { TopBar, type SaveState } from "./TopBar.js";
import { StatusBar } from "./StatusBar.js";
import { CommandPalette } from "./CommandPalette.js";
import { Snackbar } from "./Snackbar.js";
import { buildYamlSourceMap, changedNode, nodeAtLine, type LineRange } from "./yamlSourceMap.js";

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

// KAM-213: a kind chosen in the palette or from a "+", and where the "+" was. `nonce` remounts the form.
interface InsertRequest {
  kind: StepKind;
  targetId?: string;
  position?: string;
  nonce: number;
}

// The forms whose typed input is worth a question before the selection moves on (KAM-211).
const KEEP_INPUT_FORMS: OpenForm[] = ["tool", "workflow", "guardrails", "edit-tool"];

// KAM-182: the panels that list things and edit one at a time. Switching to another panel does not ask: the panel
// stays mounted out of sight with its draft, and is as you left it when you come back. Closing one that has typed
// input (Esc, Close) asks, because that is what throws the draft away. Every other form asks before it is left.
const DRAFT_FORMS: OpenForm[] = ["vars", "trigger", "steps", "variables"];

// KAM-181: how long the changed lines stay marked and the toast stays up.
const SAVE_FEEDBACK_MS = 4000;

function describeChange(id: string, range: LineRange, source: string): string {
  const [kind, ...rest] = id.split(":");
  const name = rest.join(":");
  if (kind === "workflow") return `step ${name}`;
  if (kind === "tool") return `tool ${name}`;
  if (kind === "guardrails") return "guardrails";
  const first = source.split("\n")[range.start - 1] ?? "";
  return first.trimStart().startsWith("trigger:") ? "trigger" : "agent details";
}

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
  const [openForm, setOpenForm] = useState<OpenForm | null>(null);
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
  // KAM-211: the node whose inspector is open, whether the side pane has typed input that is not saved yet,
  // and the move (another node, the empty canvas, a toolbar button) waiting on "discard your changes?".
  const [selected, setSelected] = useState<string | null>(null);
  // KAM-250: which rail is open on the left, and the nodes the assistant's last Apply added.
  const [leftPane, setLeftPane] = useState<"steps" | "assistant">("steps");
  const cameFromAssistant = useRef(false);
  // KAM-205: what the empty state's box handed to the assistant, and what the assistant says it can do there.
  const [autoPrompt, setAutoPrompt] = useState<{ text: string; nonce: number } | undefined>();
  const [emptyAssistant, setEmptyAssistant] = useState<AssistantStatus | undefined>();
  const [newNodes, setNewNodes] = useState<string[]>([]);
  // KAM-206: the plan waiting in the assistant's panel, drawn on the canvas before it is applied.
  const [planOnShow, setPlanOnShow] = useState<{ source: string; diff: AssistantDiffDto } | null>(
    null,
  );
  const [pending, setPending] = useState<
    | { select: string | null }
    | { form: OpenForm | null; drop?: OpenForm }
    | { insert: InsertRequest }
    | null
  >(null);
  const [insert, setInsert] = useState<InsertRequest | undefined>(undefined);
  const dirty = useRef(false);
  // KAM-182: draft panels that have been opened (kept mounted), and which of them had something typed in.
  const [kept, setKept] = useState<OpenForm[]>([]);
  const typedIn = useRef(new Set<OpenForm>());
  const sidePane = useRef<HTMLElement>(null);
  // KAM-181: a save was just made (so the next different source is its result), and the feedback for it.
  const savedAt = useRef(0);
  const sourceRef = useRef("");
  const [toast, setToast] = useState<{ text: string; nonce: number } | null>(null);
  const [changed, setChanged] = useState<{ range: LineRange; nonce: number } | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // KAN-1216: a distinct error state for "the last spec load/save failed" --
  // e.g. the spec file was deleted/renamed out from under a running
  // `kampong dev`, or is otherwise unreadable. Deliberately separate from
  // `conflict` (an in-flight-mutation race ADR-0008 already handles): this
  // is a genuine failure, not a resolvable duplicate edit, so it gets its
  // own banner rather than silently blanking the canvas or closing a form
  // dialog as though the save had succeeded.
  const [specError, setSpecError] = useState<string | null>(null);
  // KAM-195: why the last save failed. Shown inside the open panel, or as a banner when none is open.
  const [saveError, setSaveError] = useState<string | null>(null);
  // KAM-196: the spec file does not exist yet. A new workflow, not an error.
  const [missing, setMissing] = useState(false);
  // False until the first load answers, so the "new workflow" state does not flash before the spec arrives.
  const [loaded, setLoaded] = useState(false);
  const [startingBlank, setStartingBlank] = useState(false);
  const [startBlankError, setStartBlankError] = useState<string | null>(null);
  // KAM-216: the template gallery. Undefined until listed, and left empty where the server has none (hosted).
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  useEffect(() => {
    if (!api.listTemplates) return;
    let cancelled = false;
    api
      .listTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        // No gallery is better than a broken one; "Start blank" still works.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // KAM-181: confirm a save and show what it changed: a toast, the node flashed, the YAML lines marked.
  function announceSave(before: string, after: string) {
    const nonce = Date.now();
    const hit = changedNode(before, after);
    if (!hit) {
      setToast({ text: "Saved.", nonce });
      return;
    }
    setFocus({ id: hit.id, nonce });
    setChanged({ range: hit.range, nonce });
    setToast({ text: `Saved: ${describeChange(hit.id, hit.range, after)}.`, nonce });
  }
  const announceRef = useRef(announceSave);
  announceRef.current = announceSave;

  const refresh = useCallback(async () => {
    try {
      const result = await api.loadSpec();
      setSpecError(null);
      setLoaded(true);
      setMissing(result.missing === true);
      setErrors(result.errors ?? []);
      const before = sourceRef.current;
      sourceRef.current = result.source;
      if (
        result.success &&
        savedAt.current > 0 &&
        Date.now() - savedAt.current < 10_000 &&
        before !== "" &&
        before !== result.source
      ) {
        savedAt.current = 0;
        announceRef.current(before, result.source);
      }
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

  // KAM-244: the Connectors tiles in the palette, and the one Add Tool should start on.
  const [toolStart, setToolStart] = useState<ToolStart | undefined>();
  const connectors = connectorOptions(catalog?.components ?? []);

  const usesComponents = spec?.agent.tools?.some((t) => t.action === "component") === true;
  useEffect(() => {
    const toolOpen =
      openForm === "tool" || openForm === "edit-tool" || selected?.startsWith("tool:");
    // KAM-247: a spec that uses a component also needs the catalog once, for the component's tile.
    // KAM-244: the palette's Connectors group lists installed components too, so the catalog is read once for it.
    if (
      !(toolOpen || (catalog === undefined && (usesComponents || spec !== null))) ||
      !api.listComponents
    )
      return;
    let cancelled = false;
    api
      .listComponents()
      .then((result) => {
        if (cancelled) return;
        setCatalog(
          Array.isArray(result?.components)
            ? result
            : { components: [], problems: ["Could not list components: unexpected answer."] },
        );
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
  }, [api, openForm, selected, usesComponents, spec !== null]);

  const componentBrands = useMemo(
    () => (catalog ? brandsFromCatalog(catalog.components) : undefined),
    [catalog],
  );

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

  // KAM-205: the empty state offers the assistant, so it asks once what the assistant can do.
  useEffect(() => {
    if (emptyKind !== "new" || !api.assistantStatus || emptyAssistant !== undefined) return;
    let cancelled = false;
    api
      .assistantStatus()
      .then((status) => !cancelled && setEmptyAssistant(status))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, emptyKind, emptyAssistant]);

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

  // KAM-205: "Build it for me" on the empty canvas. The endpoint is checked first, so nothing is written for a
  // request that cannot be answered; then a blank workflow is started and the assistant gets the description.
  async function handleBuildFromPrompt(prompt: string) {
    if (startingBlank) return;
    setStartingBlank(true);
    setStartBlankError(null);
    try {
      const status = await api.assistantStatus?.();
      if (status && !status.configured) {
        setStartBlankError(status.error);
        return;
      }
      const result = await api.startBlank();
      if (!result.success) {
        setStartBlankError(
          (result.errors ?? []).map((e) => e.message).join("; ") || "Could not start.",
        );
        return;
      }
      await refresh();
      setLeftPane("assistant");
      setAutoPrompt({ text: prompt, nonce: Date.now() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      setStartBlankError(err instanceof Error ? err.message : "Could not start.");
    } finally {
      setStartingBlank(false);
    }
  }

  // KAM-216: choosing a template saves it as the workflow (with its recorded data) and opens it.
  async function handleChooseTemplate(name: string, replace: boolean) {
    if (startingBlank || !api.startFromTemplate) return;
    setStartingBlank(true);
    setStartBlankError(null);
    try {
      const result = await api.startFromTemplate(name, { replace });
      if (!result.success) {
        setStartBlankError(
          (result.errors ?? []).map((e) => e.message).join("; ") || "Could not use the template.",
        );
        return;
      }
      setOpenForm(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.();
        return;
      }
      setStartBlankError(err instanceof Error ? err.message : "Could not use the template.");
    } finally {
      setStartingBlank(false);
    }
  }

  const graph = useMemo(() => (spec ? specToGraph(spec) : { nodes: [], edges: [] }), [spec]);
  // KAM-206: with a plan waiting, the canvas draws the workflow as it would be, plus what the plan removes.
  const planView = useMemo(() => {
    if (!planOnShow || !spec) return null;
    const proposed = parseSpec(planOnShow.source);
    return proposed.success && proposed.spec
      ? planPreview(spec, proposed.spec, planOnShow.diff)
      : null;
  }, [planOnShow, spec]);
  // The first thing the plan touches is brought into view when it is drawn.
  useEffect(() => {
    const first = planView ? Object.keys(planView.marks)[0] : undefined;
    if (first !== undefined) setFocus({ id: first, nonce: Date.now() });
  }, [planView]);
  // KAM-190: the run on screen, read off its event stream by the Test Run panel and drawn on the nodes.
  const runTracker = useRunTrackerStore();
  const runStatus = useMemo(
    () =>
      deriveNodeStatuses(
        runTracker.tracker,
        graph.nodes.map((n) => n.id),
      ),
    [runTracker.tracker, graph],
  );
  // KAM-219: the runs of this session, shared by the Run bar and the Test Run panel. Held here, above both, so a
  // run keeps streaming and its result and typed vars survive while other panels open and close. The options are
  // fetched again when the spec's text changes, so a template just chosen offers Replay at once.
  const runSession = useRunSession(api, runTracker, {
    blockedReason: runBlockedReason,
    refreshKey: source,
  });
  // KAM-220: the first-run marks. They start on a new, blank workflow and follow what the person does.
  const coach = useCoachMarks({
    loaded,
    blank: emptyKind !== null,
    hasTemplates: api.startFromTemplate !== undefined && templates.length > 0,
    runCount: runSession.runs.length,
    runOver: runSession.latest?.endedAt !== undefined,
    selectedId: selected,
  });
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
      setSaveError(
        err instanceof Error ? err.message : "Could not save: the change was not written.",
      );
      return false;
    }
    setSaveError(null);
    savedAt.current = Date.now();
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
      savedAt.current = Date.now();
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
        savedAt.current = Date.now();
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
        savedAt.current = Date.now();
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
        savedAt.current = Date.now();
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

  // KAM-211: the inspector. Selecting a node opens its form in the side pane in place of a toolbar form; Esc,
  // Close, a save or a cancel clears it. Moving on with typed input that is not saved asks first, and the
  // form stays as it was until the user says "discard" (KAM-182's prompt is not built yet; this is the same
  // rule for the one place the canvas can now drop input).
  const unsavedInput = () =>
    dirty.current &&
    (selected !== null || (openForm !== null && KEEP_INPUT_FORMS.includes(openForm)));

  function applySelect(id: string | null) {
    const previous = selected;
    setPending(null);
    dirty.current = false;
    setSelected(id);
    if (id !== null) setOpenForm(null);
    else if (previous !== null) returnFocusTo.current = previous;
  }

  // KAM-245: the card toolbar's Duplicate and Delete go to the inspector, which already knows how to ask first.
  const [nodeCommand, setNodeCommand] = useState<{
    action: "duplicate" | "delete";
    nonce: number;
  }>();
  function askNodeAction(action: "duplicate" | "delete") {
    setNodeCommand((c) => ({ action, nonce: (c?.nonce ?? 0) + 1 }));
  }

  function requestSelect(id: string | null) {
    if (id !== null && id === selected) return;
    if (id === null && selected === null) return;
    // Clicking a node the run failed on picks its row in the run log (KAM-243).
    if (id !== null && runStatus[id]?.status === "failed") {
      setRunLogOpen(true);
      runTracker.showMessage(id);
    }
    if (unsavedInput()) setPending({ select: id });
    else applySelect(id);
  }

  // The toolbar buttons open their own form in the same pane; they ask first too.
  function toolbarForm(next: OpenForm | null) {
    if (next === null && openForm !== null) return requestClose();
    if (selected !== null && unsavedInput()) setPending({ form: next });
    else setOpenForm(next);
  }

  // KAM-182: has this draft panel got typed input that is still in an open form? Typing marks it; a save or a
  // Cancel removes the form from the panel, which makes it clean again.
  const draftIsDirty = (form: OpenForm) => {
    if (!typedIn.current.has(form)) return false;
    const open = sidePane.current?.querySelector(`[data-testid="draft-${form}"] form`) != null;
    if (!open) typedIn.current.delete(form);
    return open;
  };

  // Close, or Esc, on a toolbar panel. A clean one closes at once; one with typed input asks first, and "Discard"
  // is what drops a draft panel's draft (a plain switch to another panel keeps it).
  function requestClose() {
    if (openForm === null) return;
    if (pending) {
      setPending(null);
      return;
    }
    if (DRAFT_FORMS.includes(openForm)) {
      if (draftIsDirty(openForm)) setPending({ form: null, drop: openForm });
      else setOpenForm(null);
    } else if (unsavedInput()) setPending({ form: null });
    else setOpenForm(null);
  }
  const escape = useRef({ requestClose, active: false });
  escape.current = {
    requestClose,
    active: selected === null && openForm !== null,
  };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || !escape.current.active) return;
      event.preventDefault();
      escape.current.requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // KAM-213: open Add Workflow Step with a kind chosen (and, from a "+", the place), asking first if the form or
  // inspector in the pane has typed input.
  function requestInsert(request: Omit<InsertRequest, "nonce">) {
    const full = { ...request, nonce: Date.now() };
    if (unsavedInput()) setPending({ insert: full });
    else applyInsert(full);
  }

  function applyInsert(request: InsertRequest) {
    setPending(null);
    dirty.current = false;
    setSelected(null);
    setInsert(request);
    setOpenForm("workflow");
  }

  function insertFromEdge(edgeId: string, kind: StepKind) {
    const edge = graph.edges.find((e) => e.id === edgeId);
    const spot =
      spec && edge ? spotBeforeStep(spec, edge.target.replace(/^workflow:/, "")) : undefined;
    requestInsert({ kind, ...spot });
  }

  // The toolbar's own Add Workflow Step starts from scratch, not from the last "+".
  useEffect(() => {
    if (openForm !== "workflow") setInsert(undefined);
  }, [openForm]);

  function discardAndGo() {
    const move = pending;
    if (!move) return;
    dirty.current = false;
    if ("select" in move) applySelect(move.select);
    else if ("insert" in move) applyInsert(move.insert);
    else {
      setPending(null);
      const drop = move.drop;
      if (drop !== undefined) {
        typedIn.current.delete(drop);
        setKept((list) => list.filter((f) => f !== drop));
      }
      setOpenForm(move.form);
    }
  }

  // KAM-182: a draft panel, once opened, stays mounted (hidden when another panel is on show).
  useEffect(() => {
    if (openForm !== null && DRAFT_FORMS.includes(openForm)) {
      setKept((list) => (list.includes(openForm) ? list : [...list, openForm]));
    }
  }, [openForm]);
  const shows = (form: OpenForm) => openForm === form || kept.includes(form);
  // A failed node's "See message" (KAM-190). Stable, because the canvas rebuilds its nodes when it changes.
  // The bottom run log (KAM-243) opens on it and picks the node's row.
  const [runLogOpen, setRunLogOpen] = useState(true);
  const showRunMessageRef = useRef<(id: string) => void>(() => {});
  showRunMessageRef.current = (id) => {
    setRunLogOpen(true);
    runTracker.showMessage(id);
  };
  const showRunMessage = useCallback((id: string) => showRunMessageRef.current(id), []);

  // KAM-181: the changed lines and the toast clear on their own.
  useEffect(() => {
    if (!changed) return;
    const timer = setTimeout(() => setChanged(null), SAVE_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [changed]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), SAVE_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // A toolbar form replaces the inspector; a node that has gone (deleted, or the file changed) closes it.
  useEffect(() => {
    if (openForm !== null) setSelected(null);
  }, [openForm]);
  // A save failure belongs to the panel it happened in; it goes when that panel does.
  useEffect(() => {
    setSaveError(null);
  }, [openForm, selected]);
  useEffect(() => {
    if (selected !== null && spec && !graph.nodes.some((n) => n.id === selected)) setSelected(null);
  }, [selected, spec, graph]);
  useEffect(() => {
    dirty.current = false;
  }, [selected, openForm]);
  // Focus goes back to the node the inspector came from, so the keyboard user is where they were.
  useEffect(() => {
    const id = returnFocusTo.current;
    if (selected !== null || id === null) return;
    returnFocusTo.current = null;
    document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)?.focus();
  }, [selected, graph]);

  async function handleSaveToolAt(index: number, tool: Tool): Promise<boolean> {
    const before = spec?.agent.tools?.[index];
    if (!before) return false;
    const ops = toolEditPatch(["agent", "tools", index], before, tool);
    if (ops.length > 0 && !(await applyPatchOrReportError(ops))) return false;
    if (ops.length > 0) await refresh();
    return true;
  }

  async function handleDuplicate(nodeId: string): Promise<string[] | void> {
    if (!spec) return;
    if (nodeId.startsWith("tool:")) {
      const copy = duplicateTool(spec, nodeId.slice("tool:".length));
      if (!copy) return ["That tool is no longer in the spec."];
      if (!(await applyPatchOrReportError([{ op: "add", path: ["agent", "tools"], value: copy }])))
        return ["The copy could not be saved."];
      await refresh();
      applySelect(`tool:${copy.name}`);
      return;
    }
    const copy = duplicateStep(spec, nodeId.replace(/^workflow:/, ""));
    if (!copy) return ["That step is no longer in the spec."];
    const refused = await handleAddStepAt(copy.place, copy.step);
    if (refused) return refused;
    applySelect(`workflow:${copy.step.step}`);
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
    dirty.current = false;
    await refresh();
    return true;
  }

  async function handleRemoveTrigger() {
    if (!(await applyPatchOrReportError(removeTriggerPatch()))) return false;
    dirty.current = false;
    await refresh();
    return true;
  }

  // KAM-202: the read-only YAML viewer is a drawer for developers, closed by default and remembered.
  const [yamlOpen, setYamlOpen] = useState(readYamlDrawer);
  // KAM-210: the selected node's lines in the drawer, and the way back from a line to its node.
  const yamlMap = useMemo(() => (yamlOpen ? buildYamlSourceMap(source) : null), [yamlOpen, source]);
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

  // KAM-214: secrets the workflow reads that have no value yet, for the count on the status bar. Fetched on load
  // and whenever the spec text changes (a new ${NAME} may have appeared); the Secrets panel keeps it current.
  const [missingSecrets, setMissingSecrets] = useState<number | undefined>(undefined);
  const countMissing = (rows: SecretStatusDto[]) =>
    rows.filter((row) => row.referenced && row.source === "unset").length;
  useEffect(() => {
    if (!api.listSecrets) return;
    let cancelled = false;
    api
      .listSecrets()
      .then((rows) => {
        if (!cancelled) setMissingSecrets(countMissing(rows));
      })
      .catch(() => {
        // the count is a hint; the panel reports a failure itself
      });
    return () => {
      cancelled = true;
    };
  }, [api, source]);

  const tally = useCallback((rows: SecretStatusDto[]) => {
    setMissingSecrets(countMissing(rows));
    return rows;
  }, []);
  // KAM-192: "Set it here" on a run or check error opens the Secrets panel with that name's form ready.
  const [secretFocus, setSecretFocus] = useState<{ name: string; nonce: number } | undefined>();
  function openSecret(name: string) {
    setSecretFocus((previous) => ({ name, nonce: (previous?.nonce ?? 0) + 1 }));
    toolbarForm("variables");
  }
  const listSecrets = useCallback(() => api.listSecrets!().then(tally), [api, tally]);

  // KAM-215: Ctrl/Cmd+K opens the command palette from anywhere, including a text field.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  function goToNode(id: string) {
    const asks = unsavedInput() && id !== selected;
    requestSelect(id);
    if (!asks) setFocus({ id, nonce: Date.now() });
  }

  const saveState: SaveState = specError ? "failed" : errors.length > 0 ? "paused" : "saved";
  const actions = buildActions({
    openForm,
    yamlOpen,
    hasSecrets: api.listSecrets !== undefined,
    hasChecks: api.runDoctor !== undefined,
    hasTemplates: api.startFromTemplate !== undefined && templates.length > 0,
    noSpecYet: emptyKind === "new",
    ...(missingSecrets !== undefined && { missingSecrets }),
    toggleForm: (form) => toolbarForm(openForm === form ? null : form),
    toggleYaml: () => setYamlOpen((open) => !open),
    startRun: runSession.requestRun,
    canRun: runSession.canRun,
    download: downloadAsFile,
    openPalette: () => setPaletteOpen(true),
    showTour: coach.restart,
  });

  // KAM-199: only where the canvas can write a spec that then runs. The hosted server refuses a 1.1 spec.
  // KAM-218: the data picker reads the run on show, and can start a Replay run to have something to show.
  const sampleData = useMemo(
    () => ({
      input: runSession.viewed?.input,
      replay: runSession.replayNow ?? undefined,
    }),
    [runSession.viewed?.input, runSession.replayNow],
  );
  const saveErrorState = useMemo(
    () => ({ message: saveError, clear: () => setSaveError(null) }),
    [saveError],
  );
  const upgrade = providedApi === undefined ? { source, apply: handlePatchSteps } : null;

  return (
    <UpgradeContext.Provider value={upgrade}>
      <SaveErrorContext.Provider value={saveErrorState}>
        <RunTrackerProvider value={runTracker}>
          <SampleDataContext.Provider value={sampleData}>
            <div className="md3-app">
              <TopBar
                name={specName ?? "Kampong Agents"}
                saveState={saveState}
                actions={actions}
                {...(onNavigateBack && { onBack: onNavigateBack })}
              />
              <RunControls
                session={runSession}
                action={actions.find((a) => a.surface === "runbar")}
                onOpenDetails={() => {
                  if (openForm !== "run") toolbarForm("run");
                }}
                {...(api.listSecrets &&
                  api.setSecret &&
                  api.removeSecret && { onSetSecret: openSecret })}
              />
              <div className="md3-app__main">
                <main className="md3-app__canvas-pane" aria-label="Workflow canvas">
                  {saveError !== null && openForm === null && selected === null && (
                    <div
                      role="alert"
                      data-testid="save-error-banner"
                      className="md3-banner md3-banner--error"
                    >
                      <span>{saveError}</span>
                      <button className="md3-banner__action" onClick={() => setSaveError(null)}>
                        Dismiss
                      </button>
                    </div>
                  )}
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
                    <div
                      role="alert"
                      data-testid="conflict-banner"
                      className="md3-banner md3-banner--info"
                    >
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
                    <div
                      role="alert"
                      data-testid="spec-errors"
                      className="md3-banner md3-banner--error"
                    >
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
                    {emptyKind === null && spec && api.askAssistant && (
                      <AssistantPanel
                        api={api}
                        source={source}
                        onChanged={refresh}
                        onPreview={setPlanOnShow}
                        onMarkNew={(ids) => {
                          setNewNodes(ids);
                          // Bring the first new card into view; the canvas waits for it to arrive.
                          if (ids[0] !== undefined) setFocus({ id: ids[0], nonce: Date.now() });
                        }}
                        onClose={() => {
                          cameFromAssistant.current = true;
                          setLeftPane("steps");
                        }}
                        hidden={leftPane !== "assistant"}
                        {...(autoPrompt && { initialPrompt: autoPrompt })}
                      />
                    )}
                    {emptyKind === null && spec && (leftPane === "steps" || !api.askAssistant) && (
                      <NodePalette
                        version={spec.version}
                        onChoose={(kind) => requestInsert({ kind })}
                        onAddTool={() => {
                          setToolStart(undefined);
                          toolbarForm("tool");
                        }}
                        connectors={connectors}
                        onChooseConnector={(start) => {
                          setToolStart(start);
                          toolbarForm("tool");
                        }}
                        startOpen={cameFromAssistant.current}
                        {...(api.askAssistant && {
                          onOpenAssistant: () => setLeftPane("assistant"),
                        })}
                      />
                    )}
                    {emptyKind === null ? (
                      <Canvas
                        graph={planView ? planView.graph : graph}
                        layout={planView ? planView.layout : layout}
                        marker={planView ? undefined : marker}
                        focus={focus}
                        selectedId={planView ? null : selected}
                        {...(!planView && { onSelect: requestSelect })}
                        {...(!planView && { onPaneClick: () => requestSelect(null) })}
                        version={spec?.version}
                        onInsert={spec && !planView ? insertFromEdge : undefined}
                        runStatus={planView ? undefined : runStatus}
                        onShowRunMessage={showRunMessage}
                        {...(!planView && { onNodeAction: askNodeAction })}
                        brands={componentBrands}
                        markedNew={planView ? undefined : newNodes}
                        {...(planView && { marks: planView.marks })}
                      />
                    ) : (
                      <EmptyState
                        kind={emptyKind}
                        busy={startingBlank}
                        error={startBlankError}
                        onStartBlank={() => void handleStartBlank()}
                        {...(api.askAssistant &&
                          emptyKind === "new" &&
                          emptyAssistant && {
                            assistant: emptyAssistant,
                            onBuildFromPrompt: (prompt: string) =>
                              void handleBuildFromPrompt(prompt),
                          })}
                        onAddStep={() => setOpenForm("workflow")}
                        templates={
                          api.startFromTemplate && templates.length > 0 ? (
                            <TemplateGallery
                              templates={templates}
                              busy={startingBlank}
                              onChoose={(name) => void handleChooseTemplate(name, false)}
                            />
                          ) : undefined
                        }
                      />
                    )}
                  </div>
                </main>
                <aside
                  aria-label="Details"
                  ref={sidePane}
                  className="md3-app__side-pane"
                  onInputCapture={() => {
                    dirty.current = true;
                    if (selected === null && openForm !== null && DRAFT_FORMS.includes(openForm)) {
                      typedIn.current.add(openForm);
                    }
                  }}
                >
                  {pending && (
                    <div
                      role="alert"
                      className="md3-banner md3-banner--warning md3-inspector__discard"
                      data-testid="discard-prompt"
                    >
                      <span>This form has changes you have not saved. Discard them?</span>
                      <button
                        type="button"
                        className="md3-banner__action"
                        autoFocus
                        onClick={() => setPending(null)}
                      >
                        Keep editing
                      </button>
                      <button type="button" className="md3-banner__action" onClick={discardAndGo}>
                        Discard changes
                      </button>
                    </div>
                  )}
                  {selected !== null &&
                    spec &&
                    (() => {
                      const node = graph.nodes.find((n) => n.id === selected);
                      if (!node) return null;
                      const tool =
                        node.kind === "tool"
                          ? spec.agent.tools?.find((t) => t.name === node.data.name)
                          : undefined;
                      return (
                        <NodeInspector
                          key={selected}
                          spec={spec}
                          node={node}
                          catalogReady={
                            tool?.action !== "component" ||
                            catalog !== undefined ||
                            !api.listComponents
                          }
                          catalog={catalog}
                          references={references}
                          onPinComponent={api.pinComponent ? handlePinComponent : undefined}
                          onPatchSteps={handlePatchSteps}
                          onSaveTool={handleSaveToolAt}
                          onSaveTrigger={handleSaveTrigger}
                          onRemoveTrigger={handleRemoveTrigger}
                          onSaveGuardrails={(value) =>
                            applyPatchOrReportError([
                              { op: "set", path: ["agent", "guardrails"], value },
                            ]).then(async (ok) => {
                              if (ok) await refresh();
                              return ok;
                            })
                          }
                          onRemove={handleRemove}
                          onDuplicate={() => handleDuplicate(selected)}
                          {...(nodeCommand && { command: nodeCommand })}
                          onClose={() => applySelect(null)}
                          onRequestClose={() => (pending ? setPending(null) : requestSelect(null))}
                        />
                      );
                    })()}
                  {/* The run panel docks in the side pane (above the YAML) rather than
            floating over the canvas, so a run never covers the graph the user
            is watching. Toggling "Test Run" shows/hides it. */}
                  {openForm === "tool" && (
                    <Panel title="Add Tool" onClose={requestClose}>
                      <ToolForm
                        {...(toolStart && { start: toolStart })}
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
                      <Panel title="Edit Tool" onClose={requestClose}>
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
                    <Panel title="Add Workflow Step" onClose={requestClose}>
                      <WorkflowStepForm
                        key={insert?.nonce ?? "toolbar"}
                        initial={
                          insert && {
                            kind: insert.kind,
                            ...(insert.targetId !== undefined && { targetId: insert.targetId }),
                            ...(insert.position !== undefined && { position: insert.position }),
                          }
                        }
                        version={spec?.version}
                        scope={spec?.version === "1.1" ? expressionScopeFor(spec) : undefined}
                        targets={spec ? addTargets(spec) : []}
                        workflowSteps={spec ? workflowStepNames(spec) : []}
                        onPlacementChange={setPlacement}
                        onSubmit={(step, place) =>
                          place === undefined
                            ? handleAddWorkflowStep(step)
                            : handleAddStepAt(place, step)
                        }
                        onCancel={() => setOpenForm(null)}
                      />
                    </Panel>
                  )}
                  {openForm === "guardrails" && (
                    <Panel title="Set Guardrails" onClose={requestClose}>
                      <GuardrailsForm
                        onSubmit={(guardrails) => void handleSetGuardrails(guardrails)}
                        onCancel={() => setOpenForm(null)}
                      />
                    </Panel>
                  )}
                  {openForm === "run" && (
                    <Panel
                      title="Test Run"
                      testId="run-panel-shell"
                      onClose={() => setOpenForm(null)}
                    >
                      <RunPanel session={runSession} />
                    </Panel>
                  )}
                  {shows("vars") && spec && (
                    <Panel
                      title="Spec Vars"
                      testId="draft-vars"
                      hidden={openForm !== "vars"}
                      onClose={requestClose}
                    >
                      <VarsPanel
                        version={spec.version}
                        vars={spec.vars}
                        onSave={handleSaveVar}
                        onRemove={handleRemoveVar}
                      />
                    </Panel>
                  )}
                  {shows("trigger") && spec && (
                    <Panel
                      title="Trigger"
                      testId="draft-trigger"
                      hidden={openForm !== "trigger"}
                      onClose={requestClose}
                    >
                      <TriggerPanel
                        version={spec.version}
                        trigger={spec.agent.trigger}
                        onSave={handleSaveTrigger}
                        onRemove={handleRemoveTrigger}
                      />
                    </Panel>
                  )}
                  {shows("steps") && spec && (
                    <Panel
                      title="Edit Steps"
                      testId="draft-steps"
                      hidden={openForm !== "steps"}
                      onClose={requestClose}
                    >
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
                  {shows("variables") && api.listSecrets && api.setSecret && api.removeSecret && (
                    <Panel
                      title="Secrets"
                      testId="draft-variables"
                      hidden={openForm !== "variables"}
                      onClose={requestClose}
                    >
                      <SecretsPanel
                        list={listSecrets}
                        focus={secretFocus}
                        save={(name, value) => api.setSecret!(name, value).then(tally)}
                        remove={(name) => api.removeSecret!(name).then(tally)}
                      />
                    </Panel>
                  )}
                  {openForm === "checks" && api.runDoctor && (
                    <Panel title="Checks" onClose={() => setOpenForm(null)}>
                      <DoctorPanel
                        run={(options) => api.runDoctor!(options)}
                        {...(api.listSecrets &&
                          api.setSecret &&
                          api.removeSecret && { onSetSecret: openSecret })}
                      />
                    </Panel>
                  )}
                  {openForm === "templates" && templates.length > 0 && (
                    <Panel title="New from template" onClose={() => setOpenForm(null)}>
                      {startBlankError && (
                        <div
                          role="alert"
                          data-testid="template-error"
                          className="md3-banner md3-banner--error"
                        >
                          {startBlankError}
                        </div>
                      )}
                      <TemplateGallery
                        templates={templates}
                        busy={startingBlank}
                        confirmReplace={emptyKind === null}
                        onChoose={(name) => void handleChooseTemplate(name, emptyKind !== "new")}
                      />
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
                      highlight={(selected !== null && yamlMap?.get(selected)) || null}
                      changed={changed}
                      onLineClick={(line) => {
                        const id = yamlMap ? nodeAtLine(yamlMap, line) : null;
                        if (id !== null && graph.nodes.some((n) => n.id === id)) requestSelect(id);
                      }}
                      onDownload={downloadAsFile}
                      onImport={() => setOpenForm("import")}
                    />
                  )}
                </aside>
              </div>
              <RunLog
                session={runSession}
                open={runLogOpen}
                onToggle={() => setRunLogOpen((v) => !v)}
              />
              <StatusBar actions={actions} />
              <Snackbar message={toast?.text ?? null} />
              {paletteOpen && (
                <CommandPalette
                  actions={actions}
                  nodes={graph.nodes}
                  onGoTo={goToNode}
                  onClose={() => setPaletteOpen(false)}
                />
              )}
            </div>
            <CoachMarks
              coach={coach}
              replay={runSession.options?.modes?.includes("replay") ?? false}
            />
          </SampleDataContext.Provider>
        </RunTrackerProvider>
      </SaveErrorContext.Provider>
    </UpgradeContext.Provider>
  );
}
