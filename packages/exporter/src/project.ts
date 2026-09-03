import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSpec } from "@kampong/spec";
import { buildPackageJson } from "./package-json.js";
import { buildEnvExample, buildGitignore, buildTsconfig } from "./project-files.js";
import { buildReadme } from "./readme.js";
import { buildEntryPointSource } from "./entry-point.js";
import { readRuntimeFiles } from "./runtime-files.js";

// The exporter's public entry point (PLAN.md Shape S6, SLICES.md V4
// KAN-1114, ADR-0002, docs/adr/0010): `AgentSpec -> standalone Mastra
// TypeScript project`, one-way, never re-imported. Takes an already-
// validated `AgentSpec` (the caller -- `kampong export`, KAN-1115 -- is
// responsible for parsing/validating first, the same way every other
// package in this repo only ever operates on a validated spec) and an
// output directory, and writes every file a runnable, standalone project
// needs. Pure file-writing with no `npm install`/execution step here --
// that's deliberately out of scope for this function so it stays testable
// at the unit layer (KAN-1114's own unit test plan) without needing a real
// npm registry; actually installing and running what this writes is
// KAN-1117's e2e-layer job.

export interface ExportResult {
  outputDir: string;
  /** Every file written, as paths relative to outputDir, sorted. */
  files: string[];
}

export interface ExportProjectOptions {
  /**
   * Overwrite a pre-existing, non-empty `outputDir` instead of refusing.
   * Defaults to `false` -- re-running `kampong export` on the same output
   * directory is exactly the normal workflow the generated README
   * describes (hand-edit the exported project, no sync-back per ADR-0002),
   * so a bare re-export must not silently truncate those hand edits.
   */
  force?: boolean;
}

/**
 * Thrown by `exportProject` when `outputDir` already exists, is non-empty,
 * and the caller didn't opt into `{ force: true }`. Its own error type
 * (rather than a generic `Error`) so a caller like `packages/cli/src/cli.ts`
 * can distinguish "you need --force" from any other write failure (a
 * permissions error, a full disk, ...) and report it with different,
 * more actionable guidance.
 */
export class ExportDirectoryNotEmptyError extends Error {
  constructor(public readonly outputDir: string) {
    super(
      `Output directory "${outputDir}" already exists and is not empty. ` +
        `Pass { force: true } (the CLI: --force) to overwrite it.`,
    );
    this.name = "ExportDirectoryNotEmptyError";
  }
}

export function exportProject(
  spec: AgentSpec,
  outputDir: string,
  options: ExportProjectOptions = {},
): ExportResult {
  if (!options.force && existsSync(outputDir) && readdirSync(outputDir).length > 0) {
    throw new ExportDirectoryNotEmptyError(outputDir);
  }

  const written: string[] = [];

  const write = (relativePath: string, contents: string): void => {
    const fullPath = join(outputDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
    written.push(relativePath);
  };

  write("package.json", `${JSON.stringify(buildPackageJson(spec), null, 2)}\n`);
  write("tsconfig.json", `${JSON.stringify(buildTsconfig(), null, 2)}\n`);
  write("README.md", buildReadme(spec));
  write(".gitignore", buildGitignore());
  write("src/index.ts", buildEntryPointSource(spec));

  const envExample = buildEnvExample(spec);
  if (envExample) write(".env.example", envExample);

  for (const file of readRuntimeFiles()) {
    write(join("src", "runtime", file.name), file.contents);
  }

  return { outputDir, files: written.sort() };
}
