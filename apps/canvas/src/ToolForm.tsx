import { useState } from "react";
import { buildToolFromForm, type Tool } from "@kampong/spec";

// The "Add Tool" affordance (PLAN.md Affordances, Q12/R5): a structured
// form, zero LLM calls. Validation/tool-building logic lives in
// @kampong/spec so the canvas and any future headless tooling share it.

export interface ToolFormProps {
  onSubmit: (tool: Tool) => void;
  onCancel: () => void;
}

export function ToolForm({ onSubmit, onCancel }: ToolFormProps) {
  const [name, setName] = useState("");
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [extract, setExtract] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = buildToolFromForm({
      name,
      method,
      url,
      ...(extract && { extract }),
    });
    if (!result.success || !result.tool) {
      setErrors(result.errors ?? ["Invalid tool definition"]);
      return;
    }
    onSubmit(result.tool);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add Tool" className="md3-card md3-form">
      <h2 className="md3-title-medium">Add Tool</h2>
      <label className="md3-field">
        <span className="md3-field__label md3-label-large">Name</span>
        <input className="md3-text-field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
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
        <input className="md3-text-field" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
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
