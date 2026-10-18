import { useState } from "react";
import {
  actionStepToEditInput,
  buildActionStepEdit,
  emptySchemaDraft,
  listSteps,
  type ActionStepEditInput,
  type AgentSpec,
  type PatchOp,
  type StepRef,
} from "@kampong/spec";
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

export function StepsPanel({ spec, onPatch }: StepsPanelProps) {
  const refs = listSteps(spec);
  const [editing, setEditing] = useState<{ key: string; input: ActionStepEditInput } | null>(null);
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
    setEditing((e) => (e ? { ...e, input: { ...e.input, ...change } } : e));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !current || !isAction(current)) return;
    const result = buildActionStepEdit(editing.input, current, spec.version);
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
        Edit a step in place: an action step's instructions, model, temperature and output schema.
      </p>
      {!modern && (
        <p role="status" className="md3-banner md3-banner--info">
          Per-step settings and an output schema need spec version <code>"1.1"</code>. Change{" "}
          <code>version</code> in the YAML when you are ready: 1.1 reads <code>{"{{ }}"}</code>{" "}
          references as expressions, which can change what an existing 1.0 spec means.
        </p>
      )}

      {editing && current && isAction(current) && (
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
              {isAction(ref) && (
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || editing !== null || !modern}
                  aria-label={`Edit ${ref.name}`}
                  onClick={() => {
                    setErrors([]);
                    setEditing({ key: keyOf(ref), input: actionStepToEditInput(ref.step) });
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
