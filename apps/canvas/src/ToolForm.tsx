import { PanelError, PanelFooter } from "./Panel";
import { useId, useState } from "react";
import {
  buildToolFromForm,
  httpToolToDraft,
  parseKeyValueLines,
  toolNameProblem,
  toolUrlProblem,
  type ComponentCatalogEntry,
  type OutputReferenceOption,
  type RequestBody,
  type Tool,
} from "@kampong/spec";
import { ComponentToolForm } from "./ComponentToolForm.js";
import { InspectorTabs } from "./InspectorTabs.js";
import type { PinResult } from "./ComponentTrust.js";

// The "Add Tool" affordance (PLAN.md Affordances, Q12/R5): a structured
// form, zero LLM calls. Validation/tool-building logic lives in
// @kampong/spec so the canvas and any future headless tooling share it.
//
// KAN-1430 (ADR-0021): tools are now a discriminated union -- the generic
// `http_request` tool plus the Slack/Gmail connectors, whose credential is an
// ${ENV} token (never a literal). The "Tool kind" control picks which shape
// buildToolFromForm builds.

/** How a field is called in the summary line. */
const FIELD_NAMES: Record<string, string> = {
  name: "Name",
  url: "URL",
  token: "Token",
  channel: "Channel",
  text: "Text",
  to: "To",
  subject: "Subject",
  body: "Body",
};

type ToolKind = "http_request" | "slack_post_message" | "gmail_send" | "component";

export interface ToolFormProps {
  /** Which kind a new tool starts as, and for a component which one (KAM-244: a Connectors tile in the palette). */
  start?: { kind: ToolKind; use?: string };
  /**
   * A tool to edit (KAM-175). The form starts from its values, its kind and name are fixed (a rename also has to
   * change the steps that call it), and Save hands back the rebuilt tool for the caller to diff against this one.
   */
  initial?: Tool;
  /**
   * Installed components (KAN-1885). When omitted, which is the case on a server that has none to offer,
   * the Component kind is not shown.
   */
  components?: ComponentCatalogEntry[];
  componentProblems?: string[];
  /** References to earlier steps' declared outputs, offered inside a component form. */
  references?: OutputReferenceOption[];
  /** Pins a component from the form (KAN-1901); omitted where the server cannot. */
  onPinComponent?: (
    use: string,
    allowWiderPermissions: boolean,
    reviewedDigest: string,
  ) => Promise<PinResult>;
  onSubmit: (tool: Tool) => void;
  onCancel: () => void;
}

export function ToolForm({
  start,
  initial,
  components,
  componentProblems,
  references,
  onPinComponent,
  onSubmit,
  onCancel,
}: ToolFormProps) {
  const editing = initial !== undefined;
  const http = initial?.action === "http_request" ? httpToolToDraft(initial) : undefined;
  const slack = initial?.action === "slack_post_message" ? initial : undefined;
  const gmail = initial?.action === "gmail_send" ? initial : undefined;
  const [kind, setKind] = useState<ToolKind>(initial?.action ?? start?.kind ?? "http_request");
  const [name, setName] = useState(initial?.name ?? "");
  const [method, setMethod] = useState(http?.method ?? "GET");
  const [url, setUrl] = useState(http?.url ?? "");
  const [extract, setExtract] = useState(initial?.extract ?? "");
  // KAN-1845: headers and query are one `name: value` / `name=value` per line.
  const [headers, setHeaders] = useState(http?.headers ?? "");
  const [query, setQuery] = useState(http?.query ?? "");
  const [bodyType, setBodyType] = useState<"none" | "json" | "form" | "raw">(
    http?.bodyType ?? "none",
  );
  const [bodyContent, setBodyContent] = useState(http?.bodyContent ?? "");
  const [bodyContentType, setBodyContentType] = useState(http?.bodyContentType ?? "");
  const [responseMode, setResponseMode] = useState<"json" | "text" | "bytes">(
    http?.responseMode ?? "json",
  );
  const [token, setToken] = useState(slack?.token ?? gmail?.token ?? "");
  const [channel, setChannel] = useState(slack?.channel ?? "");
  const [text, setText] = useState(slack?.text ?? "");
  const [to, setTo] = useState(gmail?.to ?? "");
  const [subject, setSubject] = useState(gmail?.subject ?? "");
  const [body, setBody] = useState(gmail?.body ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  // KAM-193: problems by field, shown beside the field. A field's problem goes when it is edited, and a name or URL
  // that cannot work is called out as it is typed.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<{ tab: "setup"; nonce: number }>({ tab: "setup", nonce: 0 });
  const id = useId();
  const liveProblem = (field: string): string | null =>
    field === "name" && !editing && name !== ""
      ? toolNameProblem(name)
      : field === "url" && kind === "http_request" && url !== ""
        ? toolUrlProblem(url)
        : null;
  const problemFor = (field: string) => fieldErrors[field] ?? liveProblem(field);
  const fieldProps = (field: string) =>
    problemFor(field) ? { "aria-invalid": true, "aria-describedby": `${id}-${field}-error` } : {};
  const fieldError = (field: string) => {
    const problem = problemFor(field);
    return problem ? (
      <span
        id={`${id}-${field}-error`}
        role="alert"
        className="md3-body-small md3-field__error"
        data-testid={`tool-error-${field}`}
      >
        Problem: {problem}
      </span>
    ) : null;
  };
  const edit =
    (field: string, set: (value: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setFieldErrors(({ [field]: _gone, ...rest }) => rest);
    };

  function buildBody(): { value?: RequestBody; error?: string } {
    if (bodyType === "none") return {};
    if (bodyType === "json") {
      try {
        const parsed: unknown = JSON.parse(bodyContent);
        if (parsed === null || typeof parsed !== "object") {
          return { error: "Body must be a JSON object or array." };
        }
        return { value: { json: parsed as Record<string, unknown> | unknown[] } };
      } catch {
        return { error: "Body is not valid JSON." };
      }
    }
    if (bodyType === "form") {
      const parsed = parseKeyValueLines(bodyContent, "=");
      if (parsed.errors.length > 0) {
        return { error: `Body ${parsed.errors[0]}` };
      }
      return { value: { form: parsed.values } };
    }
    return {
      value: { raw: bodyContent, ...(bodyContentType && { content_type: bodyContentType }) },
    };
  }

  const kinds: readonly (readonly [ToolKind, string])[] = [
    ["http_request", "HTTP"],
    ["slack_post_message", "Slack"],
    ["gmail_send", "Gmail"],
    ...(components !== undefined ? ([["component", "Component"]] as const) : []),
  ];
  const kindSwitcher = editing ? null : (
    <div className="md3-field">
      <span className="md3-field__label md3-label-large">Tool kind</span>
      <div className="md3-segmented-button" role="group" aria-label="Tool kind">
        {kinds.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            className={
              kind === value
                ? "md3-segmented-button__segment md3-segmented-button__segment--selected"
                : "md3-segmented-button__segment"
            }
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  if (kind === "component" && (components !== undefined || editing)) {
    return (
      <ComponentToolForm
        initial={initial?.action === "component" ? initial : undefined}
        {...(start?.use !== undefined && { initialUse: start.use })}
        // Re-mounted when the installed list changes, so the first selection follows what is there now
        // rather than what was there when the form opened.
        key={(components ?? []).map((c) => `${c.id}@${c.version}`).join(",")}
        components={components ?? []}
        problems={componentProblems}
        references={references}
        header={kindSwitcher}
        onPin={onPinComponent}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    let result;
    if (kind === "slack_post_message") {
      result = buildToolFromForm({
        kind: "slack_post_message",
        name,
        token,
        channel,
        text,
        ...(extract && { extract }),
      });
    } else if (kind === "gmail_send") {
      result = buildToolFromForm({
        kind: "gmail_send",
        name,
        token,
        to,
        subject,
        body,
        ...(extract && { extract }),
      });
    } else {
      const parsedHeaders = parseKeyValueLines(headers, ":");
      const parsedQuery = parseKeyValueLines(query, "=");
      const body = buildBody();
      const problems = [
        ...parsedHeaders.errors.map((e) => `Headers ${e}`),
        ...parsedQuery.errors.map((e) => `Query parameters ${e}`),
        ...(body.error ? [body.error] : []),
      ];
      if (problems.length > 0) {
        setErrors(problems);
        return;
      }
      result = buildToolFromForm({
        name,
        method,
        url,
        headers: parsedHeaders.values,
        query: parsedQuery.values,
        ...(body.value && { body: body.value }),
        ...(responseMode !== "json" && { response: { mode: responseMode } }),
        ...(extract && { extract }),
      });
    }
    if (!result.success || !result.tool) {
      const byField = result.fieldErrors ?? {};
      setFieldErrors(byField);
      // A problem with a field on the form shows beside it (and the Setup tab opens so it is seen); one with no
      // field of its own (a header, the body) is listed in the error box.
      const beside = Object.keys(byField).filter((f) => f in FIELD_NAMES);
      if (beside.length > 0) setReveal((r) => ({ tab: "setup", nonce: r.nonce + 1 }));
      const other = Object.entries(byField)
        .filter(([f]) => !(f in FIELD_NAMES))
        .map(([, message]) => message);
      setErrors(
        Object.keys(byField).length > 0 ? other : (result.errors ?? ["Invalid tool definition"]),
      );
      return;
    }
    setFieldErrors({});
    onSubmit(result.tool);
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label={editing ? "Edit Tool" : "Add Tool"}
      className="md3-form md3-form--fill"
    >
      <InspectorTabs
        show={reveal}
        setup={
          <>
            {kindSwitcher}

            <div className="md3-field">
              <label className="md3-field__label md3-label-large" htmlFor={`${id}-name`}>
                Name
              </label>
              <input
                id={`${id}-name`}
                className="md3-text-field"
                value={name}
                disabled={editing}
                {...fieldProps("name")}
                onChange={edit("name", setName)}
              />
              {fieldError("name")}
            </div>

            {kind === "http_request" && (
              <>
                <label className="md3-field">
                  <span className="md3-field__label md3-label-large">Method</span>
                  <select
                    className="md3-text-field"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option>GET</option>
                    <option>POST</option>
                    <option>PUT</option>
                    <option>PATCH</option>
                    <option>DELETE</option>
                  </select>
                </label>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-url`}>
                    URL
                  </label>
                  <input
                    id={`${id}-url`}
                    className="md3-text-field"
                    value={url}
                    {...fieldProps("url")}
                    onChange={edit("url", setUrl)}
                  />
                  {fieldError("url")}
                </div>
                <label className="md3-field">
                  <span className="md3-field__label md3-label-large">Query parameters</span>
                  <textarea
                    className="md3-text-field"
                    rows={3}
                    placeholder={"symbol={{ input }}\napikey=${ALPHA_KEY}"}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </>
            )}

            {(kind === "slack_post_message" || kind === "gmail_send") && (
              <div className="md3-field">
                <label className="md3-field__label md3-label-large" htmlFor={`${id}-token`}>
                  Token (env reference)
                </label>
                <input
                  id={`${id}-token`}
                  className="md3-text-field"
                  placeholder="${SLACK_BOT_TOKEN}"
                  value={token}
                  {...fieldProps("token")}
                  onChange={edit("token", setToken)}
                />
                {fieldError("token")}
              </div>
            )}

            {kind === "slack_post_message" && (
              <>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-channel`}>
                    Channel
                  </label>
                  <input
                    id={`${id}-channel`}
                    className="md3-text-field"
                    placeholder="#support"
                    value={channel}
                    {...fieldProps("channel")}
                    onChange={edit("channel", setChannel)}
                  />
                  {fieldError("channel")}
                </div>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-text`}>
                    Text
                  </label>
                  <input
                    id={`${id}-text`}
                    className="md3-text-field"
                    placeholder="{{ draft.text }}"
                    value={text}
                    {...fieldProps("text")}
                    onChange={edit("text", setText)}
                  />
                  {fieldError("text")}
                </div>
              </>
            )}

            {kind === "gmail_send" && (
              <>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-to`}>
                    To
                  </label>
                  <input
                    id={`${id}-to`}
                    className="md3-text-field"
                    value={to}
                    {...fieldProps("to")}
                    onChange={edit("to", setTo)}
                  />
                  {fieldError("to")}
                </div>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-subject`}>
                    Subject
                  </label>
                  <input
                    id={`${id}-subject`}
                    className="md3-text-field"
                    value={subject}
                    {...fieldProps("subject")}
                    onChange={edit("subject", setSubject)}
                  />
                  {fieldError("subject")}
                </div>
                <div className="md3-field">
                  <label className="md3-field__label md3-label-large" htmlFor={`${id}-body`}>
                    Body
                  </label>
                  <input
                    id={`${id}-body`}
                    className="md3-text-field"
                    placeholder="{{ draft.text }}"
                    value={body}
                    {...fieldProps("body")}
                    onChange={edit("body", setBody)}
                  />
                  {fieldError("body")}
                </div>
              </>
            )}
          </>
        }
        settings={
          <>
            {kind === "http_request" && (
              <>
                <label className="md3-field">
                  <span className="md3-field__label md3-label-large">Headers</span>
                  <textarea
                    className="md3-text-field"
                    rows={3}
                    placeholder={"Authorization: Bearer ${API_TOKEN}\nAccept: application/json"}
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                  />
                </label>
                <div className="md3-field">
                  <label htmlFor="tool-body-type" className="md3-field__label md3-label-large">
                    Body
                  </label>
                  <select
                    id="tool-body-type"
                    className="md3-text-field"
                    value={bodyType}
                    onChange={(e) => setBodyType(e.target.value as typeof bodyType)}
                  >
                    <option value="none">None</option>
                    <option value="json">JSON</option>
                    <option value="form">Form (name=value lines)</option>
                    <option value="raw">Raw text</option>
                  </select>
                </div>
                {bodyType !== "none" && (
                  <label className="md3-field">
                    <span className="md3-field__label md3-label-large">Body content</span>
                    <textarea
                      className="md3-text-field"
                      rows={4}
                      value={bodyContent}
                      onChange={(e) => setBodyContent(e.target.value)}
                    />
                  </label>
                )}
                {bodyType === "raw" && (
                  <label className="md3-field">
                    <span className="md3-field__label md3-label-large">Content type</span>
                    <input
                      className="md3-text-field"
                      placeholder="text/plain"
                      value={bodyContentType}
                      onChange={(e) => setBodyContentType(e.target.value)}
                    />
                  </label>
                )}
                <div className="md3-field">
                  <label htmlFor="tool-response-mode" className="md3-field__label md3-label-large">
                    Response
                  </label>
                  <select
                    id="tool-response-mode"
                    className="md3-text-field"
                    value={responseMode}
                    onChange={(e) => setResponseMode(e.target.value as typeof responseMode)}
                  >
                    <option value="json">JSON</option>
                    <option value="text">Text</option>
                    <option value="bytes">Bytes (base64)</option>
                  </select>
                </div>
              </>
            )}
            <label className="md3-field">
              <span className="md3-field__label md3-label-large">
                Use only this part of the answer (extract field)
              </span>
              <input
                className="md3-text-field"
                value={extract}
                onChange={(e) => setExtract(e.target.value)}
              />
            </label>
          </>
        }
      />

      <PanelError messages={errors} />
      <PanelFooter save="Save tool" onCancel={onCancel} />
    </form>
  );
}
