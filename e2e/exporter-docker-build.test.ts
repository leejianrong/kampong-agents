import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import { createAgentRun, type RunState } from "@kampong/engine";
import { exportProject } from "@kampong/exporter";

// KAN-1435 (ADR-0021/ADR-0022, "Slice C2"): the exported project's Dockerfile
// is the self-host deploy path's actual acceptance criterion -- "deployable
// = a container image" only means something if the image really builds and
// serves the webhook. This test found the bug that motivated the exact
// (non-caret) dependency pins in package-json.ts: with caret ranges, a fresh
// `npm install` inside the Docker build stage resolved a newer
// `@mastra/core`/`ai`/`@ai-sdk/*` combination than this repo's own lockfile,
// which broke `tsc` (a `MastraModelConfig`/`LanguageModelV4` type mismatch)
// -- invisible via the existing exporter-behavioral-equivalence.test.ts
// because that test only runs `npm start` (tsx transpiles without
// type-checking), never `npm run build`. Keeping this test is what would
// catch a future re-introduction of that exact regression.
//
// Same "actually run it, don't just inspect file contents" philosophy as
// exporter-behavioral-equivalence.test.ts (SLICES.md's Testing approach),
// extended to the container path: build the real image, run the real
// container, hit its real HTTP endpoints, and diff the outcome against a
// direct packages/engine reference run.
//
// Skips (rather than fails) when the `docker` CLI isn't available -- e.g. a
// contributor's machine without Docker installed -- exactly like the
// server-integration suites' `skipIf(!DATABASE_URL)` pattern. CI's e2e job
// runs on `ubuntu-latest`, which ships Docker, so this runs for real there.

const execFileAsync = promisify(execFile);

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = dockerAvailable();

interface FakeServer {
  port: number;
  requests: number;
  close: () => Promise<void>;
}

function startFakeOllamaServer(replyText: string): Promise<FakeServer> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-docker-e2e",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "llama3.1",
          choices: [
            { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolvePromise) => {
    // Bind every interface -- the container reaches this via
    // host.docker.internal, not 127.0.0.1 (which inside the container means
    // the container itself).
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({
        port,
        get requests() {
          return requests;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startFakeToolServer(status: string): Promise<FakeServer> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status }));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePromise({
        port,
        get requests() {
          return requests;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// `host` differs by caller: the in-process reference run (this test process
// itself) reaches the fake servers via "127.0.0.1"; the containerized run
// reaches the *same* host-bound fake servers via "host.docker.internal"
// (Docker's special DNS name for the host, wired up by `--add-host
// host.docker.internal:host-gateway` below) -- "127.0.0.1" from inside the
// container would mean the container itself.
function buildFixtureSpec(host: string, ollamaPort: number, toolPort: number): string {
  return `version: "1.0"
agent:
  id: e2e-docker-charge-agent
  name: "E2E Docker Charge Agent"
  role: "Support"
  goal: "Look up a charge status."
  trigger:
    type: webhook
  model:
    provider: ollama
    name: llama3.1
    base_url: "http://${host}:${ollamaPort}"
  tools:
    - name: check_charge
      action: http_request
      method: GET
      url: "http://${host}:${toolPort}/charges/{input}"
      extract: "status"
  workflow:
    - step: parse
      action: extract_entities
    - step: decide
      type: condition
      if: "parse.eligible == true"
      then: "x"
      else: "execute_tool(check_charge)"
`;
}

const FIXED_INPUT = "Check charge off-docker-e2e-42";
const OLLAMA_REPLY_TEXT = "parsed: no eligibility signal found";
const TOOL_STATUS = "succeeded";

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe.skipIf(!DOCKER_AVAILABLE)(
  "exported project's Dockerfile builds a real, runnable webhook service (KAN-1435, ADR-0022)",
  () => {
    let ollama: FakeServer;
    let tool: FakeServer;
    let exportDir: string;
    let imageTag: string;
    let containerId: string | undefined;
    let hostPort: number;

    beforeAll(() => {
      if (!DOCKER_AVAILABLE) {
        console.warn("docker CLI not found -- skipping exporter-docker-build.test.ts");
      }
    });

    afterEach(async () => {
      if (containerId) {
        await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => {});
        containerId = undefined;
      }
      if (imageTag) {
        await execFileAsync("docker", ["rmi", "-f", imageTag]).catch(() => {});
      }
      await ollama?.close();
      await tool?.close();
      if (exportDir) rmSync(exportDir, { recursive: true, force: true });
    });

    it("docker build + docker run serves /healthz and /webhook, matching a direct engine run", async () => {
      ollama = await startFakeOllamaServer(OLLAMA_REPLY_TEXT);
      tool = await startFakeToolServer(TOOL_STATUS);
      exportDir = mkdtempSync(join(tmpdir(), "kampong-e2e-docker-export-"));
      imageTag = `kampong-e2e-docker-${randomUUID()}`;

      // --- Reference: a direct packages/engine run (this process) against
      // the fakes via 127.0.0.1.
      const { success, spec: referenceSpec } = parseSpec(
        buildFixtureSpec("127.0.0.1", ollama.port, tool.port),
      );
      expect(success).toBe(true);
      const referenceRun = createAgentRun(referenceSpec!);
      const referenceState = await referenceRun.start(FIXED_INPUT);
      expect(referenceState.status).toBe("completed");
      expect(referenceState.finalOutput?.decide).toBe(TOOL_STATUS);

      // --- Export the host.docker.internal-addressed variant, then
      // actually build the container image from it.
      const { spec: dockerSpec } = parseSpec(
        buildFixtureSpec("host.docker.internal", ollama.port, tool.port),
      );
      const exportResult = exportProject(dockerSpec!, exportDir);
      expect(exportResult.files).toContain("Dockerfile");

      await execFileAsync("docker", ["build", "-t", imageTag, exportDir], {
        maxBuffer: 32 * 1024 * 1024,
      });

      // --- Run it: host.docker.internal:host-gateway lets the container
      // reach the two fake servers bound on the host (Docker Engine
      // >=20.10, the version CI's ubuntu-latest runners ship).
      const { stdout } = await execFileAsync("docker", [
        "run",
        "-d",
        "--add-host",
        "host.docker.internal:host-gateway",
        "-P",
        imageTag,
      ]);
      containerId = stdout.trim();

      const { stdout: portOutput } = await execFileAsync("docker", [
        "port",
        containerId,
        "8080/tcp",
      ]);
      // e.g. "0.0.0.0:54321\n"
      hostPort = Number(portOutput.trim().split(":").pop());
      expect(Number.isInteger(hostPort)).toBe(true);

      const baseUrl = `http://127.0.0.1:${hostPort}`;

      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/healthz`);
        return res.ok;
      }, 30_000);

      const webhookResponse = await fetch(`${baseUrl}/webhook`, {
        method: "POST",
        body: FIXED_INPUT,
      });
      expect(webhookResponse.status).toBe(201);
      const { id } = (await webhookResponse.json()) as { id: string };
      expect(id).toBeTruthy();

      let finalState: RunState | undefined;
      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/runs/${id}`);
        if (!res.ok) return false;
        const body = (await res.json()) as { state: RunState };
        finalState = body.state;
        return body.state.status !== "running";
      }, 30_000);

      expect(finalState?.status).toBe("completed");
      expect(finalState?.finalOutput?.decide).toBe(TOOL_STATUS);

      // Both the reference run and the containerized run genuinely reached
      // the fake servers once each.
      expect(ollama.requests).toBe(2);
      expect(tool.requests).toBe(2);
    });
  },
);
