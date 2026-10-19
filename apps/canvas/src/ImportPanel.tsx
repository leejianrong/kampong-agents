import { PanelError, PanelFooter } from "./Panel";
import { useState } from "react";
import { parseSpec } from "@kampong/spec";
import type { ApplyOpsResponse } from "./api.js";

// Import a spec from a YAML file (KAM-207, ADR-0054). The file is checked here first so a mistake is shown with
// its line number before anything is sent; the server checks it again and is the authority. Nothing is written
// until the file is valid and, when there is already a spec, until the person confirms the replacement.

interface ShownError {
  line?: number;
  message: string;
}

export interface ImportPanelProps {
  /** The spec already has steps or tools, so replacing it needs a confirm. */
  hasContent: boolean;
  /** In the hosted product, where the spec is kept as a document and comments may not survive. */
  hosted: boolean;
  /** Sends the text to the server. */
  replace: (source: string) => Promise<ApplyOpsResponse>;
  /** The import went through; the caller reloads and closes the panel. */
  onImported: () => void;
}

export function ImportPanel({ hasContent, hosted, replace, onImported }: ImportPanelProps) {
  const [file, setFile] = useState<{ name: string; text: string; summary: string } | null>(null);
  const [errors, setErrors] = useState<ShownError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    setFile(null);
    setErrors([]);
    setConfirming(false);
    if (!chosen) return;
    const text = await chosen.text();
    const parsed = parseSpec(text);
    if (!parsed.success || !parsed.spec) {
      setErrors(parsed.errors.map((e) => ({ line: e.line, message: e.message })));
      return;
    }
    const steps = parsed.spec.agent.workflow.length;
    setFile({
      name: chosen.name,
      text,
      summary: `${parsed.spec.agent.name}: ${steps} ${steps === 1 ? "step" : "steps"}, ${
        parsed.spec.agent.tools?.length ?? 0
      } tool${parsed.spec.agent.tools?.length === 1 ? "" : "s"}`,
    });
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    try {
      const result = await replace(file.text);
      if (result.success) {
        onImported();
        return;
      }
      setErrors(
        (result.errors ?? []).map((e) => ({
          line: e.line,
          message: e.code === "stale" ? "The spec changed in the meantime. Try again." : e.message,
        })),
      );
      setConfirming(false);
    } catch (err) {
      setErrors([{ message: err instanceof Error ? err.message : "Could not import the file." }]);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="md3-form">
      <p className="md3-body-small md3-field__hint">
        Choose a YAML file made by Download as file, or written by hand. It is checked first;
        nothing changes until it is valid.
      </p>
      {hosted && (
        <p className="md3-body-small md3-field__hint" role="note">
          Comments in the file may not be kept when the spec is stored here.
        </p>
      )}
      <label className="md3-field">
        <span className="md3-body-small md3-field__label">File</span>
        <input
          type="file"
          accept=".yaml,.yml,text/yaml,text/plain"
          onChange={(e) => void choose(e)}
        />
      </label>

      {errors.length > 0 && (
        <PanelError
          intro="This file cannot be imported. Nothing was changed. Fix these and choose it again:"
          messages={errors.map(
            (e) => `${e.line !== undefined ? `Line ${e.line}: ` : ""}${e.message}`,
          )}
        />
      )}

      {file && !confirming && (
        <>
          <p className="md3-body-small">
            {file.name} is valid ({file.summary}).
          </p>
          <PanelFooter
            save="Import"
            disabled={busy}
            onSave={() => (hasContent ? setConfirming(true) : void run())}
          />
        </>
      )}

      {file && confirming && (
        <div role="group" aria-label="Replace the current spec?">
          <p className="md3-body-small">
            Replace the current spec with {file.name}? The current steps, tools and settings are
            replaced by the ones in the file.
          </p>
          <PanelFooter
            save="Replace the current spec"
            disabled={busy}
            onSave={() => void run()}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}
    </div>
  );
}
