import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// The Variables panel's endpoints: write-only, by name, never a value back.

const SPEC = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: openrouter, name: m, api_key: "\${DEMO_KEY}" }
  workflow:
    - step: s
      action: generate_text
      inputs: [input]
`;

describe("secrets endpoints", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let env: NodeJS.ProcessEnv;
  const file = () => join(dir, ".kampong", "secrets.env");
  const boot = async () => {
    app = createDevServer({
      specPath: join(dir, "agent.yaml"),
      layoutPath: join(dir, ".kampong", "layout.json"),
      doctor: { env },
    });
    await app.ready();
    return app;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-secrets-"));
    writeFileSync(join(dir, "agent.yaml"), SPEC);
    env = {};
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (name: string, value: unknown) =>
    app!.inject({ method: "PUT", url: `/api/secrets/${name}`, payload: { value } });

  it("lists the names the spec reads, unset", async () => {
    await boot();
    const res = await app!.inject({ method: "GET", url: "/api/secrets" });
    expect(res.json().secrets).toEqual([{ name: "DEMO_KEY", referenced: true, source: "unset" }]);
  });

  it("lists the credential a first-party component reads through its slot", async () => {
    writeFileSync(
      join(dir, "agent.yaml"),
      SPEC.replace(
        "  workflow:",
        `  tools:
    - name: post
      action: component
      use: kampong/slack@1.0.0
      op: post_message
      with: { channel: "C1", text: "hi" }
  workflow:`,
      ),
    );
    await boot();
    const res = await app!.inject({ method: "GET", url: "/api/secrets" });
    const names = res.json().secrets.map((r: { name: string }) => r.name);
    expect(names).toContain("SLACK_BOT_TOKEN");
  });

  it("saves a value, applies it to the environment, and never returns it", async () => {
    await boot();
    const res = await put("DEMO_KEY", "s3cret value");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("s3cret");
    expect(env.DEMO_KEY).toBe("s3cret value");
    const listed = await app!.inject({ method: "GET", url: "/api/secrets" });
    expect(listed.body).not.toContain("s3cret");
    expect(listed.json().secrets[0]).toMatchObject({ name: "DEMO_KEY", source: "saved" });
  });

  it("keeps the file private and out of git", async () => {
    await boot();
    await put("DEMO_KEY", "v");
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".kampong", ".gitignore"), "utf8")).toContain("secrets.env");
  });

  it("loads saved values when the server starts again", async () => {
    await boot();
    await put("DEMO_KEY", "persisted");
    await app!.close();
    env = {};
    await boot();
    expect(env.DEMO_KEY).toBe("persisted");
  });

  it("removing a saved value restores what the environment held", async () => {
    env = { DEMO_KEY: "from-env" };
    await boot();
    await put("DEMO_KEY", "override");
    expect(env.DEMO_KEY).toBe("override");
    const res = await app!.inject({ method: "DELETE", url: "/api/secrets/DEMO_KEY" });
    expect(res.statusCode).toBe(200);
    expect(env.DEMO_KEY).toBe("from-env");
    expect(res.json().secrets[0].source).toBe("environment");
  });

  it("round-trips a value with spaces, quotes and a newline", async () => {
    await boot();
    const tricky = 'two words "quoted"\nsecond line';
    await put("DEMO_KEY", tricky);
    await app!.close();
    env = {};
    await boot();
    expect(env.DEMO_KEY).toBe(tricky);
  });

  it("refuses a bad name or an empty value, and a delete of nothing", async () => {
    await boot();
    expect((await put("bad-name", "v")).statusCode).toBe(400);
    expect((await put("DEMO_KEY", "")).statusCode).toBe(400);
    const gone = await app!.inject({ method: "DELETE", url: "/api/secrets/NOPE" });
    expect(gone.statusCode).toBe(404);
  });

  it("refuses a cross-origin write", async () => {
    await boot();
    const res = await app!.inject({
      method: "PUT",
      url: "/api/secrets/DEMO_KEY",
      payload: { value: "v" },
      headers: { origin: "http://evil.test" },
    });
    expect(res.statusCode).toBe(403);
    expect(env.DEMO_KEY).toBeUndefined();
  });
});
