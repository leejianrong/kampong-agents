import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE_ERROR, runCli } from "../../src/cli.js";
import { capture } from "./test-helpers.js";

// KAM-315: `kampong serve --help` said "a live webhook service" and listed five endpoints while the reference and
// the server had more. The help and docs/reference/cli.md must name the same endpoints, and a bad argument must not
// bury its one-line error under the whole help text.

const reference = readFileSync(
  fileURLToPath(new URL("../../../../docs/reference/cli.md", import.meta.url)),
  "utf8",
);

const serveSection = (() => {
  const from = reference.indexOf("## `kampong serve`");
  return reference.slice(from, reference.indexOf("## `kampong templates`", from));
})();

const endpoints = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((m) => `${m[1]} ${m[2]}`).sort();

describe("kampong serve --help", () => {
  it("lists the same endpoints as the CLI reference", async () => {
    const { io, out } = capture();
    expect(await runCli(["serve", "--help"], io)).toBe(0);
    const inHelp = endpoints(out.join("\n"), /^ {2}(GET|POST)\s+(\S+)/gm);
    const inDocs = endpoints(serveSection, /^\| `(GET|POST) (\S+)`/gm);
    expect(inHelp.length).toBeGreaterThan(5);
    expect(inHelp).toEqual(inDocs);
  });

  it("describes every kind of trigger, not only the webhook", async () => {
    const { io, out } = capture();
    await runCli(["serve", "--help"], io);
    const help = out.join("\n");
    for (const word of ["webhook", "schedule", "poll", "approvals", "ignored"]) {
      expect(help).toContain(word);
    }
    expect(help).not.toContain("Returns { id, state }");
    expect(help).toContain("{ success, id, state }");
  });
});

describe("kampong serve with a bad argument", () => {
  it("prints the error and a pointer to --help, not the whole help", async () => {
    for (const args of [[], ["--port", "abc", "a.yaml"], ["a.yaml", "--nope"]]) {
      const { io, err } = capture();
      expect(await runCli(["serve", ...args], io)).toBe(EXIT_USAGE_ERROR);
      const text = err.join("\n");
      expect(text).toMatch(/^kampong serve: /);
      expect(text).toContain("kampong serve --help");
      expect(text).not.toContain("Endpoints:");
      expect(text.split("\n").length).toBeLessThanOrEqual(2);
    }
  });
});
