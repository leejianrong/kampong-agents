import { useState } from "react";
import {
  buildToolFromForm,
  parseKeyValueLines,
  type ComponentCatalogEntry,
  type OutputReferenceOption,
  type RequestBody,
  type Tool,
} from "@kampong/spec";
import { ComponentToolForm } from "./ComponentToolForm.js";
import type { PinResult } from "./ComponentTrust.js";

// The "Add Tool" affordance (PLAN.md Affordances, Q12/R5): a structured
// form, zero LLM calls. Validation/tool-building logic lives in
// @kampong/spec so the canvas and any future headless tooling share it.
//
// KAN-1430 (ADR-0021): tools are now a discriminated union -- the generic
// `http_request` tool plus the Slack/Gmail connectors, whose credential is an
// ${ENV} token (never a literal). The "Tool kind" control picks which shape
// buildToolFromForm builds.

type ToolKind = "http_request" | "slack_post_message" | "gmail_send" | "component";

export interface ToolFormProps {
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
  components,
  componentProblems,
  references,
  onPinComponent,
  onSubmit,
  onCancel,
}: ToolFormProps) {
  const [kind, setKind] = useState<ToolKind>("http_request");
  const [name, setName] = useState("");
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [extract, setExtract] = useState("");
  // KAN-1845: headers and query are one `name: value` / `name=value` per line.
  const [headers, setHeaders] = useState("");
  const [query, setQuery] = useState("");
  const [bodyType, setBodyType] = useState<"none" | "json" | "form" | "raw">("none");
  const [bodyContent, setBodyContent] = useState("");
  const [bodyContentType, setBodyContentType] = useState("");
  const [responseMode, setResponseMode] = useState<"json" | "text" | "bytes">("json");
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("");
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

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
  const kindSwitcher = (
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

  if (kind === "component" && components !== undefined) {
    return (
      <ComponentToolForm
        // Re-mounted when the installed list changes, so the first selection follows what is there now
        // rather than what was there when the form opened.
        key={components.map((c) => `${c.id}@${c.version}`).join(",")}
        components={components}
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
      setErrors(result.errors ?? ["Invalid tool definition"]);
      return;
    }
    onSubmit(result.tool);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add Tool" className="md3-card md3-form">
      <h2 className="md3-title-medium">Add Tool</h2>

      {kindSwitcher}

      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Name</span>
        <input className="md3-text-field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

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
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">URL</span>
            <input
              className="md3-text-field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
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

      {(kind === "slack_post_message" || kind === "gmail_send") && (
        <label className="md3-field">
          <span className="md3-field__label md3-label-large">Token (env reference)</span>
          <input
            className="md3-text-field"
            placeholder="${SLACK_BOT_TOKEN}"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      )}

      {kind === "slack_post_message" && (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Channel</span>
            <input
              className="md3-text-field"
              placeholder="#support"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Text</span>
            <input
              className="md3-text-field"
              placeholder="{{ draft.text }}"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        </>
      )}

      {kind === "gmail_send" && (
        <>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">To</span>
            <input className="md3-text-field" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Subject</span>
            <input
              className="md3-text-field"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="md3-field">
            <span className="md3-field__label md3-label-large">Body</span>
            <input
              className="md3-text-field"
              placeholder="{{ draft.text }}"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </>
      )}

      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Extract field</span>
        <input
          className="md3-text-field"
          value={extract}
          onChange={(e) => setExtract(e.target.value)}
        />
      </label>

      {errors.length > 0 && (
        <ul role="alert" className="md3-error-list">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="md3-form-actions">
        <button type="submit" className="md3-button md3-button-filled">
          Save Tool
        </button>
        <button type="button" className="md3-button md3-button-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
