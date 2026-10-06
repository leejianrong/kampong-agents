import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// KAN-1885: the canvas asks the local server which components are installed so it can generate forms
// from their op schemas. The response carries what a form needs, never request templates or code.

const SPEC = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: s
      action: say
`;

const MANIFEST = `kind: rest
id: acme/tickets
version: 1.0.0
title: Tickets
permissions: { egress: [tickets.example.test] }
auth:
  slots:
    token:
      env: TICKETS_TOKEN
      hosts: [tickets.example.test]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
ops:
  get:
    effect: read
    input: { type: object, properties: { id: { type: string } } }
    request: { method: GET, url: "https://tickets.example.test/{{ input.id }}" }
`;

describe("GET /api/components", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-components-api-"));
    writeFileSync(join(dir, "agent.yaml"), SPEC);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async () => {
    app = createDevServer({
      specPath: join(dir, "agent.yaml"),
      layoutPath: join(dir, "layout.json"),
    });
    await app.ready();
    return app;
  };

  it("lists nothing, without error, when there is no components folder", async () => {
    const res = await (await start()).inject({ method: "GET", url: "/api/components" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ components: [], problems: [] });
  });

  it("lists installed components with their ops, slots and digest", async () => {
    mkdirSync(join(dir, "components/acme/tickets/1.0.0"), { recursive: true });
    writeFileSync(join(dir, "components/acme/tickets/1.0.0/component.yaml"), MANIFEST);
    const res = await (await start()).inject({ method: "GET", url: "/api/components" });
    const body = res.json();
    expect(body.components).toHaveLength(1);
    expect(body.components[0]).toMatchObject({
      id: "acme/tickets",
      version: "1.0.0",
      slots: [{ name: "token", env: "TICKETS_TOKEN" }],
    });
    expect(body.components[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.components[0].ops.get.effect).toBe("read");
    // No request templates, hosts or auth injection leave the server.
    expect(JSON.stringify(body)).not.toContain("tickets.example.test");
    expect(JSON.stringify(body)).not.toContain("Bearer");
  });

  it("reports a manifest that did not load instead of hiding it", async () => {
    mkdirSync(join(dir, "components/oops"), { recursive: true });
    writeFileSync(join(dir, "components/oops/component.yaml"), MANIFEST);
    const body = (await (await start()).inject({ method: "GET", url: "/api/components" })).json();
    expect(body.components).toEqual([]);
    expect(body.problems[0]).toMatch(/must live at acme\/tickets\/1\.0\.0/);
  });

  it("answers with a problem, not a 500, when the components folder cannot be read", async () => {
    // A file where the folder should be.
    writeFileSync(join(dir, "components"), "not a directory");
    const res = await (await start()).inject({ method: "GET", url: "/api/components" });
    expect(res.statusCode).toBe(200);
    expect(res.json().components).toEqual([]);
  });
});
