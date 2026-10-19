// The split-screen YAML preview (PLAN.md Affordances). Deliberately a
// light, honest viewer, not a competing IDE -- Cursor/Claude Code/Codex are
// where real editing happens (ADR-0008). The YAML is the interchange format (ADR-0054), so its header
// carries the two quiet actions for taking a spec out and bringing one in (KAM-207).

export interface YamlPreviewProps {
  source: string;
  /** Saves the spec as a YAML file. Omitted: no Download button. */
  onDownload?: () => void;
  /** Opens the import panel. Omitted: no Import button. */
  onImport?: () => void;
}

export function YamlPreview({ source, onDownload, onImport }: YamlPreviewProps) {
  return (
    <div className="md3-yaml-panel">
      <div className="md3-yaml-panel__header">
        <span className="md3-title-small">YAML</span>
        {(onDownload || onImport) && (
          <span className="md3-yaml-panel__actions">
            {onDownload && (
              <button type="button" className="md3-button md3-button-text" onClick={onDownload}>
                Download as file
              </button>
            )}
            {onImport && (
              <button type="button" className="md3-button md3-button-text" onClick={onImport}>
                Import from file
              </button>
            )}
          </span>
        )}
      </div>
      <pre data-testid="yaml-preview" className="md3-yaml-panel__body">
        {source}
      </pre>
    </div>
  );
}
