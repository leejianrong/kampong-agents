import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_EXECUTION_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  EXIT_VALIDATION_FAILURE,
  runCli,
} from "../../src/cli.js";
import { capture } from "./test-helpers.js";

// SLICES.md V4 (KAN-1115) unit test plan: `kampong export` follows the same
// flag-parsing/exit-code convention `run`/`dev` already established
// (packages/cli/test/unit/cli.test.ts) -- 0 success, 1 validation failure,
// 64 usage error.

const SIMPLE_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

const BROKEN_SPEC = `version: "1.0"
agent:
  id: broken
`;

describe("kampong export -- exit codes and output (SLICES.md V4 KAN-1115)", () => {
  let dir: string;
  let outputDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-export-"));
    outputDir = join(dir, "exported");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 and writes a runnable project on a valid spec", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, out } = capture();

    const code = await runCli(["export", specPath, outputDir], io);

    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("Exported");
    expect(existsSync(join(outputDir, "package.json"))).toBe(true);
    expect(existsSync(join(outputDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(outputDir, "src", "runtime", "workflow.ts"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("greeter");
    expect(Object.keys(pkg.dependencies ?? {}).some((n) => n.startsWith("@kampong/"))).toBe(false);
  });

  it("exits 1 (validation failure) when the spec fails schema validation", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, BROKEN_SPEC);
    const { io } = capture();

    const code = await runCli(["export", specPath, outputDir], io);

    expect(code).toBe(EXIT_VALIDATION_FAILURE);
    expect(existsSync(outputDir)).toBe(false);
  });

  it("exits 1 when the spec file doesn't exist", async () => {
    const { io } = capture();
    const code = await runCli(["export", join(dir, "missing.yaml"), outputDir], io);
    expect(code).toBe(EXIT_VALIDATION_FAILURE);
  });

  it("exits 64 (usage error) when the output directory argument is missing", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, err } = capture();

    const code = await runCli(["export", specPath], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("output-dir");
  });

  it("exits 64 when no arguments are given at all", async () => {
    const { io } = capture();
    const code = await runCli(["export"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it("exits 64 on an unrecognized option", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io } = capture();

    const code = await runCli(["export", specPath, outputDir, "--bogus"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it("--help exits 0 and prints usage without exporting anything", async () => {
    const { io, out } = capture();
    const code = await runCli(["export", "--help"], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("kampong export");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("top-level help mentions the export command", async () => {
    const { io, out } = capture();
    const code = await runCli(["--help"], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("export <spec>.yaml <output-dir>");
  });

  // Finding #2: a bare re-export must never silently clobber an output
  // directory the user has since hand-edited (the normal export workflow --
  // edits never sync back, ADR-0002).
  describe("--force", () => {
    it("exits 2 and writes nothing when the output directory already has content and --force is omitted", async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, SIMPLE_SPEC);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "hand-edited.txt"), "keep me");
      const { io, err } = capture();

      const code = await runCli(["export", specPath, outputDir], io);

      expect(code).toBe(EXIT_EXECUTION_FAILURE);
      expect(err.join("\n")).toContain("--force");
      expect(existsSync(join(outputDir, "package.json"))).toBe(false);
      expect(readFileSync(join(outputDir, "hand-edited.txt"), "utf8")).toBe("keep me");
    });

    it("exits 0 and overwrites when the output directory already has content and --force is given", async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, SIMPLE_SPEC);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, "hand-edited.txt"), "stale");
      const { io, out } = capture();

      const code = await runCli(["export", specPath, outputDir, "--force"], io);

      expect(code).toBe(EXIT_SUCCESS);
      expect(out.join("\n")).toContain("Exported");
      expect(existsSync(join(outputDir, "package.json"))).toBe(true);
    });

    it("exits 0 without --force when the output directory doesn't exist yet", async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, SIMPLE_SPEC);
      const { io } = capture();

      const code = await runCli(["export", specPath, outputDir], io);

      expect(code).toBe(EXIT_SUCCESS);
      expect(existsSync(join(outputDir, "package.json"))).toBe(true);
    });
  });
});
