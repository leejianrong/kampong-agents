// The yaml-language-server pragma convention (ADR-0008): VS Code/Cursor's
// YAML tooling reads a leading `# yaml-language-server: $schema=<path>`
// comment to validate/autocomplete a file against a JSON Schema, with no
// project configuration needed on the editor's side.

const PRAGMA_PATTERN = /^# yaml-language-server: \$schema=(\S+)\s*$/m;

export function buildPragmaLine(schemaPath: string): string {
  return `# yaml-language-server: $schema=${schemaPath}`;
}

export function hasPragma(source: string): boolean {
  return PRAGMA_PATTERN.test(source);
}

export function ensurePragma(source: string, schemaPath: string): string {
  const line = buildPragmaLine(schemaPath);
  if (PRAGMA_PATTERN.test(source)) {
    return source.replace(PRAGMA_PATTERN, line);
  }
  return source.length > 0 ? `${line}\n${source}` : `${line}\n`;
}
