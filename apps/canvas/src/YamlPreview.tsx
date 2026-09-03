// The split-screen YAML preview (PLAN.md Affordances). Deliberately a
// light, honest viewer, not a competing IDE -- Cursor/Claude Code/Codex are
// where real editing happens (ADR-0008).

export interface YamlPreviewProps {
  source: string;
}

export function YamlPreview({ source }: YamlPreviewProps) {
  return (
    <div className="md3-yaml-panel">
      <div className="md3-yaml-panel__header">
        <span className="md3-title-small">YAML</span>
      </div>
      <pre data-testid="yaml-preview" className="md3-yaml-panel__body">
        {source}
      </pre>
    </div>
  );
}
