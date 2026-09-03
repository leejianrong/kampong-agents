// The split-screen YAML preview (PLAN.md Affordances). Deliberately a
// light, honest viewer, not a competing IDE -- Cursor/Claude Code/Codex are
// where real editing happens (ADR-0008).

export interface YamlPreviewProps {
  source: string;
}

export function YamlPreview({ source }: YamlPreviewProps) {
  return (
    <pre
      data-testid="yaml-preview"
      style={{
        margin: 0,
        padding: "1rem",
        height: "100%",
        overflow: "auto",
        fontFamily: "monospace",
        fontSize: "0.85rem",
        whiteSpace: "pre-wrap",
      }}
    >
      {source}
    </pre>
  );
}
