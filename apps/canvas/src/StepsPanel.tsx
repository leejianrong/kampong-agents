import { useState } from "react";
import {
  actionStepToEditInput,
  buildActionStepEdit,
  buildDataStepEdit,
  dataStepToEditInput,
  emptySchemaDraft,
  expressionScopeFor,
  listSteps,
  type ActionStepEditInput,
  type DataStepEditInput,
  type ExpressionScope,
  type AgentSpec,
  type PatchOp,
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

/** What an expression in this step can read: the spec's vars, trigger and steps, plus a foreach's loop variable. */
function scopeFor(spec: AgentSpec, refs: StepRef[], ref: StepRef): ExpressionScope | undefined {
  if (spec.version !== "1.1") return undefined;
  const local = ref.within.flatMap((name) => {
    const parent = refs.find((r) => r.name === name)?.step;
    return parent && "foreach" in parent ? [{ name: parent.foreach.as, fields: [] }] : [];
  });
  return expressionScopeFor(spec, { before: ref.name, ...(local.length > 0 && { local }) });
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !current) return;
    const result =
      editing.kind === "action" && isAction(current)
        ? buildActionStepEdit(editing.input, current, spec.version)
        : editing.kind === "data" && isData(current)
          ? buildDataStepEdit(editing.input, current, spec.version, scopeFor(spec, refs, current))
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
      <div className="md3-doctor__head">
        <span className="md3-title-medium">Steps</span>
      </div>
      <p className="md3-body-small md3-field__hint">
        Edit a step in place: an action step's instructions, model, temperature and output schema,
        or a transform, validate or dedupe step's expressions.
      </p>
      {!modern && (
        <p role="status" className="md3-banner md3-banner--info">
          Per-step settings and an output schema need spec version <code>"1.1"</code>. Change{" "}
          <code>version</code> in the YAML when you are ready: 1.1 reads <code>{"{{ }}"}</code>{" "}
          references as expressions, which can change what an existing 1.0 spec means.
        </p>
      )}

      {editing && editing.kind === "action" && current && isAction(current) && (
        <form
          onSubmit={(e) => void submit(e)}
          aria-label={`Edit ${current.name}`}
          className="md3-form"
        >
          <span className="md3-title-small">{current.name}</span>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Instructions</span>
            <textarea
              className="md3-text-field"
              value={editing.input.instructions}
              placeholder="Replaces the agent's role and goal for this step (blank keeps them)"
              onChange={(e) => patch({ instructions: e.target.value })}
            />
          </label>
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
          className="md3-form"
        >
          <span className="md3-title-small">{current.name}</span>
          {editing.input.kind === "transform" && (
            <ExpressionField
              label="Values (one per line, name: expression)"
              value={editing.input.set}
              scope={scopeFor(spec, refs, current)}
              lines
              onChange={(set) => patchData({ set })}
            />
          )}
          {editing.input.kind === "validate" && (
            <>
              <ExpressionField
                label="Assert (expression that must be true)"
                value={editing.input.assert}
                scope={scopeFor(spec, refs, current)}
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
                scope={scopeFor(spec, refs, current)}
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
