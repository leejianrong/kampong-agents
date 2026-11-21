import { useState } from "react";

// ADR-0063 / KAM-271: a step's input or output as labelled fields a person can scan, instead of a JSON dump.
// "View as JSON" and Copy stay one click away for the engineer.

const MAX_ITEMS = 12;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Nothing worth showing: no value, an empty string, or only empty values. */
export function isEmptyData(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every(isEmptyData);
  return false;
}

export function asJson(value: unknown): string {
  return value === undefined ? "" : (JSON.stringify(value, null, 2) ?? String(value));
}

function Value({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined || value === "") {
    return <span className="md3-fields__empty">empty</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "yes" : "no"}</span>;
  if (typeof value !== "object") return <span className="md3-fields__text">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) {
      return (
        <ul className="md3-fields__list">
          {value.slice(0, MAX_ITEMS).map((v, i) => (
            <li key={i}>
              <Value value={v} depth={depth + 1} />
            </li>
          ))}
          {value.length > MAX_ITEMS && (
            <li className="md3-fields__empty">and {value.length - MAX_ITEMS} more</li>
          )}
        </ul>
      );
    }
    return (
      <ol className="md3-fields__list md3-fields__list--items">
        {value.slice(0, MAX_ITEMS).map((v, i) => (
          <li key={i}>
            <Value value={v} depth={depth + 1} />
          </li>
        ))}
        {value.length > MAX_ITEMS && (
          <li className="md3-fields__empty">and {value.length - MAX_ITEMS} more</li>
        )}
      </ol>
    );
  }
  return <Fields value={value as Record<string, unknown>} depth={depth + 1} />;
}

function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="md3-fields__empty">empty</span>;
  return (
    <dl className={`md3-fields${depth > 0 ? " md3-fields--nested" : ""}`}>
      {entries.map(([key, v]) => (
        <div key={key} className="md3-fields__row">
          <dt className="md3-label-medium">{key}</dt>
          <dd>
            <Value value={v} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DataFields({ value, testId }: { value: unknown; testId: string }) {
  const [asText, setAsText] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = asJson(value);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (an insecure page, a locked-down browser): the JSON view is still there to select.
    }
  }
  return (
    <div className="md3-datafields" data-testid={testId}>
      <div className="md3-datafields__bar">
        <button
          type="button"
          className="md3-button md3-button-text"
          aria-pressed={asText}
          onClick={() => setAsText((v) => !v)}
        >
          {asText ? "View as fields" : "View as JSON"}
        </button>
        <button type="button" className="md3-button md3-button-text" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {asText ? (
        <pre className="md3-code-block">{json}</pre>
      ) : isRecord(value) ? (
        <Fields value={value} depth={0} />
      ) : (
        <Value value={value} depth={0} />
      )}
    </div>
  );
}
