import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import {
  exportProject,
  slugifyPackageName,
  ExportDirectoryNotEmptyError,
} from "../../src/index.js";

// SLICES.md V4 (KAN-1114) unit test plan: "Codegen correctly translates
// each spec construct (tool, conditional, guardrail) into its TypeScript
// equivalent." Since the vendored runtime files (docs/adr/0010) are exact
// copies of packages/engine's already-tested source, this only needs to
// prove the *entry point* wiring bakes the spec's concrete values in
// correctly -- not re-prove condition/guardrail/tool-call correctness
// itself, which packages/engine's own suite covers.

const FULL_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "refund-agent",
    name: "Refund Agent",
    role: "Customer Support Specialist",
    goal: "Review incoming refund requests and process eligible ones.",
    model: {
      provider: "anthropic",
      name: "claude-3-5-sonnet-20241022",
      api_key: "${ANTHROPIC_API_KEY}",
    },
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

const MINIMAL_SPEC: AgentSpec = {
  version: "1.0",
  agent: {
    id: "Greeter Bot!!",
    name: "Greeter",
    role: "Front desk",
    goal: "Greet visitors.",
    workflow: [{ step: "greet", action: "say_hello" }],
  },
};

describe("slugifyPackageName", () => {
  it("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(slugifyPackageName("Greeter Bot!!")).toBe("greeter-bot");
  });

  it("falls back to a generic name when nothing usable survives", () => {
    expect(slugifyPackageName("!!!")).toBe("kampong-exported-agent");
  });

  it("passes through an already-valid id unchanged", () => {
    expect(slugifyPackageName("refund-agent")).toBe("refund-agent");
  });
});

describe("exportProject", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "kampong-exporter-unit-"));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("writes package.json, tsconfig.json, README.md, .gitignore, the entry point, and every vendored runtime file", () => {
    const result = exportProject(FULL_SPEC, outputDir);

    expect(result.outputDir).toBe(outputDir);
    expect(result.files).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "README.md",
        ".gitignore",
        ".env.example",
        join("src", "index.ts"),
        join("src", "runtime", "condition.ts"),
        join("src", "runtime", "guardrail.ts"),
        join("src", "runtime", "http-tool.ts"),
        join("src", "runtime", "model.ts"),
        join("src", "runtime", "run.ts"),
        join("src", "runtime", "spec-types.ts"),
        join("src", "runtime", "workflow.ts"),
      ]),
    );
    for (const relativePath of result.files) {
      expect(() => readFileSync(join(outputDir, relativePath), "utf8")).not.toThrow();
    }
  });

  it("package.json declares only real, resolvable dependencies -- no @kampong/* package", () => {
    exportProject(FULL_SPEC, outputDir);
    const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8"));

    expect(pkg.name).toBe("refund-agent");
    expect(pkg.dependencies).toMatchObject({
      "@mastra/core": expect.any(String),
      zod: expect.any(String),
      "@ai-sdk/anthropic": expect.any(String),
      "@ai-sdk/openai": expect.any(String),
    });
    const allDepNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(allDepNames.some((name) => name.startsWith("@kampong/"))).toBe(false);
    const allDepValues = [
      ...Object.values(pkg.dependencies ?? {}),
      ...Object.values(pkg.devDependencies ?? {}),
    ] as string[];
    expect(allDepValues.some((v) => v.startsWith("file:") || v.startsWith("link:"))).toBe(false);
  });

  it("sanitizes an id with spaces/punctuation into a valid package name", () => {
    exportProject(MINIMAL_SPEC, outputDir);
    const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("greeter-bot");
  });

  it("does not write .env.example when the spec has no model.api_key", () => {
    const result = exportProject(MINIMAL_SPEC, outputDir);
    expect(result.files).not.toContain(".env.example");
  });

  it("bakes the tool, conditional, and guardrail spec constructs into the entry point as concrete values", () => {
    exportProject(FULL_SPEC, outputDir);
    const entry = readFileSync(join(outputDir, "src", "index.ts"), "utf8");

    // Tool
    expect(entry).toContain('"name": "issue_refund"');
    expect(entry).toContain('"url": "https://api.stripe.test/v1/refunds"');
    expect(entry).toContain('"requires_approval": true');
    // Conditional workflow step
    expect(entry).toContain('"if": "parse_request.eligible == true"');
    expect(entry).toContain('"then": "execute_tool(issue_refund)"');
    expect(entry).toContain('"else": "request_human_approval"');
    // Guardrail
    expect(entry).toContain('"confidence_threshold": 0.85');
    expect(entry).toContain('"fallback_action": "escalate_to_human"');
    // Model
    expect(entry).toContain('"provider": "anthropic"');
    expect(entry).toContain('"api_key": "${ANTHROPIC_API_KEY}"');
  });

  it("entry point imports the vendored runtime, never @kampong/*", () => {
    exportProject(FULL_SPEC, outputDir);
    const entry = readFileSync(join(outputDir, "src", "index.ts"), "utf8");

    expect(entry).toContain('from "./runtime/run.js"');
    expect(entry).not.toMatch(/@kampong\//);
  });

  it("README documents the one-way-export contract and the required env var", () => {
    exportProject(FULL_SPEC, outputDir);
    const readme = readFileSync(join(outputDir, "README.md"), "utf8");

    expect(readme).toMatch(/one-way/i);
    expect(readme).toContain("ANTHROPIC_API_KEY");
  });

  it(".env.example lists the exact env var the spec's model.api_key references", () => {
    exportProject(FULL_SPEC, outputDir);
    const envExample = readFileSync(join(outputDir, ".env.example"), "utf8");
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
  });

  it("is idempotent -- exporting the same spec twice to the same directory with force:true overwrites cleanly", () => {
    exportProject(FULL_SPEC, outputDir);
    const result = exportProject(FULL_SPEC, outputDir, { force: true });
    expect(result.files.length).toBeGreaterThan(0);
  });

  // Finding #2: re-running `kampong export` on an output directory the user
  // has since hand-edited (the normal workflow the generated README
  // describes -- edits never sync back, ADR-0002) must not silently
  // overwrite those edits.
  describe("refuses to overwrite a non-empty output directory by default", () => {
    it("throws ExportDirectoryNotEmptyError without writing anything when outputDir already has content", () => {
      writeFileSync(join(outputDir, "hand-edited.txt"), "don't clobber me");

      expect(() => exportProject(FULL_SPEC, outputDir)).toThrow(ExportDirectoryNotEmptyError);
      // Nothing from this export landed -- the pre-existing file is untouched and
      // no export files were written alongside it.
      expect(readFileSync(join(outputDir, "hand-edited.txt"), "utf8")).toBe("don't clobber me");
      expect(() => readFileSync(join(outputDir, "package.json"), "utf8")).toThrow();
    });

    it("does not throw when outputDir doesn't exist yet", () => {
      const freshDir = join(outputDir, "fresh-subdir");
      expect(() => exportProject(FULL_SPEC, freshDir)).not.toThrow();
    });

    it("does not throw when outputDir exists but is empty", () => {
      expect(() => exportProject(FULL_SPEC, outputDir)).not.toThrow();
    });

    it("{ force: true } overwrites a non-empty output directory instead of refusing", () => {
      writeFileSync(join(outputDir, "hand-edited.txt"), "stale content");

      const result = exportProject(FULL_SPEC, outputDir, { force: true });

      expect(result.files).toContain("package.json");
      expect(readFileSync(join(outputDir, "package.json"), "utf8")).toContain("refund-agent");
    });
  });
});
