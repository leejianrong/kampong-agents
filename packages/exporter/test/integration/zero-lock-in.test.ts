import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { exportProject } from "../../src/index.js";

// SLICES.md V4 (KAN-1116) -- its own named test plan item: "Exported
// project's package.json declares only real, resolvable dependencies (no
// phantom/internal-only packages)." This is the automated check for that,
// plus the stronger claim ADR-0002/docs/adr/0010 make: every generated
// *source file*'s imports resolve only to a package actually declared in
// that package.json, or a Node builtin -- never to "@kampong/*" anything.

const SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Customer Support Specialist",
    goal: "Review incoming refund requests and process eligible ones.",
    model: { provider: "ollama", name: "llama3.1", base_url: "http://localhost:11434" },
    tools: [
      {
        name: "issue_refund",
        action: "http_request",
        method: "POST",
        url: "https://api.stripe.test/v1/refunds",
        requires_approval: true,
        extract: "status",
      },
    ],
    guardrails: { confidence_threshold: 0.85, fallback_action: "escalate_to_human" },
    workflow: [
      { step: "parse_request", action: "extract_entities", confidence_gate: true },
      {
        step: "decide",
        type: "condition",
        if: "parse_request.eligible == true",
        then: "execute_tool(issue_refund)",
        else: "request_human_approval",
      },
    ],
  },
};

const NODE_BUILTINS = new Set(builtinModules);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every module specifier a `from "..."` / bare `import "..."` references in
 * an ES module source file. Skips `//`-comment lines first -- the vendored
 * runtime files' header comments legitimately mention `"@kampong/spec"` in
 * prose (explaining what a type-only import used to come from before
 * vendoring, ADR-0010), which isn't a real import and must not trip this
 * check; only lines outside comments are scanned for actual import syntax.
 */
function importSpecifiers(source: string): string[] {
  const codeOnly = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  const specifiers: string[] = [];
  const fromPattern = /\bfrom\s+["']([^"']+)["']/g;
  const bareImportPattern = /\bimport\s+["']([^"']+)["']/g;
  for (const pattern of [fromPattern, bareImportPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(codeOnly)) !== null) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

/** The declared npm package name a bare (non-relative, non-builtin) specifier resolves against -- e.g. "@mastra/core/tools" -> "@mastra/core". */
function packageNameFor(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

describe("zero lock-in (SLICES.md V4, KAN-1116)", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "kampong-exporter-lockin-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("package.json's dependencies contain no @kampong/* package and no file:/link: reference back to this repo", () => {
    exportProject(SPEC, outputDir);
    const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(allDeps)) {
      expect(name.startsWith("@kampong/")).toBe(false);
      expect(version.startsWith("file:")).toBe(false);
      expect(version.startsWith("link:")).toBe(false);
    }
    expect(Object.keys(allDeps).length).toBeGreaterThan(0);
  });

  it("every generated .ts file's imports resolve only to a declared dependency, a Node builtin, or a relative path -- never @kampong/*", () => {
    const result = exportProject(SPEC, outputDir);
    const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const tsFiles = listTsFiles(outputDir);
    expect(tsFiles.length).toBeGreaterThan(0);
    // Sanity: every file exportProject reported as written under src/ is one we actually scanned.
    for (const relativePath of result.files.filter((f) => f.endsWith(".ts"))) {
      expect(tsFiles).toContain(join(outputDir, relativePath));
    }

    for (const file of tsFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        expect(specifier.startsWith("@kampong/")).toBe(false);

        if (specifier.startsWith(".") || specifier.startsWith("/")) continue; // relative import
        if (NODE_BUILTINS.has(specifier.replace(/^node:/, ""))) continue; // Node builtin

        const packageName = packageNameFor(specifier);
        expect(
          declared.has(packageName),
          `${relative(outputDir, file)} imports "${specifier}" (package "${packageName}"), which isn't declared in package.json`,
        ).toBe(true);
      }
    }
  });
});
