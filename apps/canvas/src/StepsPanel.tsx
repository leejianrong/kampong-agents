import { PanelError, PanelFooter } from "./Panel";
import { useEffect, useRef, useState } from "react";
import { VersionGate } from "./VersionGate.js";
import { useAutoHeight } from "./useAutoHeight.js";
import {
  actionStepToEditInput,
  buildActionStepEdit,
  buildDataStepEdit,
  buildForEachEdit,
  forEachToEditInput,
  branchToEditInput,
  buildBranchEdit,
  type BranchEditInput,
  type ForEachEditInput,
  buildSimpleStepEdit,
  dataStepToEditInput,
  emptySchemaDraft,
  expressionScopeForStepAt,
  isSimpleStep,
  listSteps,
  occurrencesFor,
  simpleStepToEditInput,
  type ActionStepEditInput,
  type DataStepEditInput,
  type ExpressionScope,
  type SimpleStepEditInput,
  type AgentSpec,
  type PatchOp,
  type SetRow,
  type Place,
  type Slot,
  type StepRef,
} from "@kampong/spec";
import { ExpressionField } from "./ExpressionField.js";
import { SchemaEditor } from "./SchemaEditor.js";
import {
  DeletableRow,
  type MoveOutcome,
  type RemoveOutcome,
  type RenameOutcome,
} from "./DeleteControl.js";

// Edit a step that is already in the workflow (KAM-162, a slice of KAM-110). Lists every step, nested ones
// included, and opens the one chosen in place. The form logic is in packages/spec (step-edit.ts), so what is
// built here is what the loader accepts; this collects the text and sends the result as a patch.

export interface StepsPanelProps {
  spec: AgentSpec;
  /** Applies a patch. Resolves false when the save failed, so the form stays open with its input. */
  onPatch: (ops: PatchOp[]) => Promise<boolean>;
  /** Opens the tool at this index of `agent.tools` in the tool form. Without it the tool list is not shown. */
  onEditTool?: (index: number) => void;
  /** Deletes a step or a tool through `ApiClient.applyOps`. Without it the rows have no Delete button. */
  onRemove?: (
    op: { op: "step.remove"; step: string } | { op: "tool.remove"; tool: string },
  ) => Promise<RemoveOutcome>;
  /** Renames a step or a tool and rewrites what uses it, through `ApiClient.applyOps`. Without it there is no Rename button. */
  onRename?: (
    op:
      | { op: "step.rename"; step: string; to: string }
      | { op: "tool.rename"; tool: string; to: string },
  ) => Promise<RenameOutcome>;
  /** Moves a step one place up or down in its own list, through `ApiClient.applyOps`. Without it there are no Move buttons. */
  onMove?: (op: { op: "step.move"; step: string; to: Place }) => Promise<MoveOutcome>;
}

/** The list a step sits in, as the `place` the move operation takes, and where it is in that list. */
function listOf(
  refs: StepRef[],
  ref: StepRef,
): { place: Place["in"]; index: number; length: number } {
  const listPath = ref.path.slice(0, -1);
  const index = ref.path[ref.path.length - 1] as number;
  const length = refs.filter(
    (r) => r.path.length === ref.path.length && listPath.every((seg, i) => r.path[i] === seg),
  ).length;
  if (listPath.length === 2) return { place: "workflow", index, length };
  // [..., parent index, "foreach", "steps"] or [..., parent index, "branch", "then" | "else" | "default" | "cases", key?]
  // The container is the nearest "foreach" / "branch" segment from the end (a nested one has earlier ones).
  const at = Math.max(listPath.lastIndexOf("foreach"), listPath.lastIndexOf("branch"));
  const parentPath = listPath.slice(0, at);
  const parent = refs.find(
    (r) => r.path.length === parentPath.length && parentPath.every((seg, i) => r.path[i] === seg),
  );
  const rest = listPath.slice(at);
  const slot: Slot = rest[0] === "foreach" ? "steps" : (rest[1] as Slot);
  const key = slot === "cases" ? String(rest[2]) : undefined;
  return {
    place: { step: parent?.name ?? "", slot, ...(key !== undefined && { key }) },
    index,
    length,
  };
}

/** How many places read this step or tool by name (one per field), for "3 places will be updated". */
function usedIn(spec: AgentSpec, query: { step: string } | { tool: string }): number {
  return new Set(occurrencesFor(spec, query).map((o) => JSON.stringify(o.path))).size;
}

/** "and the 2 steps inside it" for a loop or branch, so the confirm says what else goes. */
function insideCount(refs: StepRef[], ref: StepRef): string | undefined {
  const n = refs.filter((r) => r.within.includes(ref.name)).length;
  return n > 0 ? `and the ${n} step${n === 1 ? "" : "s"} inside it` : undefined;
}

type ActionRef = StepRef & { step: Extract<StepRef["step"], { action: string }> };
const isAction = (ref: StepRef): ref is ActionRef => ref.kind === "action";
type DataRef = StepRef & {
  step: Extract<StepRef["step"], { type: "transform" | "validate" | "dedupe" }>;
};
const isData = (ref: StepRef): ref is DataRef =>
  ref.kind === "transform" || ref.kind === "validate" || ref.kind === "dedupe";
type SimpleRef = StepRef & { step: Parameters<typeof simpleStepToEditInput>[0] };
const isSimple = (ref: StepRef): ref is SimpleRef => isSimpleStep(ref.step);
type ForEachRef = StepRef & { step: Extract<StepRef["step"], { foreach: unknown }> };
const isForEach = (ref: StepRef): ref is ForEachRef => ref.kind === "foreach";
type BranchRef = StepRef & { step: Extract<StepRef["step"], { branch: unknown }> };
const isBranch = (ref: StepRef): ref is BranchRef => ref.kind === "branch";

/** Why a step has no Edit button, shown in its row. Only the kinds with no form need one. */
const NOT_EDITABLE: Record<string, string> = {
  condition: "Condition steps are edited in the YAML",
};

type Editing =
  | { key: string; kind: "action"; input: ActionStepEditInput }
  | { key: string; kind: "data"; input: DataStepEditInput }
  | { key: string; kind: "simple"; input: SimpleStepEditInput }
  | { key: string; kind: "foreach"; input: ForEachEditInput }
  | { key: string; kind: "branch"; input: BranchEditInput };

/** What an expression in this step can read: the spec's vars, trigger and steps, plus a foreach's loop variable and the body steps ahead of it. */
function scopeFor(spec: AgentSpec, ref: StepRef): ExpressionScope | undefined {
  return spec.version === "1.1" ? expressionScopeForStepAt(spec, ref.path) : undefined;
}

/** A text area for a prompt: as tall as its text, so a long one is not cut off. */
function PromptField({
  label,
  value,
  placeholder,
  onChange,
  spellCheck,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  spellCheck?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(ref, value);
  return (
    <label className="md3-field">
      <span className="md3-body-small md3-field__label">{label}</span>
      <textarea
        ref={ref}
        className="md3-text-field"
        value={value}
        rows={3}
        placeholder={placeholder}
        {...(spellCheck === false && { spellCheck: false })}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function StepsPanel({
  spec,
  onPatch,
  onEditTool,
  onRemove,
  onRename,
  onMove,
}: StepsPanelProps) {
  const refs = listSteps(spec);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Opening a form scrolls the panel back to the top: the Edit button sits in a list below the form, so a
  // scrolled panel would leave the form (and its sticky Save row) above the fold.
  const top = useRef<HTMLElement>(null);
  const editingKey = editing?.key;
  useEffect(() => {
    if (editingKey !== undefined) top.current?.scrollIntoView?.({ block: "start" });
  }, [editingKey]);
  const modern = spec.version === "1.1";
  const toolNames = (spec.agent.tools ?? []).map((t) => t.name);
  const keyOf = (ref: StepRef) => ref.path.join("/");
  const current = editing && refs.find((r) => keyOf(r) === editing.key);

  const close = () => {
    setEditing(null);
    setErrors([]);
  };
  const patch = (change: Partial<ActionStepEditInput>) =>
    setEditing((e) => (e && e.kind === "action" ? { ...e, input: { ...e.input, ...change } } : e));
  const patchData = (change: Record<string, string>) =>
    setEditing((e) =>
      e && e.kind === "data" ? { ...e, input: { ...e.input, ...change } as DataStepEditInput } : e,
    );

  const patchLoop = (change: Partial<ForEachEditInput>) =>
    setEditing((e) => (e && e.kind === "foreach" ? { ...e, input: { ...e.input, ...change } } : e));
  const patchSimple = (change: Record<string, string>) =>
    setEditing((e) =>
      e && e.kind === "simple"
        ? { ...e, input: { ...e.input, ...change } as SimpleStepEditInput }
        : e,
    );

  const setRows = (change: (rows: SetRow[]) => SetRow[]) =>
    setEditing((e) =>
      e && e.kind === "data" && e.input.kind === "transform"
        ? { ...e, input: { ...e.input, set: change(e.input.set) } }
        : e,
    );
  const patchRow = (i: number, change: Partial<SetRow>) =>
    setRows((rows) => rows.map((row, at) => (at === i ? { ...row, ...change } : row)));
  const removeRow = (i: number) => setRows((rows) => rows.filter((_, at) => at !== i));
  const addRow = () => setRows((rows) => [...rows, { name: "", expression: "" }]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !current) return;
    const result =
      editing.kind === "action" && isAction(current)
        ? buildActionStepEdit(editing.input, current, spec.version, scopeFor(spec, current))
        : editing.kind === "data" && isData(current)
          ? buildDataStepEdit(editing.input, current, spec.version, scopeFor(spec, current))
          : editing.kind === "simple" && isSimple(current)
            ? buildSimpleStepEdit(
                editing.input,
                current,
                spec.version,
                toolNames,
                scopeFor(spec, current),
              )
            : editing.kind === "foreach" && isForEach(current)
              ? buildForEachEdit(editing.input, current, spec.version, scopeFor(spec, current))
              : editing.kind === "branch" && isBranch(current)
                ? buildBranchEdit(editing.input, current, spec.version, scopeFor(spec, current))
                : { success: false as const, errors: ["The form does not match the step"] };
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    if (result.patch.length === 0) {
      close();
      return;
    }
    setBusy(true);
    const saved = await onPatch(result.patch);
    setBusy(false);
    if (saved) close();
    else setErrors(["Could not save the change. Your input is kept; try again."]);
  }

  return (
    <section ref={top} className="md3-doctor" aria-label="Steps" data-testid="steps-panel">
      <p className="md3-body-small md3-field__hint">
        Edit a step in place: an action step's query, instructions, model, temperature and output
        schema, a transform, validate or dedupe step's expressions, a tool step's tool, a stop
        step's reason and status, or an approval step's message.
      </p>
      {!modern && <VersionGate what="Per-step settings and an output schema" />}

      {editing && editing.kind === "action" && current && isAction(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form md3-form--fill"
        >
          <span className="md3-title-small">{current.name}</span>
          <PromptField
            label="Query"
            value={editing.input.query}
            spellCheck={false}
            placeholder="What this step asks the model; {{ step.field }} inserts a value"
            onChange={(query) => patch({ query })}
          />
          <PromptField
            label="Instructions"
            value={editing.input.instructions}
            placeholder="Replaces the agent's role and goal for this step (blank keeps them)"
            onChange={(instructions) => patch({ instructions })}
          />
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Model</span>
            <input
              className="md3-text-field"
              value={editing.input.model}
              placeholder="A model of the agent's provider (blank keeps the agent's)"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ model: e.target.value })}
            />
          </label>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Temperature</span>
            <input
              className="md3-text-field"
              value={editing.input.temperature}
              placeholder="0 to 2 (blank keeps the agent's)"
              autoComplete="off"
              onChange={(e) => patch({ temperature: e.target.value })}
            />
          </label>
          <fieldset className="md3-schema__group">
            <legend className="md3-body-small">Output schema</legend>
            {editing.input.schema ? (
              <>
                <SchemaEditor
                  root
                  path="output_schema"
                  draft={editing.input.schema}
                  onChange={(schema) => patch({ schema })}
                />
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  onClick={() => patch({ schema: undefined })}
                >
                  Remove output schema
                </button>
              </>
            ) : (
              <button
                type="button"
                className="md3-button md3-button-tonal"
                onClick={() => patch({ schema: emptySchemaDraft("object") })}
              >
                Add output schema
              </button>
            )}
          </fieldset>
          <PanelError messages={errors} />
          <PanelFooter save="Save step" disabled={busy} onCancel={close} />
        </form>
      )}

      {editing && editing.kind === "data" && current && isData(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form md3-form--fill"
        >
          <span className="md3-title-small">{current.name}</span>
          {editing.input.kind === "transform" && (
            <fieldset className="md3-fieldset">
              <legend className="md3-label-large">Values</legend>
              {editing.input.set.map((row, i) => (
                <div key={i} className="md3-setrow">
                  <div className="md3-setrow__head">
                    <label className="md3-field">
                      <span className="md3-body-small md3-field__label">Name</span>
                      <input
                        className="md3-text-field"
                        aria-label={`Value ${i + 1} name`}
                        value={row.name}
                        spellCheck={false}
                        onChange={(e) => patchRow(i, { name: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="md3-button md3-button-text"
                      aria-label={`Remove value ${i + 1}`}
                      onClick={() => removeRow(i)}
                    >
                      Remove
                    </button>
                  </div>
                  <ExpressionField
                    label="Expression"
                    accessibleName={`Value ${i + 1} expression`}
                    value={row.expression}
                    scope={scopeFor(spec, current)}
                    multiline
                    onChange={(expression) => patchRow(i, { expression })}
                  />
                </div>
              ))}
              <button type="button" className="md3-button md3-button-tonal" onClick={addRow}>
                Add value
              </button>
            </fieldset>
          )}
          {editing.input.kind === "validate" && (
            <>
              <ExpressionField
                label="Assert (expression that must be true)"
                value={editing.input.assert}
                scope={scopeFor(spec, current)}
                onChange={(assert) => patchData({ assert })}
              />
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">On fail</span>
                <select
                  className="md3-text-field"
                  value={editing.input.onFail}
                  onChange={(e) => patchData({ onFail: e.target.value })}
                >
                  <option value="fail">fail</option>
                  <option value="skip">skip</option>
                </select>
              </label>
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">Message (optional)</span>
                <input
                  className="md3-text-field"
                  value={editing.input.message}
                  onChange={(e) => patchData({ message: e.target.value })}
                />
              </label>
            </>
          )}
          {editing.input.kind === "dedupe" && (
            <>
              <ExpressionField
                label="Key (expression)"
                value={editing.input.key}
                scope={scopeFor(spec, current)}
                onChange={(key) => patchData({ key })}
              />
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">TTL (e.g. 24h)</span>
                <input
                  className="md3-text-field"
                  value={editing.input.ttl}
                  onChange={(e) => patchData({ ttl: e.target.value })}
                />
              </label>
            </>
          )}
          <PanelError messages={errors} />
          <PanelFooter save="Save step" disabled={busy} onCancel={close} />
        </form>
      )}

      {editing && editing.kind === "branch" && current && isBranch(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form md3-form--fill"
        >
          <span className="md3-title-small">{current.name}</span>
          <ExpressionField
            label={
              editing.input.mode === "if"
                ? "If (expression that gives true or false)"
                : "Switch on (expression that gives the value)"
            }
            value={editing.input.expression}
            scope={scopeFor(spec, current)}
            onChange={(expression) =>
              setEditing((e) =>
                e && e.kind === "branch" ? { ...e, input: { ...e.input, expression } } : e,
              )
            }
          />
          <p className="md3-body-small md3-field__hint">
            The arms are the steps below it in this list: edit, delete or add to them there.
          </p>
          <PanelError messages={errors} />
          <PanelFooter save="Save step" disabled={busy} onCancel={close} />
        </form>
      )}

      {editing && editing.kind === "foreach" && current && isForEach(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form md3-form--fill"
        >
          <span className="md3-title-small">{current.name}</span>
          <ExpressionField
            label="Items (expression that gives a list)"
            value={editing.input.items}
            scope={scopeFor(spec, current)}
            onChange={(items) => patchLoop({ items })}
          />
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Loop variable</span>
            <input
              className="md3-text-field"
              value={editing.input.as}
              spellCheck={false}
              onChange={(e) => patchLoop({ as: e.target.value })}
            />
          </label>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Concurrency</span>
            <input
              className="md3-text-field"
              value={editing.input.concurrency}
              placeholder="1 to 32 (blank runs one at a time)"
              autoComplete="off"
              onChange={(e) => patchLoop({ concurrency: e.target.value })}
            />
          </label>
          {editing.input.onError === "keep" ? (
            <p className="md3-body-small md3-field__hint">
              This loop sends a failed item to another step (on_error goto). That is edited in the
              YAML.
            </p>
          ) : (
            <>
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">On error</span>
                <select
                  className="md3-text-field"
                  value={editing.input.onError}
                  onChange={(e) =>
                    patchLoop({ onError: e.target.value as ForEachEditInput["onError"] })
                  }
                >
                  <option value="">Default (fail)</option>
                  <option value="fail">fail</option>
                  <option value="continue">continue</option>
                  <option value="retry">retry</option>
                </select>
              </label>
              {editing.input.onError === "retry" && (
                <label className="md3-field">
                  <span className="md3-body-small md3-field__label">Retries</span>
                  <input
                    className="md3-text-field"
                    value={editing.input.retries}
                    autoComplete="off"
                    onChange={(e) => patchLoop({ retries: e.target.value })}
                  />
                </label>
              )}
            </>
          )}
          <PanelError messages={errors} />
          <PanelFooter save="Save step" disabled={busy} onCancel={close} />
        </form>
      )}

      {editing && editing.kind === "simple" && current && isSimple(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form md3-form--fill"
        >
          <span className="md3-title-small">{current.name}</span>
          {editing.input.kind === "tool" && (
            <label className="md3-field">
              <span className="md3-body-small md3-field__label">Tool</span>
              <select
                className="md3-text-field"
                value={editing.input.tool}
                onChange={(e) => patchSimple({ tool: e.target.value })}
              >
                {!toolNames.includes(editing.input.tool) && (
                  <option value={editing.input.tool}>{editing.input.tool} (not defined)</option>
                )}
                {toolNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {editing.input.kind === "stop" && (
            <>
              <PromptField
                label="Reason"
                value={editing.input.reason}
                spellCheck={false}
                placeholder="Why the run ends here; {{ step.field }} inserts a value"
                onChange={(reason) => patchSimple({ reason })}
              />
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">Status</span>
                <select
                  className="md3-text-field"
                  value={editing.input.status}
                  onChange={(e) => patchSimple({ status: e.target.value })}
                >
                  <option value="">Default (completed)</option>
                  <option value="completed">completed</option>
                  <option value="skipped">skipped</option>
                </select>
              </label>
            </>
          )}
          {editing.input.kind === "approval" && (
            <PromptField
              label="Message"
              value={editing.input.message}
              spellCheck={false}
              placeholder="Shown to the approver; {{ step.field }} inserts a value"
              onChange={(message) => patchSimple({ message })}
            />
          )}
          <PanelError messages={errors} />
          <PanelFooter save="Save step" disabled={busy} onCancel={close} />
        </form>
      )}

      <ul className="md3-doctor__list" data-testid="steps-list">
        {refs.map((ref) => (
          <DeletableRow
            // Keyed by name, so a moved step's row (and the focus on its button) moves with it.
            key={`${ref.name}#${refs.slice(0, refs.indexOf(ref)).filter((r) => r.name === ref.name).length}`}
            spec={spec}
            noun="step"
            name={ref.name}
            hint={`${ref.kind}${ref.within.length > 0 ? ` in ${ref.within.join(" > ")}` : ""}`}
            extra={insideCount(refs, ref)}
            disabled={busy || editing !== null}
            onRemove={onRemove && (() => onRemove({ op: "step.remove", step: ref.name }))}
            onRename={onRename && ((to) => onRename({ op: "step.rename", step: ref.name, to }))}
            usedIn={usedIn(spec, { step: ref.name })}
            move={
              onMove &&
              (() => {
                const { place, index, length } = listOf(refs, ref);
                return {
                  canUp: index > 0,
                  canDown: index < length - 1,
                  run: (direction) =>
                    onMove({
                      op: "step.move",
                      step: ref.name,
                      to: { in: place, index: direction === "up" ? index - 1 : index + 1 },
                    }),
                };
              })()
            }
          >
            {(isAction(ref) || isData(ref) || isSimple(ref) || isForEach(ref) || isBranch(ref)) && (
              <button
                type="button"
                className="md3-button md3-button-text"
                disabled={busy || editing !== null || (!modern && !isSimple(ref))}
                aria-label={`Edit ${ref.name}`}
                onClick={() => {
                  setErrors([]);
                  setEditing(
                    isAction(ref)
                      ? {
                          key: keyOf(ref),
                          kind: "action",
                          input: actionStepToEditInput(ref.step),
                        }
                      : isSimple(ref)
                        ? {
                            key: keyOf(ref),
                            kind: "simple",
                            input: simpleStepToEditInput(ref.step),
                          }
                        : isForEach(ref)
                          ? {
                              key: keyOf(ref),
                              kind: "foreach",
                              input: forEachToEditInput(ref.step),
                            }
                          : isBranch(ref)
                            ? {
                                key: keyOf(ref),
                                kind: "branch",
                                input: branchToEditInput(ref.step),
                              }
                            : {
                                key: keyOf(ref),
                                kind: "data",
                                input: dataStepToEditInput((ref as DataRef).step),
                              },
                  );
                }}
              >
                Edit
              </button>
            )}
            {NOT_EDITABLE[ref.kind] && (
              <span className="md3-body-small md3-field__hint">{NOT_EDITABLE[ref.kind]}</span>
            )}
          </DeletableRow>
        ))}
      </ul>

      {onEditTool && (
        <>
          <span className="md3-title-small">Tools</span>
          <ul className="md3-doctor__list" data-testid="tools-list">
            {(spec.agent.tools ?? []).map((tool, index) => (
              <DeletableRow
                key={tool.name}
                spec={spec}
                noun="tool"
                name={tool.name}
                hint={tool.action === "component" ? `${tool.use} ${tool.op}` : tool.action}
                disabled={busy || editing !== null}
                onRemove={onRemove && (() => onRemove({ op: "tool.remove", tool: tool.name }))}
                onRename={
                  onRename && ((to) => onRename({ op: "tool.rename", tool: tool.name, to }))
                }
                usedIn={usedIn(spec, { tool: tool.name })}
              >
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || editing !== null}
                  aria-label={`Edit tool ${tool.name}`}
                  onClick={() => onEditTool(index)}
                >
                  Edit
                </button>
              </DeletableRow>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
