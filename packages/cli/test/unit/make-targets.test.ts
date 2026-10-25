import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KAM-235: the try/verify make targets exist, `make help` lists them, and each points at a real script. Dry runs
// only (`make -n`), so no server, browser or container starts.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const make = (...args: string[]) =>
  execFileSync("make", ["--no-print-directory", "-C", root, ...args], { encoding: "utf8" });

const TARGETS: Record<string, string> = {
  try: "scripts/try.sh blank",
  "try-demo": "scripts/try.sh demo",
  "try-reset": "rm -rf .try",
  "try-hosted": "scripts/try-hosted.sh",
  "e2e-browser": "scripts/e2e-browser.sh",
  verify: "scripts/verify.sh",
};

describe("make targets for trying the app and verifying it", () => {
  const help = make("help");

  for (const [target, command] of Object.entries(TARGETS)) {
    it(`make ${target} runs ${command} and is listed by make help`, () => {
      expect(make("-n", target).trim()).toBe(command);
      expect(help).toMatch(new RegExp(`make ${target}\\s`));
    });
  }

  it("keeps the Docker targets", () => {
    for (const target of ["up", "down", "restart", "logs", "build", "shell", "ps", "clean"]) {
      expect(help).toMatch(new RegExp(`make ${target}\\s`));
    }
  });

  it("ships executable scripts", () => {
    for (const file of ["try", "try-hosted", "e2e-browser", "verify"]) {
      expect(() => accessSync(join(root, "scripts", `${file}.sh`), constants.X_OK)).not.toThrow();
    }
  });
});
