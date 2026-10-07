import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSpec } from "@kampong/spec";
import { buildPackageJson } from "./package-json.js";
import { buildEnvExample, buildGitignore, buildTsconfig } from "./project-files.js";
import { buildReadme } from "./readme.js";
import { buildEntryPointSource } from "./entry-point.js";
import { buildServerEntryPointSource } from "./server-entry-point.js";
import { buildDockerfile, buildDockerignore } from "./dockerfile.js";
import { buildLockfileText, buildSbom, buildVerifyEntryPointSource } from "./sbom.js";
import { buildComponentsModule, selectComponents, type ExportComponent } from "./components.js";
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
  /**
   * The components the spec uses (its component tools and the first-party ones behind the legacy Slack
   * and Gmail tools), resolved by the caller. The export copies their files and bakes their manifests
   * in. Anything the spec needs and this lacks is an `ExportMissingComponentsError`.
   */
  components?: ExportComponent[];
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
  // Checked first so nothing is written: a project that fails on its first tool call is worse than a
  // refused export.
  const components = selectComponents(spec, options.components);
  if (!options.force && existsSync(outputDir) && readdirSync(outputDir).length > 0) {
    throw new ExportDirectoryNotEmptyError(outputDir);
  }

  const written: string[] = [];

  const writeBytes = (relativePath: string, contents: string | Uint8Array): void => {
    const fullPath = join(outputDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
    written.push(relativePath);
  };
  const write = (relativePath: string, contents: string): void =>
    writeBytes(relativePath, contents);

  write("package.json", `${JSON.stringify(buildPackageJson(spec, components), null, 2)}\n`);
  write("tsconfig.json", `${JSON.stringify(buildTsconfig(), null, 2)}\n`);
  write("README.md", buildReadme(spec, components));
  write(".gitignore", buildGitignore());
  write(".dockerignore", buildDockerignore());
  write("Dockerfile", buildDockerfile({ components: components.length > 0 }));
  write("src/index.ts", buildEntryPointSource(spec, { components: components.length > 0 }));
  write("src/server.ts", buildServerEntryPointSource(spec, { components: components.length > 0 }));

  if (components.length > 0) {
    write("src/components.generated.ts", buildComponentsModule(components));
    write("src/verify.ts", buildVerifyEntryPointSource());
    write("kampong.lock", buildLockfileText(components));
    write("sbom.json", buildSbom(spec, components));
    for (const component of components) {
      const { id, version } = component.manifest;
      // A forced re-export replaces the component outright, so a file the new version no longer has
      // cannot outlive the digest that no longer covers it. (id and version were validated.)
      rmSync(join(outputDir, "components", ...id.split("/"), version), {
        recursive: true,
        force: true,
      });
      for (const [path, contents] of Object.entries(component.files)) {
        writeBytes(join("components", ...id.split("/"), version, ...path.split("/")), contents);
      }
    }
  }

  const envExample = buildEnvExample(spec, components);
  if (envExample) write(".env.example", envExample);

  for (const file of readRuntimeFiles()) {
    write(join("src", "runtime", file.name), file.contents);
  }

  return { outputDir, files: written.sort() };
}
