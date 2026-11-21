import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// KAM-288: the tool installs and runs on a machine with no clone of this repo. The five packages are packed into
// tarballs (`scripts/pack-release.mjs`), installed together into an empty folder, and the installed `kampong` is
// driven: its help, its templates, and `kampong dev` serving the canvas and running a template's Replay offline.
// Nothing is published; `npm install` of the tarballs needs no registry for the @kampong packages.

const ROOT = resolve(import.meta.dirname, "..");
let work: string;
let dev: ChildProcess | undefined;

const free = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "kampong-install-"));
  const tarballs = join(work, "release");
  execFileSync(process.execPath, [join(ROOT, "scripts/pack-release.mjs"), tarballs], {
    stdio: "ignore",
  });
  const project = join(work, "project");
  mkdirSync(project);
  execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      ...readdirSync(tarballs)
        .filter((f) => f.endsWith(".tgz"))
        .map((f) => join(tarballs, f)),
    ],
    { cwd: project, stdio: "ignore" },
  );
}, 280_000);

afterAll(() => {
  dev?.kill();
  rmSync(work, { recursive: true, force: true });
});

const kampong = (...args: string[]) =>
  execFileSync(join(work, "project/node_modules/.bin/kampong"), args, { encoding: "utf8" });

describe("kampong installed from tarballs, in a folder with no clone of the repo", () => {
  it("prints help that names no internal document, and lists the templates it ships", () => {
    const help = kampong("--help");
    expect(help).toContain("Usage: kampong");
    expect(help).not.toMatch(/PLAN\.md|AGENTS\.md|docs\/adr|\bADR-\d/);
    const templates = JSON.parse(kampong("templates", "--json")) as { name: string }[];
    expect(templates.map((t) => t.name).sort()).toEqual([
      "market-etl",
      "support-triage",
      "webhook-triage",
    ]);
  });

  it("serves the canvas, applies a template and completes its Replay with no key and no clone", async () => {
    const port = await free();
    const dir = join(work, "workflow");
    mkdirSync(dir);
    dev = spawn(
      join(work, "project/node_modules/.bin/kampong"),
      ["dev", dir, "--port", String(port)],
      {
        stdio: "ignore",
        // An empty environment: the Replay must need no key.
        env: { PATH: process.env["PATH"] ?? "", HOME: work },
      },
    );
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        up = (await fetch(base)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(up, "kampong dev did not start").toBe(true);
    expect(await (await fetch(base)).text()).toContain("<title>Kampong Agents</title>");

    const applied = await fetch(`${base}/api/spec/template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "market-etl" }),
    });
    expect((await applied.json()) as { success: boolean }).toMatchObject({ success: true });

    const started = (await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "", mode: "replay" }),
      })
    ).json()) as { success: boolean; id: string; mode: string };
    expect(started).toMatchObject({ success: true, mode: "replay" });
    let status = "running";
    for (let i = 0; i < 200 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = (
        (await (await fetch(`${base}/api/runs/${started.id}`)).json()) as {
          state: { status: string };
        }
      ).state.status;
    }
    expect(status).toBe("completed");
  }, 60_000);
});
