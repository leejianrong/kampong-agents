import { emptySchemaDraft, type SchemaDraft, type SchemaType } from "@kampong/spec";

// The output_schema editor (KAM-162, a slice of KAM-110): a tree of properties, each with a type, a description,
// an enum and length or range limits for the scalar types, and nested properties or array items. It edits a
// SchemaDraft (packages/spec), which buildOutputSchema turns into the schema with the loader's own rules, so this
// only draws the tree.
//
// KAM-167: what a person sees is plain ("Type", "Max length"); the full path (`output_schema.summary type`) is the
// control's accessible name, so a screen reader and a test can still tell the same field of two properties apart.

const TYPES: SchemaType[] = ["string", "number", "integer", "boolean", "object", "array"];

export interface SchemaEditorProps {
  draft: SchemaDraft;
  onChange: (draft: SchemaDraft) => void;
  /** Names the controls (`output_schema.label`), so each one in a nested tree has its own label. */
  path: string;
  /** The root is always an object, so its type is not offered. */
  root?: boolean;
}

function retype(draft: SchemaDraft, type: SchemaType): SchemaDraft {
  return {
    ...draft,
    type,
    enum: type === "object" || type === "array" ? "" : draft.enum,
    properties: type === "object" ? draft.properties : [],
    ...(type === "array"
      ? { items: draft.items ?? emptySchemaDraft("string") }
      : { items: undefined }),
  };
}

/** A labelled control: `text` is what is shown, `name` the accessible name that says whose it is. */
function Field({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="md3-field">
      <span className="md3-body-small md3-field__label">{text}</span>
      {children}
    </label>
  );
}

export function SchemaEditor({ draft, onChange, path, root = false }: SchemaEditorProps) {
  const set = (change: Partial<SchemaDraft>) => onChange({ ...draft, ...change });
  const setProp = (i: number, change: Partial<SchemaDraft["properties"][number]>) =>
    set({ properties: draft.properties.map((p, j) => (j === i ? { ...p, ...change } : p)) });
  const scalar = draft.type !== "object" && draft.type !== "array";
  const text = (name: keyof SchemaDraft, label: string, placeholder?: string) => (
    <Field text={label}>
      <input
        className="md3-text-field"
        aria-label={`${path} ${label.toLowerCase()}`}
        value={draft[name] as string}
        placeholder={placeholder}
        inputMode={name === "enum" || name === "description" ? undefined : "decimal"}
        onChange={(e) => set({ [name]: e.target.value })}
      />
    </Field>
  );

  return (
    <div className="md3-schema" data-testid={`schema-${path}`}>
      {!root && (
        <Field text="Type">
          <select
            className="md3-text-field"
            aria-label={`${path} type`}
            value={draft.type}
            onChange={(e) => onChange(retype(draft, e.target.value as SchemaType))}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      )}
      {text("description", "Description")}
      {scalar && text("enum", "Allowed values", "spam, ham (blank allows any)")}
      {draft.type === "string" && (
        <div className="md3-schema__pair">
          {text("minLength", "Min length")}
          {text("maxLength", "Max length")}
        </div>
      )}
      {(draft.type === "number" || draft.type === "integer") && (
        <div className="md3-schema__pair">
          {text("minimum", "Minimum")}
          {text("maximum", "Maximum")}
        </div>
      )}
      {draft.type === "array" && draft.items && (
        <fieldset className="md3-schema__group">
          <legend className="md3-body-small">Items</legend>
          <SchemaEditor
            draft={draft.items}
            path={`${path}[]`}
            onChange={(items) => set({ items })}
          />
        </fieldset>
      )}
      {draft.type === "object" && (
        <fieldset className="md3-schema__group">
          <legend className="md3-body-small">Properties</legend>
          {draft.properties.map((prop, i) => {
            const at = `${path}.${prop.name || i + 1}`;
            return (
              <div key={i} className="md3-schema__prop">
                <div className="md3-schema__head">
                  <Field text="Name">
                    <input
                      className="md3-text-field"
                      aria-label={`${path} property ${i + 1} name`}
                      value={prop.name}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setProp(i, { name: e.target.value })}
                    />
                  </Field>
                  <label className="md3-schema__required">
                    <input
                      type="checkbox"
                      aria-label={`${at} required`}
                      checked={prop.required}
                      onChange={(e) => setProp(i, { required: e.target.checked })}
                    />
                    <span className="md3-body-medium">Required</span>
                  </label>
                </div>
                <SchemaEditor
                  draft={prop.draft}
                  path={at}
                  onChange={(next) => setProp(i, { draft: next })}
                />
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  aria-label={`Remove ${at}`}
                  onClick={() => set({ properties: draft.properties.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="md3-button md3-button-tonal"
            aria-label={`Add property to ${path}`}
            onClick={() =>
              set({
                properties: [
                  ...draft.properties,
                  { name: "", required: false, draft: emptySchemaDraft("string") },
                ],
              })
            }
          >
            Add property
          </button>
        </fieldset>
      )}
    </div>
  );
}
