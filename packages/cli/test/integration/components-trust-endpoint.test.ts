import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// KAN-1901: the canvas can see each component's permissions and pin state, pin one, and run doctor.

const SPEC = (extra = "") => `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  model: { provider: ollama, name: llama3.1 }
  tools:
    - name: t
      action: component
      use: acme/tickets@1.0.0
      op: get
      with: { id: "1" }
${extra}  workflow:
    - step: s
      type: tool
      tool: t
`;

const MANIFEST = (egress = "tickets.example.test") => `kind: rest
id: acme/tickets
version: 1.0.0
title: Tickets
permissions: { egress: [${egress}] }
auth:
  slots:
    token:
      env: TICKETS_TOKEN
      hosts: [${egress.split(",")[0]}]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
ops:
  get:
    effect: read
    input: { type: object, properties: { id: { type: string } } }
    request: { method: GET, url: "https://${egress.split(",")[0]}/{{ input.id }}" }
`;

describe("component trust endpoints", () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  const manifestPath = () => join(dir, "components/acme/tickets/1.0.0/component.yaml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-trust-api-"));
    mkdirSync(join(dir, "components/acme/tickets/1.0.0"), { recursive: true });
    writeFileSync(manifestPath(), MANIFEST());
    writeFileSync(join(dir, "agent.yaml"), SPEC());
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (doctor = {}) => {
    app = createDevServer({
      specPath: join(dir, "agent.yaml"),
      layoutPath: join(dir, "layout.json"),
      doctor,
    });
    await app.ready();
    return app;
  };
  const tickets = async () => {
    const body = (await (await start()).inject({ method: "GET", url: "/api/components" })).json();
    return body.components.find((c: { id: string }) => c.id === "acme/tickets");
  };
  const pin = async (payload: object) =>
    (await start()).inject({ method: "POST", url: "/api/components/pin", payload });

  it("lists what each component may do, and marks first-party ones as needing no pin", async () => {
    const entry = await tickets();
    expect(entry.permissionsSummary).toContain("tickets.example.test");
    const body = (await app!.inject({ method: "GET", url: "/api/components" })).json();
    const slack = body.components.find((c: { id: string }) => c.id === "kampong/slack");
    expect(slack.pin).toEqual({ state: "first-party" });
  });

  it("reports unpinned, then pinned once pinned, then changed when the files change", async () => {
    expect((await tickets()).pin).toEqual({ state: "unpinned" });
    const res = await pin({ use: "acme/tickets@1.0.0" });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(readFileSync(join(dir, "kampong.lock"), "utf8")).toContain("acme/tickets@1.0.0");
    expect((await tickets()).pin).toEqual({ state: "pinned" });
    await app!.close();

    writeFileSync(manifestPath(), `${MANIFEST()}# edited\n`);
    expect((await tickets()).pin).toEqual({ state: "changed" });
  });

  it("refuses to re-pin an update that widens what the component may do, until that is accepted", async () => {
    await pin({ use: "acme/tickets@1.0.0" });
    await app!.close();
    writeFileSync(manifestPath(), MANIFEST("tickets.example.test, evil.example.test"));

    const entry = await tickets();
    expect(entry.pin.state).toBe("changed");
    expect(entry.pin.widened.join(" ")).toContain("evil.example.test");

    const refused = await pin({ use: "acme/tickets@1.0.0" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toContain("widens");
    await app!.close();
    expect((await tickets()).pin.state).toBe("changed");
    await app!.close();

    const accepted = await pin({ use: "acme/tickets@1.0.0", allowWiderPermissions: true });
    expect(accepted.statusCode).toBe(200);
    expect(
      accepted.json().catalog.components.find((c: { id: string }) => c.id === "acme/tickets").pin,
    ).toEqual({
      state: "pinned",
    });
  });

  it("rejects a pin request that is not id@version, or names a component that is not installed", async () => {
    expect((await pin({ use: "nonsense" })).statusCode).toBe(400);
    await app!.close();
    expect((await pin({})).statusCode).toBe(400);
    await app!.close();
    const missing = await pin({ use: "acme/missing@1.0.0" });
    expect(missing.statusCode).toBe(422);
  });

  it("refuses to pin something other than what the author reviewed (the files changed since)", async () => {
    const reviewed = (await tickets()).digest;
    await app!.close();
    writeFileSync(manifestPath(), MANIFEST("tickets.example.test, evil.example.test"));
    const stale = await pin({ use: "acme/tickets@1.0.0", expectedDigest: reviewed });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("review it again");
    // The fresh catalog comes back so the form shows what is really there, and nothing was pinned.
    expect(
      stale.json().catalog.components.find((c: { id: string }) => c.id === "acme/tickets").digest,
    ).not.toBe(reviewed);
    await app!.close();
    expect((await tickets()).pin).toEqual({ state: "unpinned" });
  });

  it("pins when the digest the author reviewed is what is on disk", async () => {
    const reviewed = (await tickets()).digest;
    await app!.close();
    const ok = await pin({ use: "acme/tickets@1.0.0", expectedDigest: reviewed });
    expect(ok.statusCode).toBe(200);
  });

  it("does not pin a built-in component", async () => {
    const res = await pin({ use: "kampong/slack@1.0.0" });
    expect(res.statusCode).toBe(400);
    expect(() => readFileSync(join(dir, "kampong.lock"))).toThrow();
  });

  it("asks for no consent for a component that may do nothing, even when its old pin had no record", async () => {
    const quiet = `kind: module
id: acme/tickets
version: 1.0.0
entry: ./index.mjs
ops:
  get: { effect: read }
`;
    writeFileSync(manifestPath(), quiet);
    writeFileSync(
      join(dir, "components/acme/tickets/1.0.0/index.mjs"),
      "export async function invoke() {}\n",
    );
    // A lockfile entry from before permissions were recorded, for different bytes.
    writeFileSync(
      join(dir, "kampong.lock"),
      `version: 1\ncomponents:\n  acme/tickets@1.0.0:\n    digest: sha256:${"0".repeat(64)}\n`,
    );
    const entry = await tickets();
    expect(entry.permissionsSummary).toBe("no permissions");
    expect(entry.pin).toEqual({ state: "changed" }); // no `widened`: nothing to consent to
    await app!.close();
    // And the server agrees with what the canvas showed.
    expect((await pin({ use: "acme/tickets@1.0.0" })).statusCode).toBe(200);
  });

  describe("who may call these endpoints (DNS rebinding and cross-site requests)", () => {
    const call = async (headers: Record<string, string>, method: "GET" | "POST" = "POST") =>
      (await start()).inject({
        method,
        url: method === "POST" ? "/api/doctor" : "/api/components",
        headers,
        payload: method === "POST" ? {} : undefined,
      });

    it("refuses a Host that is not this machine, which is what a rebound page sends", async () => {
      expect((await call({ host: "evil.example.com" })).statusCode).toBe(403);
      await app!.close();
      expect((await call({ host: "evil.example.com" }, "GET")).statusCode).toBe(403);
    });

    it("answers loopback names with or without a port", async () => {
      for (const host of ["localhost:4310", "127.0.0.1:4310", "[::1]:4310", "localhost"]) {
        expect((await call({ host }, "GET")).statusCode, host).toBe(200);
        await app!.close();
      }
    });

    it("refuses a write from another origin, or marked cross-site, even on a loopback host", async () => {
      const base = { host: "localhost:4310" };
      expect((await call({ ...base, origin: "https://evil.example.com" })).statusCode).toBe(403);
      await app!.close();
      expect((await call({ ...base, origin: "null" })).statusCode).toBe(403);
      await app!.close();
      expect((await call({ ...base, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
      await app!.close();
      expect((await call({ ...base, origin: "http://localhost:4310" })).statusCode).toBe(200);
    });

    it("answers a host the author bound on purpose, and any name when bound to every interface", async () => {
      app = createDevServer({
        specPath: join(dir, "agent.yaml"),
        layoutPath: join(dir, "layout.json"),
        allowedHosts: ["devbox.lan"],
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/components",
            headers: { host: "devbox.lan:4310" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/components",
            headers: { host: "other.lan" },
          })
        ).statusCode,
      ).toBe(403);
      await app.close();
      app = createDevServer({
        specPath: join(dir, "agent.yaml"),
        layoutPath: join(dir, "layout.json"),
        allowedHosts: ["*"],
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/components",
            headers: { host: "anything.lan" },
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  describe("POST /api/doctor", () => {
    const env = { TICKETS_TOKEN: "s3cret-token-value" };

    it("runs the offline checks by default and never dials or probes", async () => {
      await pin({ use: "acme/tickets@1.0.0" });
      await app!.close();
      const dialed: string[] = [];
      const probed: string[] = [];
      const server = await start({
        env,
        connect: async (host: string) => void dialed.push(host),
        probeFetch: async (url: unknown) => {
          probed.push(String(url));
          return new Response("{}");
        },
      });
      const res = await server.inject({ method: "POST", url: "/api/doctor", payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.checks.some((c: { area: string }) => c.area === "component")).toBe(true);
      expect(dialed).toEqual([]);
      expect(probed).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("s3cret-token-value");
    });

    it("reports an unpinned component as a failure", async () => {
      const server = await start({ env });
      const body = (
        await server.inject({ method: "POST", url: "/api/doctor", payload: {} })
      ).json();
      const failed = body.checks.filter((c: { status: string }) => c.status === "fail");
      expect(failed.map((c: { message: string }) => c.message).join(" ")).toContain("not pinned");
    });

    it("dials only when asked to", async () => {
      const dialed: string[] = [];
      const server = await start({ env, connect: async (host: string) => void dialed.push(host) });
      await server.inject({ method: "POST", url: "/api/doctor", payload: { online: true } });
      expect(dialed).toContain("tickets.example.test");
    });

    it("answers a spec that does not validate with its errors, not a crash", async () => {
      writeFileSync(join(dir, "agent.yaml"), "version: '1.0'\nagent: {}\n");
      const server = await start({ env });
      const res = await server.inject({ method: "POST", url: "/api/doctor", payload: {} });
      expect(res.statusCode).toBe(422);
      expect(res.json().success).toBe(false);
    });
  });
});
