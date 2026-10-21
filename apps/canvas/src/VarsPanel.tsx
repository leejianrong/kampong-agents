import { PanelError, PanelFooter } from "./Panel";
import { useState } from "react";
import { VersionGate } from "./VersionGate.js";
import { buildVarFromForm, varToFormInput, type SpecVar, type VarFormInput } from "@kampong/spec";

// Spec vars (KAM-159, a slice of KAM-110): the `vars:` a spec declares, which `kampong run --var` and an
// expression's `vars.name` read. Not the credentials in the Secrets panel: those are `${ENV}` values kept
// outside the spec, these are the spec's own inputs. The form logic lives in packages/spec (buildVarFromForm),
// so a var built here always validates; this only collects the text and sends the result as a patch.

export interface VarsPanelProps {
  version: string;
  vars: Record<string, SpecVar> | undefined;
  /** Saves one var. Resolves false when the save failed, so the form stays open with its input. */
  onSave: (name: string, value: SpecVar) => Promise<boolean>;
  onRemove: (name: string) => Promise<boolean>;
}

const EMPTY: VarFormInput = { name: "", type: "string" };

function describeVar(v: SpecVar): string {
  const type = v.type === "list" ? `list of ${v.items ?? "string"}` : v.type;
  const def = v.default === undefined ? "required" : `default ${JSON.stringify(v.default)}`;
  return `${type}, ${def}`;
}

export function VarsPanel({ version, vars, onSave, onRemove }: VarsPanelProps) {
  const [form, setForm] = useState<{ input: VarFormInput; editing: boolean } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // What is on screen no longer matches what failed once the person changes it (KAM-194).
  const clearErrors = () => setErrors((current) => (current.length > 0 ? [] : current));
  const [busy, setBusy] = useState(false);
  const names = Object.keys(vars ?? {});
  const supported = version === "1.1";

  const close = () => {
    setForm(null);
    setErrors([]);
  };
  const patch = (change: Partial<VarFormInput>) =>
    setForm((f) => (f ? { ...f, input: { ...f.input, ...change } } : f));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    const result = buildVarFromForm(form.input, form.editing ? [] : names);
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    setBusy(true);
    const saved = await onSave(result.name, result.value);
    setBusy(false);
    // A failed save is explained by the panel shell, in the server's words and beside the input that was kept (KAM-194).
    if (saved) close();
  }

  async function remove(name: string) {
    setBusy(true);
    await onRemove(name);
    setBusy(false);
  }

  return (
    <section className="md3-doctor" aria-label="Spec vars" data-testid="vars-panel">
      <div className="md3-doctor__head">
        <button
          type="button"
          className="md3-button md3-button-tonal"
          disabled={!supported || busy || form !== null}
          onClick={() => setForm({ input: EMPTY, editing: false })}
        >
          Add var
        </button>
      </div>
      <p className="md3-body-small md3-field__hint">
        Inputs the spec declares under <code>vars:</code>. A run takes a value with{" "}
        <code>--var name=value</code>, and an expression reads it as <code>vars.name</code>.
      </p>
      {!supported && <VersionGate what="Vars" />}

      {form && (
        <form
          onSubmit={(e) => void submit(e)}
          onChange={clearErrors}
          aria-label="Spec var"
          className="md3-form"
        >
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Name</span>
            <input
              className="md3-text-field"
              value={form.input.name}
              disabled={form.editing}
              placeholder="symbols"
              autoComplete="off"
              spellCheck={false}
              autoFocus={!form.editing}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Type</span>
            <select
              className="md3-text-field"
              value={form.input.type}
              onChange={(e) => patch({ type: e.target.value as VarFormInput["type"] })}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="list">list</option>
            </select>
          </label>
          {form.input.type === "list" && (
            <label className="md3-field">
              <span className="md3-body-small md3-field__label">List holds</span>
              <select
                className="md3-text-field"
                value={form.input.items ?? "string"}
                onChange={(e) => patch({ items: e.target.value as "string" | "number" })}
              >
                <option value="string">strings</option>
                <option value="number">numbers</option>
              </select>
            </label>
          )}
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Default</span>
            <input
              className="md3-text-field"
              value={form.input.default ?? ""}
              placeholder={form.input.type === "list" ? "AAPL, MSFT" : ""}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ default: e.target.value })}
            />
            <span className="md3-body-small md3-field__hint">
              Leave blank to require a value on every run. <code>{"${ENV_VAR}"}</code> reads the
              environment.
            </span>
          </label>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">Description</span>
            <input
              className="md3-text-field"
              value={form.input.description ?? ""}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
          <PanelError messages={errors} />
          <PanelFooter
            save="Save var"
            disabled={busy}
            disabledReason="Saving, one moment."
            onCancel={close}
          />
        </form>
      )}

      {names.length === 0 && form === null && (
        <p className="md3-body-medium">This spec declares no vars.</p>
      )}
      {names.length > 0 && (
        <ul className="md3-doctor__list" data-testid="vars-list">
          {names.map((name) => (
            <li key={name} className="md3-secrets__row">
              <span className="md3-vars__name">
                <span className="md3-body-medium">{name}</span>
                <span className="md3-body-small md3-field__hint">
                  {describeVar(vars![name]!)}
                  {vars![name]!.description ? ` — ${vars![name]!.description}` : ""}
                </span>
              </span>
              <span className="md3-secrets__actions">
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || form !== null}
                  aria-label={`Edit ${name}`}
                  onClick={() =>
                    setForm({ input: varToFormInput(name, vars![name]!), editing: true })
                  }
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  disabled={busy || form !== null}
                  aria-label={`Remove ${name}`}
                  onClick={() => void remove(name)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
