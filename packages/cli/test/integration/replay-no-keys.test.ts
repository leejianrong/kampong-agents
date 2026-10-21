import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { EXIT_SUCCESS, runCli } from "../../src/cli.js";
import { createDevServer } from "../../src/server.js";
import { capture } from "../unit/test-helpers.js";

// KAM-233: a replay never needs a key. Every template runs on its recorded fixtures with an EMPTY
// environment (no Alpha Vantage, Supabase, Slack, mailbox, webhook or model credential), through both
// `kampong run --tools replay` and the dev server's `POST /api/runs` with `mode: "replay"`, and neither
// fails with "Environment variable ... is not set". A live run with a missing key still does (engine unit
// tests: replay-without-credentials.test.ts).

const templateDir = (name: string) =>
  fileURLToPath(new URL(`../../templates/${name}/`, import.meta.url));

const NOISY_ALERT = JSON.stringify({
  status: "firing",
  groupLabels: { alertname: "DiskUsageHigh" },
  alerts: [
    {
      status: "firing",
      labels: { alertname: "DiskUsageHigh", severity: "warning", service: "batch-runner" },
      annotations: { summary: "Disk usage is 78% and has been flapping around 75% all week." },
    },
  ],
});

const CASES = [
  { name: "market-etl", input: "" },
  { name: "support-triage", input: "" },
  { name: "webhook-triage", input: NOISY_ALERT },
] as const;

const NOT_SET = /is not set/i;

describe("replay needs no keys (KAM-233)", () => {
  let dir: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-replay-no-keys-"));
    // An empty environment: blank every variable but the ones the process needs to run at all.
    for (const name of Object.keys(process.env)) {
      if (!["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "NODE_OPTIONS"].includes(name)) {
        vi.stubEnv(name, "");
      }
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the replay reached the network");
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await app?.close();
    app = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function settled(id: string) {
    for (let i = 0; i < 600; i++) {
      const state = (await app!.inject({ method: "GET", url: `/api/runs/${id}` })).json().state;
      if (state.status !== "running") return state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the run did not settle");
  }

  for (const { name, input } of CASES) {
    it(`kampong run --tools replay completes ${name} with an empty environment`, async () => {
      const { io, out, err } = capture();
      const code = await runCli(
        [
          "run",
          `${templateDir(name)}agent.yaml`,
          "--input",
          input,
          "--json",
          "--tools",
          "replay",
          "--fixtures",
          `${templateDir(name)}fixtures`,
        ],
        io,
      );
      const text = out.join("\n") + err.join("\n");
      expect(text).not.toMatch(NOT_SET);
      expect(code, text).toBe(EXIT_SUCCESS);
      const outcome = JSON.parse(out.join("\n")) as {
        status: string;
        output: { each_symbol?: { errors: { item: string }[] }; report?: { failed: number } };
      };
      expect(outcome.status).toBe("completed");
      if (name === "market-etl") {
        // Only the deliberately recorded rate-limit answer for MSFT.
        expect(outcome.output.each_symbol!.errors.map((e) => e.item)).toEqual(["MSFT"]);
        expect(outcome.output.report!.failed).toBe(1);
      }
    });

    it(`the dev server replays ${name} with an empty environment`, async () => {
      cpSync(join(templateDir(name), "agent.yaml"), join(dir, "agent.yaml"));
      cpSync(join(templateDir(name), "fixtures"), join(dir, "fixtures"), { recursive: true });
      app = createDevServer({
        specPath: join(dir, "agent.yaml"),
        layoutPath: join(dir, "layout.json"),
        run: { env: {} },
      });
      await app.ready();
      const start = await app.inject({
        method: "POST",
        url: "/api/runs",
        payload: { input, mode: "replay" },
      });
      expect(start.json()).toMatchObject({ success: true, mode: "replay" });
      const state = await settled(start.json().id);
      expect(JSON.stringify(state)).not.toMatch(NOT_SET);
      expect(state.status).toBe("completed");
      if (name === "market-etl") {
        expect(state.finalOutput.each_symbol.errors.map((e: { item: string }) => e.item)).toEqual([
          "MSFT",
        ]);
        expect(state.finalOutput.report.failed).toBe(1);
      }
    });
  }
});
