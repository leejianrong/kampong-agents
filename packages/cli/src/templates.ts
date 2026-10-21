import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSteps, parseSpec } from "@kampong/spec";

// Templates (SLICES.md V11): complete specs a user copies and edits. Each is a folder under
// packages/cli/templates holding `agent.yaml`, a `README.md`, a `template.json` ({ "title", "description" }:
// a friendly name and a plain-language description of the job, KAM-216) and, when the template runs offline,
// its recorded `fixtures/`. `kampong templates` lists them, and so does the canvas's template gallery.
// Both `src/` and `dist/` sit one level under the package, so one relative URL finds the folder from either.

export interface TemplateInfo {
  name: string;
  /** A friendly name for the gallery (`title` in template.json); the folder name if it has none. */
  title: string;
  /** What the template does, in plain words. */
  description: string;
  /** The kinds of step it uses, in first-seen order (`action`, `tool`, `foreach`, ...), for the gallery's chips. */
  stepKinds: string[];
  /** It ships recorded fixtures, so it runs in replay with no key and no network. */
  runsOffline: boolean;
  /** The folder to copy. */
  path: string;
}

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates", import.meta.url));

export function listTemplates(dir: string = TEMPLATES_DIR): TemplateInfo[] {
  if (!existsSync(dir)) return [];
  const out: TemplateInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (!existsSync(join(path, "agent.yaml"))) continue;
    let description = "";
    let title = entry.name;
    try {
      const meta = JSON.parse(readFileSync(join(path, "template.json"), "utf8")) as {
        title?: unknown;
        description?: unknown;
      };
      if (typeof meta.description === "string") description = meta.description;
      if (typeof meta.title === "string" && meta.title.trim()) title = meta.title;
    } catch {
      // A template without readable metadata is still listed, with no description.
    }
    out.push({
      name: entry.name,
      title,
      description,
      stepKinds: stepKindsOf(join(path, "agent.yaml")),
      runsOffline: existsSync(join(path, "fixtures")),
      path,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function stepKindsOf(specFile: string): string[] {
  try {
    const { spec } = parseSpec(readFileSync(specFile, "utf8"));
    if (!spec) return [];
    return [...new Set(listSteps(spec).map((s) => s.kind))];
  } catch {
    return [];
  }
}

/** The spec text of a template, ready to save: its schema pragma points at `schemaPath` from the new spec file. */
export function templateSource(info: TemplateInfo, schemaPath: string): string {
  const text = readFileSync(join(info.path, "agent.yaml"), "utf8");
  return text.replace(
    /^# yaml-language-server: \$schema=.*$/m,
    () => `# yaml-language-server: $schema=${schemaPath}`,
  );
}

/**
 * Copies a template's recorded fixtures to `fixturesDir` (where a replay run looks by default), so the copy
 * runs offline from the canvas. Does nothing for a template with none.
 */
export function copyTemplateFixtures(info: TemplateInfo, fixturesDir: string): void {
  const from = join(info.path, "fixtures");
  if (!existsSync(from)) return;
  mkdirSync(fixturesDir, { recursive: true });
  cpSync(from, fixturesDir, { recursive: true });
}
