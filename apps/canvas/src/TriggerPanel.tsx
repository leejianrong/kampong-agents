import { PanelError, PanelFooter } from "./Panel";
import { useState } from "react";
import { VersionGate } from "./VersionGate.js";
import {
  buildTriggerFromForm,
  triggerToFormInput,
  type ExpressionScope,
  type Trigger,
  type TriggerFormInput,
  type TriggerType,
} from "@kampong/spec";
import { ExpressionField } from "./ExpressionField.js";

// The workflow's trigger (KAM-161, a slice of KAM-110): how a deployed run starts, as `agent.trigger`. The form
// logic lives in packages/spec (buildTriggerFromForm), which applies the loader's own rules, so a trigger built
// here always loads; this collects the text and sends the result as a patch. A secret is never typed in: a
// webhook names the environment variable that holds it, and a poll's secrets are `${ENV}` placeholders.

export interface TriggerPanelProps {
  version: string;
  trigger: Trigger | undefined;
  /** Saves the trigger. Resolves false when the save failed, so the form stays open with its input. */
  onSave: (value: Trigger) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}

const KIND_LABEL: Record<TriggerType, string> = {
  webhook: "Webhook",
  schedule: "Schedule",
  poll: "Poll",
};

// `when` and `map` run as a request arrives and read only `trigger`; a poll's `items` and `id` read the op's own
// result. Neither has the spec's steps or vars to check, so each gets its own kind of scope.
const INGRESS: ExpressionScope = { vars: [], steps: [], trigger: [], kind: "ingress" };
const ITEM: ExpressionScope = { vars: [], steps: [], trigger: [], kind: "item" };

function describeTrigger(t: Trigger): string {
  if (t.type === "schedule") return t.cron !== undefined ? `cron ${t.cron}` : `every ${t.every}`;
  if (t.type === "poll") return `every ${t.every}: ${t.use} ${t.op}, ${t.dedupe} by ${t.id}`;
  const auth =
    t.preset !== undefined
      ? `${t.preset} preset`
      : t.auth === undefined || t.auth === "none"
        ? "open"
        : (t.auth.type ?? "custom auth");
  return `${auth}, ${t.respond ?? "async"} response`;
}

export function TriggerPanel({ version, trigger, onSave, onRemove }: TriggerPanelProps) {
  const [form, setForm] = useState<TriggerFormInput | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const modern = version === "1.1";
  const scoped = (scope: ExpressionScope) => (modern ? scope : undefined);

  const close = () => {
    setForm(null);
    setErrors([]);
  };
  const patch = (change: Partial<TriggerFormInput>) =>
    setForm((f) => (f ? ({ ...f, ...change } as TriggerFormInput) : f));
  const open = (type: TriggerType) => {
    setErrors([]);
    setForm({
      type,
      ...(type === "schedule" && { schedule: "cron" as const }),
      ...(type === "poll" && { dedupe: "unique" as const }),
    });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    const result = buildTriggerFromForm(form, version);
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    setBusy(true);
    const saved = await onSave(result.value);
    setBusy(false);
    if (saved) close();
    else setErrors(["Could not save the change. Your input is kept; try again."]);
  }

  async function remove() {
    setBusy(true);
    await onRemove();
    setBusy(false);
  }

  const text = (
    label: string,
    key: keyof TriggerFormInput,
    extra: { hint?: string; placeholder?: string } = {},
  ) => (
    <label className="md3-field">
      <span className="md3-body-small md3-field__label">{label}</span>
      <input
        className="md3-text-field"
        value={(form?.[key] as string | undefined) ?? ""}
        placeholder={extra.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => patch({ [key]: e.target.value })}
      />
      {extra.hint && <span className="md3-body-small md3-field__hint">{extra.hint}</span>}
    </label>
  );
  const choice = (label: string, key: keyof TriggerFormInput, options: [string, string][]) => (
    <label className="md3-field">
      <span className="md3-body-small md3-field__label">{label}</span>
      <select
        className="md3-text-field"
        value={(form?.[key] as string | undefined) ?? options[0]![0]}
        onChange={(e) => patch({ [key]: e.target.value })}
      >
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="md3-doctor" aria-label="Trigger" data-testid="trigger-panel">
      <div className="md3-doctor__head">
        {(["webhook", "schedule", "poll"] as const).map((type) => (
          <button
            key={type}
            type="button"
            className="md3-button md3-button-tonal"
            disabled={busy || form !== null || (type !== "webhook" && !modern)}
            onClick={() => open(type)}
          >
            {trigger === undefined ? `Add ${type}` : `Use ${type}`}
          </button>
        ))}
      </div>
      <p className="md3-body-small md3-field__hint">
        How a deployed run starts, while <code>kampong serve</code> is up. A spec with no trigger
        still runs with <code>kampong run</code> and Test Run.
      </p>
      {!modern && (
        <VersionGate what="Schedule and poll triggers, and a webhook's auth, filter, map and response mode" />
      )}

      {form && (
        <form onSubmit={(e) => void submit(e)} aria-label="Trigger" className="md3-form">
          <span className="md3-title-small">{KIND_LABEL[form.type]}</span>

          {form.type === "webhook" && (
            <>
              {choice("Response", "respond", [
                ["async", "Answer with a run id (async)"],
                ["sync", "Wait and answer with the output (sync)"],
              ])}
              {form.respond === "sync" &&
                text("Timeout (ms)", "timeout_ms", { placeholder: "30000" })}
              {choice("Preset", "preset", [
                ["", "None"],
                ["github", "GitHub"],
                ["slack", "Slack"],
                ["alertmanager", "Alertmanager"],
                ["generic", "Generic signed body"],
              ])}
              {choice("Authentication", "auth", [
                ["", form.preset ? "From the preset" : "Open (no check)"],
                ["none", "None, explicitly"],
                ["bearer", "Bearer token"],
                ["hmac", "HMAC signature"],
              ])}
              {form.auth !== "none" && (form.auth || form.preset) && (
                <>
                  {text("Secret variable name", "secret_env", {
                    placeholder: "GITHUB_WEBHOOK_SECRET",
                    hint: "The name of the environment variable that holds the secret, never the secret itself.",
                  })}
                </>
              )}
              {form.auth === "hmac" && (
                <>
                  {text("Signature header", "header", { placeholder: "x-hub-signature-256" })}
                  {choice("Algorithm", "algo", [
                    ["", "sha256 (default)"],
                    ["sha256", "sha256"],
                    ["sha1", "sha1"],
                  ])}
                  {choice("Encoding", "encoding", [
                    ["", "hex (default)"],
                    ["hex", "hex"],
                    ["base64", "base64"],
                  ])}
                  {text("Prefix", "prefix", { placeholder: "sha256=" })}
                  {text("Timestamp header", "timestamp_header", { placeholder: "x-timestamp" })}
                  {text("Window (seconds)", "window_s", { placeholder: "300" })}
                  {text("Signed text", "payload", { placeholder: "{timestamp}.{body}" })}
                </>
              )}
              <ExpressionField
                label="When"
                value={form.when ?? ""}
                scope={scoped(INGRESS)}
                placeholder='trigger.headers.`x-github-event` = "push"'
                onChange={(when) => patch({ when })}
              />
              <ExpressionField
                label="Map (name: expression, one per line)"
                value={form.map ?? ""}
                scope={scoped(INGRESS)}
                lines
                placeholder="repo: trigger.repository.full_name"
                onChange={(map) => patch({ map })}
              />
            </>
          )}

          {form.type === "schedule" && (
            <>
              {choice("Runs", "schedule", [
                ["cron", "On a cron schedule"],
                ["every", "At an interval"],
              ])}
              {form.schedule === "every" ? (
                text("Every", "every", { placeholder: "6h", hint: "30s, 15m, 6h or 1d." })
              ) : (
                <>
                  {text("Cron", "cron", { placeholder: "0 9 * * 1-5", hint: "Five fields." })}
                  {text("Time zone", "tz", {
                    placeholder: "UTC",
                    hint: "An IANA name; blank is UTC.",
                  })}
                </>
              )}
              {choice("If the last run is still going", "overlap", [
                ["", "Skip the tick (default)"],
                ["skip", "Skip the tick"],
                ["queue", "Queue one"],
              ])}
            </>
          )}

          {form.type === "poll" && (
            <>
              {text("Every", "every", { placeholder: "15m", hint: "30s, 15m, 6h or 1d." })}
              {text("Component", "use", { placeholder: "kampong/github@1.0.0" })}
              {text("Op", "op", { placeholder: "list_issues" })}
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">Arguments (JSON)</span>
                <textarea
                  className="md3-text-field"
                  value={form.with ?? ""}
                  spellCheck={false}
                  placeholder='{"repo": "owner/name"}'
                  onChange={(e) => patch({ with: e.target.value })}
                />
              </label>
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">
                  Config (name: value, one per line)
                </span>
                <textarea
                  className="md3-text-field"
                  value={form.config ?? ""}
                  spellCheck={false}
                  onChange={(e) => patch({ config: e.target.value })}
                />
              </label>
              <label className="md3-field">
                <span className="md3-body-small md3-field__label">
                  Secrets (name: ${"{ENV_VAR}"}, one per line)
                </span>
                <textarea
                  className="md3-text-field"
                  value={form.secrets ?? ""}
                  spellCheck={false}
                  placeholder="token: ${GITHUB_TOKEN}"
                  onChange={(e) => patch({ secrets: e.target.value })}
                />
                <span className="md3-body-small md3-field__hint">
                  Each value is a placeholder for an environment variable, never the secret.
                </span>
              </label>
              <ExpressionField
                label="Items"
                value={form.items ?? ""}
                scope={scoped(ITEM)}
                placeholder="issues"
                onChange={(items) => patch({ items })}
              />
              <ExpressionField
                label="Item id"
                value={form.id ?? ""}
                scope={scoped(ITEM)}
                placeholder="number"
                onChange={(id) => patch({ id })}
              />
              {choice("New means", "dedupe", [
                ["unique", "Never seen before (unique)"],
                ["time_window", "Not seen within a window"],
                ["greatest", "Above the highest id so far"],
                ["last", "After the previous poll's last item"],
              ])}
              {form.dedupe === "time_window" && text("Window", "window", { placeholder: "24h" })}
              <label className="md3-field md3-field--inline">
                <input
                  type="checkbox"
                  checked={form.one_run_per_item !== false}
                  onChange={(e) => patch({ one_run_per_item: e.target.checked })}
                />
                <span className="md3-body-medium">Start one run per new item</span>
              </label>
            </>
          )}

          <PanelError messages={errors} />
          <PanelFooter save="Save trigger" disabled={busy} onCancel={close} />
        </form>
      )}

      {trigger === undefined && form === null && (
        <p className="md3-body-medium">This spec has no trigger.</p>
      )}
      {trigger !== undefined && (
        <ul className="md3-doctor__list" data-testid="trigger-summary">
          <li className="md3-secrets__row">
            <span className="md3-vars__name">
              <span className="md3-body-medium">{KIND_LABEL[trigger.type]}</span>
              <span className="md3-body-small md3-field__hint">{describeTrigger(trigger)}</span>
            </span>
            <span className="md3-secrets__actions">
              <button
                type="button"
                className="md3-button md3-button-text"
                disabled={busy || form !== null}
                aria-label="Edit trigger"
                onClick={() => {
                  setErrors([]);
                  setForm(triggerToFormInput(trigger));
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="md3-button md3-button-text"
                disabled={busy || form !== null}
                aria-label="Remove trigger"
                onClick={() => void remove()}
              >
                Remove
              </button>
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}
