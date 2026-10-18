import { useRef, useState } from "react";
import { VersionGate } from "./VersionGate.js";
import { useAutoHeight } from "./useAutoHeight.js";
import {
  actionStepToEditInput,
  buildActionStepEdit,
  buildDataStepEdit,
  dataStepToEditInput,
  emptySchemaDraft,
  expressionScopeForStepAt,
  listSteps,
  type ActionStepEditInput,
  type DataStepEditInput,
  type ExpressionScope,
  type AgentSpec,
  type PatchOp,
  type SetRow,
  type StepRef,
} from "@kampong/spec";
import { ExpressionField } from "./ExpressionField.js";
import { SchemaEditor } from "./SchemaEditor.js";

// Edit a step that is already in the workflow (KAM-162, a slice of KAM-110). Lists every step, nested ones
// included, and opens the one chosen in place. The form logic is in packages/spec (step-edit.ts), so what is
// built here is what the loader accepts; this collects the text and sends the result as a patch.

export interface StepsPanelProps {
  spec: AgentSpec;
  /** Applies a patch. Resolves false when the save failed, so the form stays open with its input. */
  onPatch: (ops: PatchOp[]) => Promise<boolean>;
}

type ActionRef = StepRef & { step: Extract<StepRef["step"], { action: string }> };
const isAction = (ref: StepRef): ref is ActionRef => ref.kind === "action";
type DataRef = StepRef & {
  step: Extract<StepRef["step"], { type: "transform" | "validate" | "dedupe" }>;
};
const isData = (ref: StepRef): ref is DataRef =>
  ref.kind === "transform" || ref.kind === "validate" || ref.kind === "dedupe";

type Editing =
  | { key: string; kind: "action"; input: ActionStepEditInput }
  | { key: string; kind: "data"; input: DataStepEditInput };

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

export function StepsPanel({ spec, onPatch }: StepsPanelProps) {
  const refs = listSteps(spec);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const modern = spec.version === "1.1";
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
    <section className="md3-doctor" aria-label="Steps" data-testid="steps-panel">
      <p className="md3-body-small md3-field__hint">
        Edit a step in place: an action step's query, instructions, model, temperature and output
        schema, or a transform, validate or dedupe step's expressions.
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
          {errors.length > 0 && (
            <ul role="alert" className="md3-error-list">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <div className="md3-trust__actions">
            <button type="submit" className="md3-button md3-button-filled" disabled={busy}>
              Save step
            </button>
            <button type="button" className="md3-button md3-button-text" onClick={close}>
              Cancel
            </button>
          </div>
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
          {errors.length > 0 && (
            <ul role="alert" className="md3-error-list">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <div className="md3-trust__actions">
            <button type="submit" className="md3-button md3-button-filled" disabled={busy}>
              Save step
            </button>
            <button type="button" className="md3-button md3-button-text" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <ul className="md3-doctor__list" data-testid="steps-list">
        {refs.map((ref) => (
          <li key={keyOf(ref)} className="md3-secrets__row">
            <span className="md3-vars__name">
              <span className="md3-body-medium">{ref.name}</span>
              <span className="md3-body-small md3-field__hint">
                {ref.kind}
                {ref.within.length > 0 ? ` in ${ref.within.join(" > ")}` : ""}
              </span>
            </span>
            <span className="md3-secrets__actions">
              {(isAction(ref) || isData(ref)) && (
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || editing !== null || !modern}
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
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
