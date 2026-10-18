import { useState } from "react";
import { buildWorkflowStepFromForm, type ExpressionScope, type WorkflowStep } from "@kampong/spec";
import { ExpressionField } from "./ExpressionField.js";

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

// transform, validate and dedupe (KAN-1860) are version 1.1 steps: the spec's own check, not this form, says
// so if the spec is still 1.0. Their expression fields are plain text, as the condition's `if` is.
type StepKind =
  | "action"
  | "tool"
  | "approval"
  | "condition"
  | "transform"
  | "validate"
  | "dedupe"
  | "foreach"
  | "branch"
  | "stop";

// KAM-176: what each kind does, in task words, shown under the picker when it is selected.
const KIND_HELP: Record<StepKind, { label: string; what: string; example: string }> = {
  action: {
    label: "Action",
    what: "Ask the model to do something and keep its answer.",
    example: "Example: write a reply to the customer's email.",
  },
  tool: {
    label: "Tool",
    what: "Call one of the tools you added, such as a web request or a Slack message.",
    example: "Example: post the reply to the support channel.",
  },
  approval: {
    label: "Approval",
    what: "Wait for a person to approve before the run goes on.",
    example: "Example: let a manager check a refund before it is sent.",
  },
  condition: {
    label: "Condition",
    what: "Do this only if a condition is true, otherwise do something else (older specs).",
    example: "Example: if the order is over 100, go to the approval step.",
  },
  transform: {
    label: "Transform",
    what: "Work out new values from earlier results, without asking the model.",
    example: "Example: total = price * quantity.",
  },
  validate: {
    label: "Validate",
    what: "Check that the data looks right, and stop or skip the item if it does not.",
    example: "Example: the email address must not be empty.",
  },
  dedupe: {
    label: "Dedupe",
    what: "Skip anything already handled within a time window.",
    example: "Example: ignore a ticket seen in the last 24h.",
  },
  foreach: {
    label: "Foreach",
    what: "Repeat the steps inside for each item in a list.",
    example: "Example: for each stock symbol, fetch its price.",
  },
  branch: {
    label: "Branch",
    what: "Choose between groups of steps: do this only if something is true, or pick by value.",
    example: "Example: if the move is over 5%, send an alert; otherwise carry on.",
  },
  stop: {
    label: "Stop",
    what: "End the run here, with a reason.",
    example: "Example: nothing new today, so stop.",
  },
};

export interface WorkflowStepFormProps {
  /** The spec's version. On "1.1" the older Condition kind is hidden: Branch does the same job. */
  version?: string;
  /** Names in scope for the expression fields (KAM-160). Absent on a 1.0 spec, whose fields are plain text. */
  scope?: ExpressionScope;
  onSubmit: (step: WorkflowStep) => void;
  onCancel: () => void;
}

export function WorkflowStepForm({ version, scope, onSubmit, onCancel }: WorkflowStepFormProps) {
  const [kind, setKind] = useState<StepKind>("action");
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
  const [stopReason, setStopReason] = useState("");
  const [stopStatus, setStopStatus] = useState<"skipped" | "completed">("skipped");
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    let result;
    if (kind === "branch") {
      result = buildWorkflowStepFromForm({
        kind: "branch",
        step,
        if: branchIf,
        then: branchThen,
        else: branchElse,
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
    onSubmit(result.step);
  }

  return (
    <form
      onSubmit={handleSubmit}
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

      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Step ID</span>
        <input className="md3-text-field" value={step} onChange={(e) => setStep(e.target.value)} />
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

      {errors.length > 0 && (
        <ul role="alert" className="md3-error-list">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="md3-form-actions">
        <button type="submit" className="md3-button md3-button-filled">
          Save step
        </button>
        <button type="button" className="md3-button md3-button-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
