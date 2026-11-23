import { PanelError, PanelFooter } from "./Panel";
import { describeInterval, formatRun, SchedulePreviewNote } from "./SchedulePreviewNote.js";
import { FieldProblemsContext, useFieldProblems } from "./fieldProblems.js";
import { useState } from "react";
import { VersionGate } from "./VersionGate.js";
import {
  buildTriggerFromForm,
  previewSchedule,
  triggerToFormInput,
  type ExpressionScope,
  type Trigger,
  type TriggerFormInput,
  type ComponentCatalogEntry,
  type TriggerType,
  type WebhookTrigger,
} from "@kampong/spec";
import { goLive } from "./goLive.js";
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
  /** The local server: nothing here fires a trigger by itself (KAM-289). The hosted server runs deployed ones. */
  local?: boolean;
  /** The installed components (KAM-313): a poll's Component and Op are picked from these, and the pair is checked on save. */
  components?: ComponentCatalogEntry[] | undefined;
}

export const DEPLOY_DOC =
  "https://leejianrong.github.io/kampong-agents/reference/cli/#kampong-serve";

const CRON_PRESETS = [
  { cron: "0 9 * * 1-5", label: "Every weekday at 09:00" },
  { cron: "0 9 * * *", label: "Every day at 09:00" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 9 * * 1", label: "Every Monday at 09:00" },
];

export const WEBHOOK_DOC = "https://leejianrong.github.io/kampong-agents/tutorial/webhooks/";

/** The one thing wrong with a poll's component and op against what is installed, or undefined (KAM-313). */
export function pollPairProblem(
  poll: { use: string; op: string },
  components: ComponentCatalogEntry[] | undefined,
): string | undefined {
  if (!components || components.length === 0) return undefined;
  const entry = components.find((c) => `${c.id}@${c.version}` === poll.use);
  if (!entry) {
    return `${poll.use} is not installed here. Installed: ${components.map((c) => `${c.id}@${c.version}`).join(", ")}.`;
  }
  if (!Object.hasOwn(entry.ops, poll.op)) {
    return `${poll.use} has no op "${poll.op}". It has: ${Object.keys(entry.ops).join(", ")}.`;
  }
  return undefined;
}

function GoLiveBlock({ trigger }: { trigger: WebhookTrigger }) {
  const live = goLive(trigger);
  return (
    <section className="md3-trigger__golive" data-testid="trigger-golive">
      <h3 className="md3-title-small">Go live</h3>
      <ol className="md3-body-small">
        <li>
          In a terminal, run <code>{live.command}</code>
          {live.secretEnv && (
            <>
              , with <code>{live.secretEnv}</code> set to a long random value
            </>
          )}
          .
        </li>
        <li>
          Give the sender this address: <code>{live.url}</code>
        </li>
        <li>
          {live.needs ? (
            <>The sender must include {live.needs}.</>
          ) : (
            <>Nothing else is needed: this webhook is open.</>
          )}
        </li>
      </ol>
      {live.curl && (
        <>
          <span className="md3-body-small">To try it yourself:</span>
          <pre className="md3-trigger__curl" data-testid="trigger-curl">
            {live.curl}
          </pre>
        </>
      )}
    </section>
  );
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

/** A schedule as a sentence with its next run (KAM-314): "Runs at 09:00 on weekdays (Asia/Singapore). Next: Tue 24 Nov, 09:00". */
function describeSchedule(
  t: { cron?: string | undefined; every?: string | undefined; tz?: string | undefined },
  now: number,
): string {
  const result = previewSchedule(t, now);
  if (!result.ok) return t.cron !== undefined ? `cron ${t.cron}` : `every ${t.every}`;
  const { preview } = result;
  const first = preview.runs[0];
  const next = first !== undefined ? ` Next: ${formatRun(first, preview.timeZone ?? "UTC")}.` : "";
  if (preview.intervalMs !== undefined) {
    return `Runs ${describeInterval(preview.intervalMs)}.${next}`;
  }
  const zone = t.tz !== undefined ? ` (${t.tz})` : "";
  return preview.description
    ? `Runs ${preview.description}${zone}.${next}`
    : `cron ${t.cron}${zone}.${next}`;
}

function describeTrigger(t: Trigger): string {
  if (t.type === "schedule") return describeSchedule(t, Date.now());
  if (t.type === "poll") return `every ${t.every}: ${t.use} ${t.op}, ${t.dedupe} by ${t.id}`;
  const auth =
    t.preset !== undefined
      ? `${t.preset} preset`
      : t.auth === undefined || t.auth === "none"
        ? "open"
        : (t.auth.type ?? "custom auth");
  return `${auth}, ${t.respond ?? "async"} response`;
}

export function TriggerPanel({
  version,
  trigger,
  onSave,
  onRemove,
  local = false,
  components,
}: TriggerPanelProps) {
  const [form, setForm] = useState<TriggerFormInput | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // What is on screen no longer matches what failed once the person changes it (KAM-194).
  const clearErrors = () => setErrors((current) => (current.length > 0 ? [] : current));
  const [busy, setBusy] = useState(false);
  const fieldProblems = useFieldProblems();
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
    // A field that is already saying what is wrong is not sent to the server to be told again.
    const invalid = fieldProblems.firstInvalid();
    if (invalid) {
      invalid.focus();
      return;
    }
    const result = buildTriggerFromForm(form, version);
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    const wrongPair =
      result.value.type === "poll" ? pollPairProblem(result.value, components) : undefined;
    if (wrongPair) {
      setErrors([wrongPair]);
      return;
    }
    setBusy(true);
    const saved = await onSave(result.value);
    setBusy(false);
    // A failed save is explained by the panel shell, in the server's words and beside the input that was kept (KAM-194).
    if (saved) close();
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

  // KAM-313: with the installed components known, Component and Op are lists to pick from, not words to guess.
  const picked = components?.find(
    (c) => form && `${c.id}@${c.version}` === ((form as { use?: string }).use ?? ""),
  );
  const componentChoice = () => {
    const current = (form as { use?: string } | null)?.use ?? "";
    if (!components || components.length === 0) {
      return text("Component", "use", { placeholder: "kampong/gmail-imap@1.0.0" });
    }
    const ids = components.map((c) => `${c.id}@${c.version}`);
    return choice("Component", "use", [
      ["", "Choose a component"],
      ...ids.map((id): [string, string] => [id, id]),
      ...(current !== "" && !ids.includes(current)
        ? [[current, `${current} (not installed)`] as [string, string]]
        : []),
    ]);
  };
  const opChoice = () => {
    const current = (form as { op?: string } | null)?.op ?? "";
    if (!picked) return text("Op", "op", { placeholder: "list_unseen" });
    const names = Object.keys(picked.ops);
    return choice("Op", "op", [
      ["", "Choose an op"],
      ...names.map((n): [string, string] => [
        n,
        picked.ops[n]?.title ? `${picked.ops[n]!.title} (${n})` : n,
      ]),
      ...(current !== "" && !names.includes(current)
        ? [[current, `${current} (not in this component)`] as [string, string]]
        : []),
    ]);
  };

  return (
    <FieldProblemsContext.Provider value={fieldProblems}>
      <div className="md3-doctor" data-testid="trigger-panel">
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
          <form
            onSubmit={(e) => void submit(e)}
            onChange={clearErrors}
            aria-label="Trigger"
            className="md3-form"
          >
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
                  <>
                    {text("Every", "every", { placeholder: "6h", hint: "30s, 15m, 6h or 1d." })}
                    <SchedulePreviewNote every={form.every ?? ""} />
                  </>
                ) : (
                  <>
                    <label className="md3-field">
                      <span className="md3-body-small md3-field__label">Common schedules</span>
                      <select
                        className="md3-text-field"
                        value={CRON_PRESETS.find((p) => p.cron === form.cron)?.cron ?? ""}
                        onChange={(e) => e.target.value !== "" && patch({ cron: e.target.value })}
                      >
                        <option value="">Pick one, or write your own below</option>
                        {CRON_PRESETS.map((p) => (
                          <option key={p.cron} value={p.cron}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {text("Cron", "cron", {
                      placeholder: "0 9 * * 1-5",
                      hint: "Five fields: minute hour day-of-month month day-of-week.",
                    })}
                    {text("Time zone", "tz", {
                      placeholder: "UTC",
                      hint: "An IANA name such as Asia/Singapore; blank is UTC.",
                    })}
                    <SchedulePreviewNote cron={form.cron ?? ""} tz={form.tz ?? ""} />
                  </>
                )}
                {choice("If the last run is still going", "overlap", [
                  ["skip", "Skip this run (default)"],
                  ["queue", "Run it right after the last one finishes"],
                ])}
              </>
            )}

            {form.type === "poll" && (
              <>
                {text("Every", "every", { placeholder: "15m", hint: "30s, 15m, 6h or 1d." })}
                <SchedulePreviewNote every={form.every ?? ""} />
                {componentChoice()}
                {opChoice()}
                <label className="md3-field">
                  <span className="md3-body-small md3-field__label">Arguments (JSON)</span>
                  <textarea
                    className="md3-text-field"
                    value={form.with ?? ""}
                    spellCheck={false}
                    placeholder='{"mailbox": "INBOX", "limit": 20}'
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
                    placeholder="password: ${GMAIL_APP_PASSWORD}"
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
                  placeholder="messages"
                  onChange={(items) => patch({ items })}
                />
                <ExpressionField
                  label="Item id"
                  value={form.id ?? ""}
                  scope={scoped(ITEM)}
                  placeholder="uid"
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
            <PanelFooter
              save="Save trigger"
              disabled={busy}
              disabledReason="Saving, one moment."
              onCancel={close}
            />
          </form>
        )}

        {trigger === undefined && form === null && (
          <p className="md3-body-medium">This spec has no trigger.</p>
        )}
        {trigger !== undefined && local && (
          <p className="md3-body-small md3-trigger__local" data-testid="trigger-local-note">
            Not running here: while you build, this does not start by itself. It runs only when you
            press Run. To have it run on its own,{" "}
            <a
              href={trigger.type === "webhook" ? WEBHOOK_DOC : DEPLOY_DOC}
              target="_blank"
              rel="noreferrer"
            >
              see how to deploy it
            </a>
            .
          </p>
        )}
        {trigger?.type === "webhook" && local && <GoLiveBlock trigger={trigger} />}
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
      </div>
    </FieldProblemsContext.Provider>
  );
}
