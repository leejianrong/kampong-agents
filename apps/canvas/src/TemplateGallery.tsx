import { useState } from "react";
import type { TemplateSummary } from "./api.js";
import { KIND_HELP, type StepKind } from "./stepKinds.js";

// The template gallery (KAM-216): the ready-made workflows `kampong templates` lists, as cards with a friendly
// title, what the job does in plain words, the kinds of step it uses and a badge when it runs on recorded data
// (no key). It sits in the empty state and in a panel opened from the menu. Choosing one saves it as the
// workflow; when there is already content, the panel asks before replacing it.

export interface TemplateGalleryProps {
  templates: TemplateSummary[];
  /** Saves the template (replacing the current workflow when `replace` is set). */
  onChoose: (name: string) => void;
  /** The workflow has content, so choosing a template asks for a confirm first. */
  confirmReplace?: boolean;
  busy?: boolean;
}

function kindLabel(kind: string): string {
  return (KIND_HELP as Record<string, { label: string }>)[kind]?.label ?? kind;
}

export function TemplateGallery({
  templates,
  onChoose,
  confirmReplace = false,
  busy = false,
}: TemplateGalleryProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <ul className="md3-template-list" data-testid="template-gallery">
      {templates.map((t) => (
        <li key={t.name} className="md3-template-card" data-testid={`template-${t.name}`}>
          <h4 className="md3-title-small">{t.title}</h4>
          <p className="md3-body-small">{t.description}</p>
          <div className="md3-template-card__chips">
            {t.runsOffline && (
              <span
                className="md3-chip md3-chip--offline"
                data-testid={`template-${t.name}-offline`}
              >
                Runs offline
              </span>
            )}
            {t.stepKinds.map((k) => (
              <span key={k} className="md3-chip">
                {kindLabel(k as StepKind)}
              </span>
            ))}
          </div>
          {confirming === t.name ? (
            <div className="md3-template-card__confirm" role="group" aria-label="Confirm replace">
              <p className="md3-body-small">
                This replaces your current workflow. Export it first if you want to keep it.
              </p>
              <div className="md3-form-actions">
                <button
                  type="button"
                  className="md3-button md3-button-filled"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    onChoose(t.name);
                  }}
                  data-testid={`template-${t.name}-confirm`}
                >
                  Replace
                </button>
                <button
                  type="button"
                  className="md3-button md3-button-text"
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="md3-form-actions">
              <button
                type="button"
                className="md3-button md3-button-tonal"
                disabled={busy}
                onClick={() => (confirmReplace ? setConfirming(t.name) : onChoose(t.name))}
                data-testid={`template-${t.name}-use`}
                aria-label={`Use ${t.title}`}
              >
                Use this template
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
