import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useState } from "react";
import {
  buildWorkflowStepFromForm,
  positionChoices,
  type AddTarget,
  type ExpressionScope,
  type Place,
  type WorkflowStep,
} from "@kampong/spec";
import { ExpressionField } from "./ExpressionField.js";
import { KIND_HELP, type StepKind } from "./stepKinds.js";

// The "Add Workflow Step" affordance -- same structured, zero-LLM-calls
// pattern as ToolForm.tsx (PLAN.md Affordances, Q12/R5).
//
// KAN-1175: this used to only ever build the plain-action variant of
// workflowStepSchema's union, with no way to author a `type: "condition"`
// branch or a `confidence_gate: true` step -- the write side of a shape the
// canvas could already render (specToGraph/Canvas.tsx are schema-shape-
// agnostic). The "Step kind" segmented control below picks which union
// variant buildWorkflowStepFromForm builds; only "Add" exists for workflow
// steps today (no edit-in-place affordance anywhere on the canvas), so this
// stays create-only to match that scope.

export interface WorkflowStepFormProps {
  /** The spec's version. On "1.1" the older Condition kind is hidden: Branch does the same job. */
  version?: string;
  /** Names in scope for the expression fields (KAM-160). Absent on a 1.0 spec, whose fields are plain text. */
  scope?: ExpressionScope;
  /**
   * Places a new step can go besides the end of the workflow (KAM-153, KAM-154): the end of a foreach's body or of
   * a branch's arm. With any, the form offers "Add to".
   */
  targets?: AddTarget[];
  /** The names of the steps at the top of the workflow, for "After <step>". Omit to leave the Position choice out. */
  workflowSteps?: string[];
  /**
   * Called when the chosen list or position changes, so the canvas can show where the step will land: the loop or
   * branch it goes in (none for the workflow), the names already in that list, and the index (none for the end).
   * Called with null when the form closes.
   */
  onPlacementChange?: (
    placement: { holder?: string; steps: string[]; index?: number } | null,
  ) => void;
  /**
   * Receives the built step and, for a loop body or an arm, its place. May answer with messages to show in the
   * form (a refused save), or nothing.
   */
  onSubmit: (step: WorkflowStep, place?: Place) => void | string[] | Promise<void | string[]>;
  onCancel: () => void;
  /**
   * Where the form starts (KAM-213): the kind chosen in the palette or the "+" picker, and the list and position
   * the "+" was on. `targetId` is an `AddTarget` id ("" is the workflow), `position` a `positionChoices` value.
   * With it, focus starts in Step ID.
   */
  initial?: { kind?: StepKind; targetId?: string; position?: string };
}

export function WorkflowStepForm({
  version,
  scope: workflowScope,
  targets = [],
  workflowSteps,
  onPlacementChange,
  onSubmit,
  onCancel,
  initial,
}: WorkflowStepFormProps) {
  const [targetId, setTargetId] = useState(initial?.targetId ?? "");
  const target = targets.find((t) => t.id === targetId);
  const scope = target ? target.scope : workflowScope;
  const [position, setPosition] = useState(initial?.position ?? "end");
  const listSteps = target ? target.steps : (workflowSteps ?? []);
  const choices = positionChoices(target ? target.where : "the workflow", listSteps);
  const chosen = choices.find((c) => c.value === position) ?? choices[0]!;
  const holder = target && typeof target.place.in === "object" ? target.place.in.step : undefined;
  useEffect(() => {
    onPlacementChange?.({
      ...(holder !== undefined && { holder }),
      steps: listSteps,
      ...(chosen.index !== undefined && { index: chosen.index }),
    });
    // The names are joined so a new array of the same names is not a change.
  }, [holder, listSteps.join("\u0000"), chosen.index]);
  useEffect(() => () => onPlacementChange?.(null), []);
  const [kind, setKind] = useState<StepKind>(initial?.kind ?? "action");
  const [step, setStep] = useState("");
  const [action, setAction] = useState("");
  const [inputs, setInputs] = useState("");
  const [confidenceGate, setConfidenceGate] = useState(false);
  const [ifCondition, setIfCondition] = useState("");
  const [thenTarget, setThenTarget] = useState("");
  const [elseTarget, setElseTarget] = useState("");
  const [instructions, setInstructions] = useState("");
  const [stepModel, setStepModel] = useState("");
  const [temperature, setTemperature] = useState("");
  const [tool, setTool] = useState("");
  const [message, setMessage] = useState("");
  const [setLines, setSetLines] = useState("");
  const [assertion, setAssertion] = useState("");
  const [onFail, setOnFail] = useState<"fail" | "skip">("fail");
  const [failMessage, setFailMessage] = useState("");
  const [dedupeKey, setDedupeKey] = useState("");
  const [dedupeTtl, setDedupeTtl] = useState("");
  // foreach (KAN-1858): the loop's list, variable, concurrency, error policy and a body of tool steps.
  const [loopItems, setLoopItems] = useState("");
  const [loopAs, setLoopAs] = useState("");
  const [loopConcurrency, setLoopConcurrency] = useState("");
  const [loopOnError, setLoopOnError] = useState<"fail" | "continue" | "retry">("fail");
  const [loopRetries, setLoopRetries] = useState("3");
  const [loopBody, setLoopBody] = useState("");
  // branch and stop (KAN-1859): an if/else whose arms are lists of tool steps, and an early stop.
  const [branchIf, setBranchIf] = useState("");
  const [branchThen, setBranchThen] = useState("");
  const [branchElse, setBranchElse] = useState("");
  // A switch branch (KAM-154): the value it reads, the cases, and an optional default.
  const [branchMode, setBranchMode] = useState<"if" | "switch">("if");
  const [branchSwitch, setBranchSwitch] = useState("");
  const [branchCases, setBranchCases] = useState("");
  const [branchDefault, setBranchDefault] = useState("");
  const [stopReason, setStopReason] = useState("");
  const [stopStatus, setStopStatus] = useState<"skipped" | "completed">("skipped");
  const [errors, setErrors] = useState<string[]>([]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    let result;
    if (kind === "branch") {
      result = buildWorkflowStepFromForm({
        kind: "branch",
        step,
        if: branchIf,
        then: branchThen,
        else: branchElse,
        ...(branchMode === "switch" && {
          switch: branchSwitch,
          cases: branchCases,
          default: branchDefault,
        }),
      });
    } else if (kind === "stop") {
      result = buildWorkflowStepFromForm({
        kind: "stop",
        step,
        ...(stopReason.trim() !== "" && { reason: stopReason.trim() }),
        status: stopStatus,
      });
    } else if (kind === "foreach") {
      result = buildWorkflowStepFromForm({
        kind: "foreach",
        step,
        items: loopItems,
        as: loopAs,
        ...(loopConcurrency.trim() !== "" && { concurrency: Number(loopConcurrency) }),
        onError: loopOnError,
        ...(loopOnError === "retry" && { retryCount: Number(loopRetries) }),
        body: loopBody,
      });
    } else if (kind === "transform") {
      result = buildWorkflowStepFromForm({ kind: "transform", step, set: setLines });
    } else if (kind === "validate") {
      result = buildWorkflowStepFromForm({
        kind: "validate",
        step,
        assert: assertion,
        onFail,
        message: failMessage.trim(),
      });
    } else if (kind === "dedupe") {
      result = buildWorkflowStepFromForm({ kind: "dedupe", step, key: dedupeKey, ttl: dedupeTtl });
    } else if (kind === "condition") {
      result = buildWorkflowStepFromForm({
        kind: "condition",
        step,
        if: ifCondition,
        then: thenTarget,
        else: elseTarget,
      });
    } else if (kind === "tool") {
      result = buildWorkflowStepFromForm({ kind: "tool", step, tool });
    } else if (kind === "approval") {
      result = buildWorkflowStepFromForm({
        kind: "approval",
        step,
        ...(message && { message }),
      });
    } else {
      result = buildWorkflowStepFromForm({
        step,
        action,
        inputs,
        confidenceGate,
        instructions: instructions.trim(),
        model: stepModel.trim(),
        ...(temperature.trim() !== "" && { temperature: Number(temperature) }),
      });
    }
    if (!result.success || !result.step) {
      setErrors(result.errors ?? ["Invalid workflow step"]);
      return;
    }
    const place: Place | undefined = target
      ? { ...target.place, ...(chosen.index !== undefined && { index: chosen.index }) }
      : chosen.index !== undefined
        ? { in: "workflow", index: chosen.index }
        : undefined;
    const refused = await (place ? onSubmit(result.step, place) : onSubmit(result.step));
    if (Array.isArray(refused) && refused.length > 0) setErrors(refused);
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      aria-label="Add Workflow Step"
      className="md3-form md3-form--fill"
    >
      <div className="md3-field">
        <span className="md3-field__label md3-label-large">Step kind</span>
        <div className="md3-segmented-button" role="group" aria-label="Step kind">
          {(Object.keys(KIND_HELP) as StepKind[])
            .filter((value) => !(value === "condition" && version === "1.1"))
            .map((value) => [value, KIND_HELP[value].label] as const)
            .map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                className={
                  kind === value
                    ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                    : "md3-segmented-button__segment"
                }
                onClick={() => setKind(value)}
              >
                {label}
              </button>
            ))}
        </div>
        <span className="md3-body-medium md3-field__hint" data-testid="step-kind-help">
          {KIND_HELP[kind].what} {KIND_HELP[kind].example}
        </span>
      </div>

      {targets.length > 0 && (
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Add to</span>
          <select
            className="md3-text-field"
            value={targetId}
            onChange={(e) => {
              setTargetId(e.target.value);
              setPosition("end");
            }}
          >
            <option value="">The workflow</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {(targets.length > 0 || workflowSteps !== undefined) && (
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Position</span>
          <select
            className="md3-text-field"
            value={chosen.value}
            onChange={(e) => setPosition(e.target.value)}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Step ID</span>
        <input
          className="md3-text-field"
          value={step}
          autoFocus={initial !== undefined}
          onChange={(e) => setStep(e.target.value)}
        />
      </label>

      {kind === "action" && (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Action</span>
            <input
              className="md3-text-field"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Inputs (comma-separated)</span>
            <input
              className="md3-text-field"
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </label>
          <label className="md3-checkbox-field">
            <input
              type="checkbox"
              className="md3-checkbox"
              checked={confidenceGate}
              onChange={(e) => setConfidenceGate(e.target.checked)}
            />
            <span className="md3-label-large">Requires confidence gate</span>
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">
              Instructions (optional, replaces role and goal for this step)
            </span>
            <textarea
              className="md3-text-field"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Model (optional)</span>
            <input
              className="md3-text-field"
              value={stepModel}
              onChange={(e) => setStepModel(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Temperature (optional, 0 to 2)</span>
            <input
              className="md3-text-field"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "tool" && (
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Tool name</span>
          <input
            className="md3-text-field"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
        </label>
      )}

      {kind === "approval" && (
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Message (optional)</span>
          <input
            className="md3-text-field"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
      )}

      {kind === "condition" && (
        <>
          <ExpressionField
            label="If (condition)"
            value={ifCondition}
            onChange={setIfCondition}
            scope={scope}
          />
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Then (target step id)</span>
            <input
              className="md3-text-field"
              value={thenTarget}
              onChange={(e) => setThenTarget(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Else (target step id)</span>
            <input
              className="md3-text-field"
              value={elseTarget}
              onChange={(e) => setElseTarget(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "transform" && (
        <ExpressionField
          label="Values (one per line, name: expression)"
          value={setLines}
          onChange={setSetLines}
          scope={scope}
          lines
        />
      )}

      {kind === "validate" && (
        <>
          <ExpressionField
            label="Assert (expression that must be true)"
            value={assertion}
            onChange={setAssertion}
            scope={scope}
          />
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">On fail</span>
            <select
              className="md3-text-field"
              value={onFail}
              onChange={(e) => setOnFail(e.target.value as "fail" | "skip")}
            >
              <option value="fail">fail</option>
              <option value="skip">skip</option>
            </select>
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Message (optional)</span>
            <input
              className="md3-text-field"
              value={failMessage}
              onChange={(e) => setFailMessage(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "dedupe" && (
        <>
          <ExpressionField
            label="Key (expression)"
            value={dedupeKey}
            onChange={setDedupeKey}
            scope={scope}
          />
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Remember for (e.g. 24h, 7d)</span>
            <input
              className="md3-text-field"
              value={dedupeTtl}
              onChange={(e) => setDedupeTtl(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "foreach" && (
        <>
          <ExpressionField
            label="Items (expression that gives a list)"
            value={loopItems}
            onChange={setLoopItems}
            scope={scope}
          />
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Loop variable</span>
            <input
              className="md3-text-field"
              value={loopAs}
              onChange={(e) => setLoopAs(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Concurrency</span>
            <input
              className="md3-text-field"
              type="number"
              min="1"
              placeholder="1"
              value={loopConcurrency}
              onChange={(e) => setLoopConcurrency(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">On error</span>
            <select
              className="md3-text-field"
              value={loopOnError}
              onChange={(e) => setLoopOnError(e.target.value as "fail" | "continue" | "retry")}
            >
              <option value="fail">fail</option>
              <option value="continue">continue</option>
              <option value="retry">retry</option>
            </select>
          </label>
          {loopOnError === "retry" && (
            <label className="md3-field">
              <span className="md3-field__label md3-label-large">Retries</span>
              <input
                className="md3-text-field"
                type="number"
                min="1"
                value={loopRetries}
                onChange={(e) => setLoopRetries(e.target.value)}
              />
            </label>
          )}
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">
              Body (one tool per line, step: tool)
            </span>
            <textarea
              className="md3-text-field"
              value={loopBody}
              onChange={(e) => setLoopBody(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "branch" && (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Branch on</span>
            <select
              className="md3-text-field"
              value={branchMode}
              onChange={(e) => setBranchMode(e.target.value as "if" | "switch")}
            >
              <option value="if">A condition (then / else)</option>
              <option value="switch">A value (one arm per case)</option>
            </select>
          </label>
          {branchMode === "if" ? (
            <>
              <ExpressionField
                label="If (expression that gives true or false)"
                value={branchIf}
                onChange={setBranchIf}
                scope={scope}
              />
              <label className="md3-field">
                <span className="md3-field__label md3-label-large">
                  Then (one tool per line, step: tool)
                </span>
                <textarea
                  className="md3-text-field"
                  value={branchThen}
                  onChange={(e) => setBranchThen(e.target.value)}
                />
              </label>
              <label className="md3-field">
                <span className="md3-field__label md3-label-large">
                  Else (optional, one tool per line)
                </span>
                <textarea
                  className="md3-text-field"
                  value={branchElse}
                  onChange={(e) => setBranchElse(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <ExpressionField
                label="Switch on (expression that gives the value)"
                value={branchSwitch}
                onChange={setBranchSwitch}
                scope={scope}
              />
              <label className="md3-field">
                <span className="md3-field__label md3-label-large">
                  Cases (one per line, value: step: tool)
                </span>
                <textarea
                  className="md3-text-field"
                  placeholder={"bug: reply_bug: reply\nbilling: reply_billing: reply"}
                  value={branchCases}
                  onChange={(e) => setBranchCases(e.target.value)}
                />
              </label>
              <label className="md3-field">
                <span className="md3-field__label md3-label-large">
                  Default (optional, one tool per line)
                </span>
                <textarea
                  className="md3-text-field"
                  value={branchDefault}
                  onChange={(e) => setBranchDefault(e.target.value)}
                />
              </label>
            </>
          )}
        </>
      )}

      {kind === "stop" && (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Reason</span>
            <input
              className="md3-text-field"
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Ends the run as</span>
            <select
              className="md3-text-field"
              value={stopStatus}
              onChange={(e) => setStopStatus(e.target.value as "skipped" | "completed")}
            >
              <option value="skipped">skipped</option>
              <option value="completed">completed</option>
            </select>
          </label>
        </>
      )}

      <PanelError messages={errors} />
      <PanelFooter save="Save step" onCancel={onCancel} />
    </form>
  );
}
