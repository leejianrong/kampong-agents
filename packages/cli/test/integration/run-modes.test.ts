import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDevServer } from "../../src/server.js";

// KAM-188: a test run from the canvas can replay the recorded fixtures (no keys, no network) or run live.
// `GET /api/run-options` says which modes the open spec has and what a live run would call; the
// `mode` on `POST /api/runs` picks one, and the response says which one ran.

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/market-etl/", import.meta.url));

const POST_SOURCE = `version: "1.0"
agent:
  id: notifier
  name: "Notifier"
  role: "Ops"
  goal: "Tell the team."
  tools:
    - name: ping
      action: http_request
      method: GET
      url: "https://status.example.test/ping"
    - name: announce
      action: http_request
      method: POST
      url: "https://hooks.example.test/announce"
      requires_approval: true
  workflow:
    - step: call_ping
      action: execute_tool(ping)
`;

describe("test run modes (KAM-188)", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-run-modes-"));
    // A replay must never reach the network or a key.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the replay reached the network");
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const server = (specPath: string) => {
    app = createDevServer({ specPath, layoutPath: join(dir, "layout.json"), run: { env: {} } });
    return app.ready();
  };

  const copyTemplate = () => {
    cpSync(join(TEMPLATE_DIR, "agent.yaml"), join(dir, "agent.yaml"));
    cpSync(join(TEMPLATE_DIR, "fixtures"), join(dir, "fixtures"), { recursive: true });
    return join(dir, "agent.yaml");
  };

  async function settled(id: string) {
    for (let i = 0; i < 400; i++) {
      const state = (await app.inject({ method: "GET", url: `/api/runs/${id}` })).json().state;
      if (state.status !== "running") return state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the run did not settle");
  }

  it("offers replay first, and by default, when fixtures exist beside the spec", async () => {
    await server(copyTemplate());
    const body = (await app.inject({ method: "GET", url: "/api/run-options" })).json();
    expect(body).toMatchObject({
      success: true,
      modes: ["replay", "live"],
      defaultMode: "replay",
      fixtures: { available: true, dir: expect.stringContaining("fixtures") },
      modelCalls: true,
    });
    const slack = body.tools.find((t: { describes: string }) => t.describes.includes("slack"));
    expect(slack).toMatchObject({ sideEffecting: true, recorded: true });
    const fetchQuote = body.tools.find((t: { describes: string }) =>
      t.describes.includes("alpha-vantage"),
    );
    expect(fetchQuote).toMatchObject({ effect: "read", sideEffecting: false });
  });

  it("offers only live, and says what it would call, when there are no fixtures", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, POST_SOURCE);
    await server(specPath);
    const body = (await app.inject({ method: "GET", url: "/api/run-options" })).json();
    expect(body).toMatchObject({
      modes: ["live"],
      defaultMode: "live",
      fixtures: { available: false, count: 0 },
      modelCalls: false,
    });
    expect(body.tools).toEqual([
      expect.objectContaining({
        name: "ping",
        describes: "GET https://status.example.test/ping",
        effect: "read",
        sideEffecting: false,
        recorded: false,
      }),
      expect.objectContaining({
        name: "announce",
        effect: "write",
        sideEffecting: true,
        requiresApproval: true,
      }),
    ]);
  });

  it("finds fixtures in .kampong/fixtures too", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, POST_SOURCE);
    mkdirSync(join(dir, ".kampong", "fixtures"), { recursive: true });
    writeFileSync(join(dir, ".kampong", "fixtures", "ping.abc.json"), "{}");
    await server(specPath);
    const body = (await app.inject({ method: "GET", url: "/api/run-options" })).json();
    expect(body.defaultMode).toBe("replay");
    expect(body.tools[0]).toMatchObject({ name: "ping", recorded: true });
  });

  it("replays the market-etl template with no keys and no network, and says it was a replay", async () => {
    await server(copyTemplate());
    const start = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { input: "", mode: "replay" },
    });
    expect(start.json()).toMatchObject({ success: true, mode: "replay" });
    const state = await settled(start.json().id);
    expect(state.status).toBe("completed");
    expect(state.finalOutput.report).toMatchObject({ loaded: expect.any(Number) });
    expect(state.finalOutput.each_symbol.count).toBe(3);
  });

  it("refuses a replay when there is nothing recorded", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, POST_SOURCE);
    await server(specPath);
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { input: "", mode: "replay" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      success: false,
      error: expect.stringContaining("fixtures"),
    });
  });

  it("rejects an unknown mode", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, POST_SOURCE);
    await server(specPath);
    const bad = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { input: "", mode: "dry" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
