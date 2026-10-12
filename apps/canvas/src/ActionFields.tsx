import {
  buildOutputSchemaFromFields,
  outputFieldsFromSchema,
  type OutputField,
  type OutputFieldType,
  type SchemaNode,
  type WorkflowActionStepFormInput,
} from "@kampong/spec";

// The fields of an action step, shared by "Add Workflow Step" (action kind) and "Edit step" (KAN-1850):
// the action, its inputs, the confidence gate, the per-step instructions / model / temperature (KAN-1842) and
// the output_schema editor (KAN-1843, ADR-0038).

export interface ActionFormState {
  action: string;
  inputs: string;
  confidenceGate: boolean;
  instructions: string;
  model: string;
  temperature: string;
  outputFields: OutputField[];
  /** A schema the field list cannot show (a nested object, an enum, bounds): kept as written. */
  lockedSchema?: SchemaNode;
  /** What in `lockedSchema` the list cannot show. */
  lockedBecause: string[];
}

export const EMPTY_ACTION_STATE: ActionFormState = {
  action: "",
  inputs: "",
  confidenceGate: false,
  instructions: "",
  model: "",
  temperature: "",
  outputFields: [],
  lockedBecause: [],
};

export function actionStateFromStep(step: Record<string, unknown>): ActionFormState {
  const schema = step["output_schema"] as SchemaNode | undefined;
  const { fields, unsupported } = outputFieldsFromSchema(schema);
  return {
    action: String(step["action"] ?? ""),
    inputs: Array.isArray(step["inputs"]) ? (step["inputs"] as string[]).join(", ") : "",
    confidenceGate: step["confidence_gate"] === true,
    instructions: typeof step["instructions"] === "string" ? step["instructions"] : "",
    model: typeof step["model"] === "string" ? step["model"] : "",
    temperature: typeof step["temperature"] === "number" ? String(step["temperature"]) : "",
    outputFields: unsupported.length > 0 ? [] : fields,
    ...(unsupported.length > 0 && { lockedSchema: schema }),
    lockedBecause: unsupported,
  };
}

/** The form input for `buildWorkflowStepFromForm` / `buildActionStepEdit`, or the problems with the output fields. */
export function actionInputFromState(
  state: ActionFormState,
): { input: Omit<WorkflowActionStepFormInput, "step" | "kind"> } | { errors: string[] } {
  let outputSchema: SchemaNode | undefined = state.lockedSchema;
  if (state.lockedSchema === undefined) {
    const built = buildOutputSchemaFromFields(state.outputFields, {
      confidenceGate: state.confidenceGate,
    });
    if (!built.success) return { errors: built.errors ?? ["Invalid output fields"] };
    outputSchema = built.schema;
  }
  return {
    input: {
      action: state.action,
      inputs: state.inputs,
      confidenceGate: state.confidenceGate,
      instructions: state.instructions.trim(),
      model: state.model.trim(),
      ...(state.temperature.trim() !== "" && { temperature: Number(state.temperature) }),
      ...(outputSchema !== undefined && { outputSchema }),
    },
  };
}

const TYPES: [OutputFieldType, string][] = [
  ["string", "text"],
  ["number", "number"],
  ["integer", "whole number"],
  ["boolean", "true or false"],
  ["string[]", "list of text"],
  ["number[]", "list of numbers"],
];

export interface ActionFieldsProps {
  state: ActionFormState;
  onChange: (next: ActionFormState) => void;
}

export function ActionFields({ state, onChange }: ActionFieldsProps) {
  const set = <K extends keyof ActionFormState>(key: K, value: ActionFormState[K]) =>
    onChange({ ...state, [key]: value });
  const setField = (index: number, patch: Partial<OutputField>) =>
    set(
      "outputFields",
      state.outputFields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    );

  return (
    <>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Action</span>
        <input
          className="md3-text-field"
          value={state.action}
          onChange={(e) => set("action", e.target.value)}
        />
      </label>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Inputs (comma-separated)</span>
        <input
          className="md3-text-field"
          value={state.inputs}
          onChange={(e) => set("inputs", e.target.value)}
        />
      </label>
      <label className="md3-checkbox-field">
        <input
          type="checkbox"
          className="md3-checkbox"
          checked={state.confidenceGate}
          onChange={(e) => set("confidenceGate", e.target.checked)}
        />
        <span className="md3-label-large">Requires confidence gate</span>
      </label>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">
          Instructions (optional, replaces role and goal for this step)
        </span>
        <textarea
          className="md3-text-field"
          value={state.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </label>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Model (optional)</span>
        <input
          className="md3-text-field"
          value={state.model}
          onChange={(e) => set("model", e.target.value)}
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
          value={state.temperature}
          onChange={(e) => set("temperature", e.target.value)}
        />
      </label>

      <fieldset className="md3-fieldset" aria-label="Output fields">
        <legend className="md3-label-large">Output fields (optional)</legend>
        <p className="md3-field__hint">
          The step then answers with exactly these fields, and later steps can rely on them.
        </p>
        {state.lockedSchema !== undefined ? (
          <p className="md3-field__hint" data-testid="output-schema-locked">
            This output_schema uses parts the form cannot show ({state.lockedBecause.join(", ")}).
            It is kept as written; edit it in the YAML.
          </p>
        ) : (
          <>
            {state.outputFields.map((field, i) => (
              <div
                className="md3-field-row"
                key={i}
                role="group"
                aria-label={`Output field ${i + 1}`}
              >
                <input
                  className="md3-text-field"
                  aria-label={`Output field ${i + 1} name`}
                  placeholder="name"
                  value={field.name}
                  onChange={(e) => setField(i, { name: e.target.value })}
                />
                <select
                  className="md3-text-field"
                  aria-label={`Output field ${i + 1} type`}
                  value={field.type}
                  onChange={(e) => setField(i, { type: e.target.value as OutputFieldType })}
                >
                  {TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  className="md3-text-field"
                  aria-label={`Output field ${i + 1} description`}
                  placeholder="description (optional)"
                  value={field.description ?? ""}
                  onChange={(e) => setField(i, { description: e.target.value })}
                />
                <label className="md3-checkbox-field">
                  <input
                    type="checkbox"
                    className="md3-checkbox"
                    checked={field.required}
                    onChange={(e) => setField(i, { required: e.target.checked })}
                  />
                  <span className="md3-label-large">Required</span>
                </label>
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  aria-label={`Remove output field ${i + 1}`}
                  onClick={() =>
                    set(
                      "outputFields",
                      state.outputFields.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="md3-button md3-button-tonal"
              onClick={() =>
                set("outputFields", [
                  ...state.outputFields,
                  { name: "", type: "string", required: true },
                ])
              }
            >
              Add output field
            </button>
          </>
        )}
      </fieldset>
    </>
  );
}
