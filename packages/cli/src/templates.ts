import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Templates (SLICES.md V11): complete specs a user copies and edits. Each is a folder under
// packages/cli/templates holding `agent.yaml`, a `README.md`, a `template.json` ({ "description": ... })
// and, when the template runs offline, its recorded `fixtures/`. `kampong templates` lists them. Both
// `src/` and `dist/` sit one level under the package, so one relative URL finds the folder from either.

export interface TemplateInfo {
  name: string;
  description: string;
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
    try {
      const meta = JSON.parse(readFileSync(join(path, "template.json"), "utf8")) as {
        description?: unknown;
      };
      if (typeof meta.description === "string") description = meta.description;
    } catch {
      // A template without readable metadata is still listed, with no description.
    }
    out.push({ name: entry.name, description, path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
