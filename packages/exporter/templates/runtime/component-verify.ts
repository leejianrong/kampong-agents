// Hand-vendored for `kampong export` (KAN-1837): it has no counterpart in the engine. It re-hashes the
// files under components/ the way the engine's directory registry does, so a project can check that the
// code it is about to run is the code that was exported. From here on this file is yours.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** What an export recorded about one component: the digest over its files, and each file's own hash. */
export interface ExpectedComponent {
  /** `id@version`, for messages. */
  ref: string;
  /** `sha256:<hex>` over the component's files. */
  digest: string;
  /** The component's path under components/, `id/version`. */
  path: string;
  /** `sha256` hex by relative file path, used only to say which file changed. */
  files?: Record<string, string>;
}

export class ComponentVerificationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      `The components in this project do not match what was exported:\n  ${problems.join("\n  ")}\n` +
        "Restore them from the original export (or re-export), or review the change and re-export to accept it.",
    );
    this.name = "ComponentVerificationError";
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The digest of a component directory and each file's hash. Mirrors the engine's registry: node_modules and .DS_Store are skipped, symlinks refused. */
export async function hashComponentDirectory(
  dir: string,
): Promise<{ digest: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`${rel} is a symlink`);
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) files[rel] = sha256(await readFile(full));
      else throw new Error(`${rel} is not a regular file`);
    }
  };
  await walk(dir);
  const hash = createHash("sha256");
  for (const rel of Object.keys(files).sort()) hash.update(`${rel}\0${files[rel]}\n`);
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

/** Throws a ComponentVerificationError naming every component, and where known every file, that differs. */
export async function verifyComponents(
  expected: ExpectedComponent[],
  componentsDir: string,
): Promise<void> {
  const problems: string[] = [];
  for (const component of expected) {
    const dir = join(componentsDir, ...component.path.split("/"));
    let actual: Awaited<ReturnType<typeof hashComponentDirectory>>;
    try {
      actual = await hashComponentDirectory(dir);
    } catch (err) {
      problems.push(`${component.ref}: cannot be read (${(err as Error).message})`);
      continue;
    }
    if (actual.digest === component.digest) continue;
    const detail: string[] = [];
    if (component.files) {
      for (const [path, hash] of Object.entries(component.files)) {
        if (!Object.hasOwn(actual.files, path)) detail.push(`${path} is missing`);
        else if (actual.files[path] !== hash) detail.push(`${path} was changed`);
      }
      for (const path of Object.keys(actual.files)) {
        if (!Object.hasOwn(component.files, path)) detail.push(`${path} was added`);
      }
    }
    problems.push(
      `${component.ref}: digest ${actual.digest} is not the exported ${component.digest}` +
        (detail.length > 0 ? ` (${detail.join("; ")})` : ""),
    );
  }
  if (problems.length > 0) throw new ComponentVerificationError(problems);
}
