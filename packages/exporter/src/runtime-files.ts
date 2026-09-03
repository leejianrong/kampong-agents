import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Locates and reads the vendored runtime source files this package ships
// alongside its own compiled output (ADR-0010, PLAN.md Shape S6). These
// live in ../templates/runtime relative to this file -- a sibling of `src`
// (and, after build, of `dist`) at the package root, deliberately outside
// this package's own `tsconfig.json` "include" so they're never compiled or
// type-checked as part of *this* package's build (they're plain text
// assets from this package's point of view; the exported project compiles
// them itself). The relative path holds whether this module is running
// from `src/` (vitest, no build step) or `dist/` (the real `kampong`
// binary) because `tsc -b`'s `rootDir: src` / `outDir: dist` preserves this
// file's one-level-deep position in both.

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/runtime", import.meta.url));

export interface RuntimeFile {
  /** Filename within the exported project's src/runtime/ directory. */
  name: string;
  contents: string;
}

/** Reads every vendored runtime file. Throws if the templates directory is missing -- a packaging bug, not a user-facing condition to degrade gracefully from. */
export function readRuntimeFiles(): RuntimeFile[] {
  const names = readdirSync(TEMPLATES_DIR).filter((name) => name.endsWith(".ts"));
  if (names.length === 0) {
    throw new Error(`No vendored runtime files found at ${TEMPLATES_DIR} -- packaging error.`);
  }
  return names
    .map((name) => ({ name, contents: readFileSync(`${TEMPLATES_DIR}/${name}`, "utf8") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
