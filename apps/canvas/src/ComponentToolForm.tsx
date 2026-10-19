import { PanelError, PanelFooter } from "./Panel";
import { useId, useMemo, useState, type ReactNode } from "react";
import { ComponentTrust, type PinResult } from "./ComponentTrust.js";
import {
  buildComponentToolFromForm,
  buildOpInput,
  mergeWith,
  withToFormValues,
  withToYaml,
  parseWithYaml,
  planOpForm,
  type ComponentCatalogEntry,
  type FormField,
  type FormValue,
  type OutputReferenceOption,
  type Tool,
} from "@kampong/spec";

// KAN-1885: the "Component" tool kind. The fields come from the chosen op's input schema (see
// planOpForm in @kampong/spec), so a new connector needs no canvas code. An op whose schema is outside
// what a form can express falls back to editing `with` as YAML. Secrets are only ever `${ENV}` names.

export interface ComponentToolFormProps {
  /**
   * A component tool to edit (KAM-175). Its component, version and operation are fixed; the inputs, config, secrets,
   * approval and extract start from what it has. When the component is not installed, or an input is not
   * something a field can show, the inputs are edited as YAML instead.
   */
  initial?: Extract<Tool, { action: "component" }>;
  components: ComponentCatalogEntry[];
  /** Problems loading components (a manifest in the wrong place, say), shown so a missing one is explained. */
  problems?: string[];
  /** `{{ step.field }}` references to earlier steps' declared outputs. */
  references?: OutputReferenceOption[];
  /** The kind switcher rendered by ToolForm, so the shell stays in one place. */
  header: ReactNode;
  /** Pins a component (KAN-1901); omitted where the server cannot, and the form points at `kampong lock`. */
  onPin?: (
    use: string,
    allowWiderPermissions: boolean,
    reviewedDigest: string,
  ) => Promise<PinResult>;
  onSubmit: (tool: Tool) => void;
  onCancel: () => void;
}

interface ControlProps {
  id: string;
  "aria-describedby"?: string;
}

// A labelled control. The hint sits beside the label, not inside it, so the control's accessible name
// stays the short label and the hint is announced as its description.
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="md3-field">
      <label htmlFor={id} className="md3-field__label md3-label-large">
        {label}
      </label>
      {children({ id, ...(hint && { "aria-describedby": hintId }) })}
      {hint && (
        <span id={hintId} className="md3-body-medium md3-field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

const refOf = (entry: ComponentCatalogEntry) => `${entry.id}@${entry.version}`;

const EFFECT_HINT = {
  read: "Reads only. Runs without asking.",
  write: "Changes something outside. Runs without asking unless you choose otherwise.",
  destructive: "Destructive. Asks a person to approve each call unless you choose otherwise.",
} as const;

export function ComponentToolForm({
  initial,
  components,
  problems = [],
  references = [],
  header,
  onPin,
  onSubmit,
  onCancel,
}: ComponentToolFormProps) {
  const editing = initial !== undefined;
  const [name, setName] = useState(initial?.name ?? "");
  const [use, setUse] = useState(initial?.use ?? (components[0] ? refOf(components[0]) : ""));
  const entry = components.find((c) => refOf(c) === use);
  const opNames = entry ? Object.keys(entry.ops) : [];
  const [op, setOp] = useState(initial?.op ?? opNames[0] ?? "");
  const opSpec = entry && Object.hasOwn(entry.ops, op) ? entry.ops[op] : undefined;
  const plan = useMemo(() => planOpForm(opSpec?.input), [opSpec]);
  // An edit shows the saved inputs as fields when the op is known and every value fits its field; otherwise as YAML.
  const seeded = useMemo(() => {
    if (!initial) return undefined;
    if (!opSpec) return { reason: "the component is not installed" };
    if (!plan.supported) return { reason: plan.reason ?? "the input is not supported" };
    return withToFormValues(plan, initial.with);
  }, [initial, opSpec, plan]);
  const yamlMode = editing ? seeded !== undefined && "reason" in seeded : !plan.supported;
  const [values, setValues] = useState<Record<string, FormValue>>(
    seeded && "values" in seeded ? seeded.values : {},
  );
  const [yaml, setYaml] = useState(editing && yamlMode ? withToYaml(initial.with) : "");
  const [config, setConfig] = useState<Record<string, string>>(initial?.config ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>(initial?.secrets ?? {});
  const [approval, setApproval] = useState<"default" | "always" | "never">(
    initial?.requires_approval === undefined
      ? "default"
      : initial.requires_approval
        ? "always"
        : "never",
  );
  const [extract, setExtract] = useState(initial?.extract ?? "");
  const [focused, setFocused] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  function chooseComponent(next: string) {
    const picked = components.find((c) => refOf(c) === next);
    setUse(next);
    setOp(Object.keys(picked?.ops ?? {})[0] ?? "");
    setValues({});
    setYaml("");
    setConfig({});
    setSecrets({});
    setFocused(null);
    setErrors([]);
  }

  function chooseOp(next: string) {
    setOp(next);
    setValues({});
    setYaml("");
    setFocused(null);
    setErrors([]);
  }

  function setScalar(key: string, value: string | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function setChild(parent: string, child: string, value: string | boolean) {
    setValues((current) => {
      const existing = current[parent];
      const record = existing !== null && typeof existing === "object" ? existing : {};
      return { ...current, [parent]: { ...record, [child]: value } };
    });
  }

  function insertReference(reference: string) {
    if (focused === null) return;
    const [parent, child] = focused.split("\u0000");
    const read = (value: FormValue | undefined) => (typeof value === "string" ? value : "");
    if (child === undefined) {
      setScalar(parent!, `${read(values[parent!])}${reference}`);
    } else {
      const record = values[parent!];
      const existing =
        record !== null && typeof record === "object"
          ? (record as Record<string, unknown>)[child]
          : "";
      setChild(parent!, child, `${typeof existing === "string" ? existing : ""}${reference}`);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing && (!entry || !opSpec)) {
      setErrors(["Choose a component and an operation."]);
      return;
    }
    let withInput: Record<string, unknown>;
    if (!yamlMode) {
      const built = buildOpInput(plan, values);
      if (built.errors.length > 0) {
        setErrors(built.errors);
        return;
      }
      withInput = initial ? mergeWith(plan, initial, built.input) : built.input;
    } else {
      const parsed = parseWithYaml(yaml);
      if (parsed.value === undefined) {
        setErrors([`Input: ${parsed.error}`]);
        return;
      }
      withInput = parsed.value;
    }
    const missingConfig = (entry?.config ?? [])
      .filter((param) => param.required && (config[param.name] ?? "").trim() === "")
      .map((param) => `${param.name} is required`);
    if (missingConfig.length > 0) {
      setErrors(missingConfig);
      return;
    }
    const result = buildComponentToolFromForm({
      name,
      use,
      op,
      with: withInput,
      config,
      secrets,
      ...(approval !== "default" && { requiresApproval: approval === "always" }),
      extract,
    });
    if (!result.success || !result.tool) {
      setErrors(result.errors ?? ["Invalid tool definition"]);
      return;
    }
    onSubmit(result.tool);
  }

  const track = (key: string) => ({ onFocus: () => setFocused(key) });

  function renderField(field: FormField, parent?: string): ReactNode {
    const key = parent === undefined ? field.name : `${parent}\u0000${field.name}`;
    const current =
      parent === undefined
        ? values[field.name]
        : (() => {
            const record = values[parent];
            return record !== null && typeof record === "object"
              ? (record as Record<string, FormValue>)[field.name]
              : undefined;
          })();
    const text = typeof current === "string" ? current : "";
    const set = (value: string | boolean) =>
      parent === undefined ? setScalar(field.name, value) : setChild(parent, field.name, value);
    const label = field.required ? `${field.label} (required)` : field.label;

    if (field.kind === "boolean") {
      const checked = typeof current === "boolean" ? current : field.default === true;
      return (
        <div key={key} className="md3-checkbox-field">
          <Field label={field.label} hint={field.description}>
            {(control) => (
              <input
                {...control}
                type="checkbox"
                className="md3-checkbox"
                checked={checked}
                onChange={(e) => set(e.target.checked)}
              />
            )}
          </Field>
        </div>
      );
    }
    if (field.kind === "object") {
      return (
        <fieldset key={key} className="md3-field md3-fieldset">
          <legend className="md3-field__label md3-label-large">{label}</legend>
          {field.description && (
            <span className="md3-body-medium md3-field__hint">{field.description}</span>
          )}
          {field.children?.map((child) => renderField(child, field.name))}
        </fieldset>
      );
    }
    if (field.kind === "enum") {
      return (
        <Field key={key} label={label} hint={field.description}>
          {(control) => (
            <select
              {...control}
              className="md3-text-field"
              value={text || (field.default !== undefined ? String(field.default) : "")}
              onChange={(e) => set(e.target.value)}
            >
              {field.default === undefined && (
                <option value="">{field.required ? "Choose one" : "(not set)"}</option>
              )}
              {field.options?.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          )}
        </Field>
      );
    }
    const multi = field.kind === "multiline" || field.kind === "text_list";
    const placeholder =
      field.kind === "text_list"
        ? "One per line"
        : field.default !== undefined
          ? `Default: ${String(field.default)}`
          : undefined;
    return (
      <Field key={key} label={label} hint={field.description}>
        {(control) =>
          multi ? (
            <textarea
              {...control}
              className="md3-text-field"
              rows={field.kind === "text_list" ? 3 : 4}
              placeholder={placeholder}
              value={text}
              onChange={(e) => set(e.target.value)}
              {...track(key)}
            />
          ) : (
            <input
              {...control}
              className="md3-text-field"
              placeholder={placeholder}
              value={text}
              onChange={(e) => set(e.target.value)}
              {...track(key)}
            />
          )
        }
      </Field>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={editing ? "Edit Tool" : "Add Tool"}
      className="md3-form md3-form--fill"
    >
      {header}

      {components.length === 0 && !editing ? (
        <div role="status" className="md3-banner md3-banner--info">
          <p>
            No components are installed. Put one under{" "}
            <code>components/&lt;namespace&gt;/&lt;name&gt;/&lt;version&gt;/</code> next to the
            spec, then reopen this form.
          </p>
          {problems.length > 0 && (
            <ul className="md3-banner__errors">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Name</span>
            <input
              className="md3-text-field"
              value={name}
              disabled={editing}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {/* Keyed on what was reviewed, so consent given for one component or version never carries to another. */}
          {entry && <ComponentTrust key={`${use}:${entry.digest}`} entry={entry} onPin={onPin} />}

          <Field label="Component" hint={entry?.description}>
            {(control) =>
              editing ? (
                <input {...control} className="md3-text-field" value={use} disabled readOnly />
              ) : (
                <select
                  {...control}
                  className="md3-text-field"
                  value={use}
                  onChange={(e) => chooseComponent(e.target.value)}
                >
                  {components.map((c) => (
                    <option key={refOf(c)} value={refOf(c)}>
                      {c.title ? `${c.title} (${refOf(c)})` : refOf(c)}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>

          <Field
            label="Operation"
            hint={
              opSpec
                ? `${opSpec.description ? `${opSpec.description} ` : ""}${EFFECT_HINT[opSpec.effect]}`
                : undefined
            }
          >
            {(control) =>
              editing ? (
                <input {...control} className="md3-text-field" value={op} disabled readOnly />
              ) : (
                <select
                  {...control}
                  className="md3-text-field"
                  value={op}
                  onChange={(e) => chooseOp(e.target.value)}
                >
                  {opNames.map((n) => (
                    <option key={n} value={n}>
                      {entry!.ops[n]!.title ?? n}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>

          {references.length > 0 && !yamlMode && (
            <label className="md3-field">
              <span className="md3-field__label md3-label-large">Insert reference</span>
              <select
                className="md3-text-field"
                value=""
                disabled={focused === null}
                onChange={(e) => {
                  if (e.target.value) insertReference(e.target.value);
                }}
              >
                <option value="">
                  {focused === null ? "Click a field first" : "Earlier step output"}
                </option>
                {references.map((r) => (
                  <option key={r.reference} value={r.reference}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!yamlMode ? (
            plan.fields.map((field) => renderField(field))
          ) : (
            <>
              <div role="note" className="md3-banner md3-banner--info">
                <p>
                  This operation's input is outside what the form can show (
                  {seeded && "reason" in seeded ? seeded.reason : plan.reason}). Enter it as YAML.
                </p>
              </div>
              <label className="md3-field">
                <span className="md3-field__label md3-label-large">Input (YAML)</span>
                <textarea
                  className="md3-text-field md3-code-block"
                  rows={6}
                  placeholder={"name: value\nitems:\n  - a"}
                  value={yaml}
                  onChange={(e) => setYaml(e.target.value)}
                />
              </label>
            </>
          )}

          {entry?.config.map((param) => (
            <Field
              key={param.name}
              label={param.title ?? `Config: ${param.name}`}
              hint={param.description}
            >
              {(control) => (
                <input
                  {...control}
                  className="md3-text-field"
                  placeholder={
                    param.default !== undefined ? `Default: ${param.default}` : undefined
                  }
                  value={config[param.name] ?? ""}
                  onChange={(e) => setConfig((c) => ({ ...c, [param.name]: e.target.value }))}
                />
              )}
            </Field>
          ))}

          {entry?.slots.map((slot) => (
            <label key={slot.name} className="md3-field">
              <span className="md3-field__label md3-label-large">
                Secret: {slot.name} (env reference)
              </span>
              <input
                className="md3-text-field"
                placeholder={`\${${slot.env}}`}
                value={secrets[slot.name] ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, [slot.name]: e.target.value }))}
              />
            </label>
          ))}

          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Approval</span>
            <select
              className="md3-text-field"
              value={approval}
              onChange={(e) => setApproval(e.target.value as typeof approval)}
            >
              <option value="default">Default for this operation</option>
              <option value="always">Always ask a person</option>
              <option value="never">Never ask</option>
            </select>
          </label>

          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Extract field</span>
            <input
              className="md3-text-field"
              value={extract}
              onChange={(e) => setExtract(e.target.value)}
            />
          </label>
        </>
      )}

      <PanelError messages={errors} />
      <PanelFooter
        save="Save tool"
        disabled={components.length === 0 && !editing}
        onCancel={onCancel}
      />
    </form>
  );
}
