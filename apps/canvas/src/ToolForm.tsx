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
    <form onSubmit={handleSubmit} aria-label="Add Tool">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Method
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option>GET</option>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
          <option>DELETE</option>
        </select>
      </label>
      <label>
        URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Extract field
        <input value={extract} onChange={(e) => setExtract(e.target.value)} />
      </label>
      {errors.length > 0 && (
        <ul role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <button type="submit">Save Tool</button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
