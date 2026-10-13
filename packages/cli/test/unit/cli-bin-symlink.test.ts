import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// Regression: `npm install` links node_modules/.bin/kampong to dist/cli.js, and the entry-point guard
// compared process.argv[1] (the symlink) to the real module URL, so a linked or global install printed
// nothing and exited 0.
const cliJs = join(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");

describe.skipIf(!existsSync(cliJs))("kampong invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "kampong-bin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the CLI, not nothing", () => {
    const link = join(dir, "kampong");
    symlinkSync(cliJs, link);
    const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    expect(out).toContain("Usage: kampong <command>");
  });
});
