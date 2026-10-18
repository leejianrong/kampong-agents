import { emptySchemaDraft, type SchemaDraft, type SchemaType } from "@kampong/spec";

// The output_schema editor (KAM-162, a slice of KAM-110): a tree of properties, each with a type, a description,
// an enum for the scalar types, and nested properties or array items. It edits a SchemaDraft (packages/spec),
// which buildOutputSchema turns into the schema with the loader's own rules, so this only draws the tree.

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

export function SchemaEditor({ draft, onChange, path, root = false }: SchemaEditorProps) {
  const set = (change: Partial<SchemaDraft>) => onChange({ ...draft, ...change });
  const setProp = (i: number, change: Partial<SchemaDraft["properties"][number]>) =>
    set({ properties: draft.properties.map((p, j) => (j === i ? { ...p, ...change } : p)) });

  return (
    <div className="md3-schema" data-testid={`schema-${path}`}>
      {!root && (
        <>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">{`${path} type`}</span>
            <select
              className="md3-text-field"
              value={draft.type}
              onChange={(e) => onChange(retype(draft, e.target.value as SchemaType))}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="md3-field">
            <span className="md3-body-small md3-field__label">{`${path} description`}</span>
            <input
              className="md3-text-field"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </label>
        </>
      )}
      {root && (
        <label className="md3-field">
          <span className="md3-body-small md3-field__label">{`${path} description`}</span>
          <input
            className="md3-text-field"
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
      )}
      {draft.type !== "object" && draft.type !== "array" && (
        <label className="md3-field">
          <span className="md3-body-small md3-field__label">{`${path} allowed values`}</span>
          <input
            className="md3-text-field"
            value={draft.enum}
            placeholder="spam, ham (blank allows any)"
            onChange={(e) => set({ enum: e.target.value })}
          />
        </label>
      )}
      {draft.type === "array" && draft.items && (
        <fieldset className="md3-schema__group">
          <legend className="md3-body-small">{`${path} items`}</legend>
          <SchemaEditor
            draft={draft.items}
            path={`${path}[]`}
            onChange={(items) => set({ items })}
          />
        </fieldset>
      )}
      {draft.type === "object" && (
        <fieldset className="md3-schema__group">
          <legend className="md3-body-small">{`${path} properties`}</legend>
          {draft.properties.map((prop, i) => {
            const at = `${path}.${prop.name || i + 1}`;
            return (
              <div key={i} className="md3-schema__prop">
                <label className="md3-field">
                  <span className="md3-body-small md3-field__label">{`${path} property ${i + 1} name`}</span>
                  <input
                    className="md3-text-field"
                    value={prop.name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setProp(i, { name: e.target.value })}
                  />
                </label>
                <label className="md3-field md3-field--inline">
                  <input
                    type="checkbox"
                    checked={prop.required}
                    onChange={(e) => setProp(i, { required: e.target.checked })}
                  />
                  <span className="md3-body-medium">{`${at} required`}</span>
                </label>
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
