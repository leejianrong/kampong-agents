import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs fakes shared with the fixture recorder; no type declarations
import { decide } from "./fixtures/webhook-triage-model.mjs";
// @ts-expect-error plain .mjs scenarios shared with the fixture recorder; no type declarations
import { CRITICAL, NOISY } from "./fixtures/webhook-triage-scenarios.mjs";

// KAM-217: the webhook-triage template, end to end and offline. The model is a local fake Ollama server, and
// Slack is answered by a fake in a preload. Every run is a separate process, as in real use: `kampong run` (the
// replay, and live-shaped runs with an approval answered on stdin) and `kampong serve` receiving a webhook.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/dist/cli.js");
const TEMPLATE_DIR = join(ROOT, "packages/cli/templates/webhook-triage");
const TEMPLATE = readFileSync(join(TEMPLATE_DIR, "agent.yaml"), "utf8");
const PRELOAD = fileURLToPath(new URL("./fixtures/webhook-triage-preload.mjs", import.meta.url));

const SECRETS = {
  SLACK_BOT_TOKEN: "xoxb-e2e-slack-token",
  ALERT_WEBHOOK_TOKEN: "e2e-webhook-bearer-token",
};

interface Outcome {
  success: boolean;
  status: string;
  output?: Record<string, unknown>;
  skipped?: { step: string; reason: string };
}
interface Finished {
  stdout: string;
  stderr: string;
  code: number;
}

function startFakeOllama(): Promise<{
  port: number;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.includes("/chat/completions")) {
        count += 1;
        const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] })
          .messages;
        const user = [...messages].reverse().find((m) => m.role === "user");
        const text =
          typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            created: 1_700_000_000,
            model: "llama3.1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(decide(text)) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({
        port: typeof address === "object" && address ? address.port : 0,
        requests: () => count,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function spawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): { child: ChildProcess; finished: Promise<Finished> } {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin?.end(options.stdin ?? "");
  const finished = new Promise<Finished>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }));
  });
  return { child, finished };
}

const outcomeOf = (stdout: string): Outcome => {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  expect(line, `expected one JSON line on stdout, got:\n${stdout}`).toBeDefined();
  return JSON.parse(line!) as Outcome;
};

describe("webhook-triage template (KAM-217)", () => {
  let ollama: Awaited<ReturnType<typeof startFakeOllama>>;
  let dir: string;
  let spec: string;
  let slackLog: string;
  let env: NodeJS.ProcessEnv;

  const slackPosts = () =>
    existsSync(slackLog)
      ? readFileSync(slackLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { url: string; body?: string })
      : [];
  const messagePosts = () => slackPosts().filter((p) => p.url.endsWith("/chat.postMessage"));

  beforeEach(async () => {
    ollama = await startFakeOllama();
    dir = mkdtempSync(join(tmpdir(), "kampong-e2e-webhook-triage-"));
    spec = join(dir, "agent.yaml");
    slackLog = join(dir, "slack.jsonl");
    const source = TEMPLATE.replace(
      "    provider: ollama\n    name: llama3.1\n",
      `    provider: ollama\n    name: llama3.1\n    base_url: "http://127.0.0.1:${ollama.port}"\n`,
    );
    expect(source).not.toBe(TEMPLATE);
    writeFileSync(spec, source);
    env = {
      ...process.env,
      ...SECRETS,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${PRELOAD}`.trim(),
      KAMPONG_FAKE_SLACK_LOG: slackLog,
    };
  });
  afterEach(async () => {
    await ollama.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runCli = (alert: unknown, extra: string[] = [], stdin?: string) =>
    spawnProcess(
      process.execPath,
      [CLI, "run", spec, "--input", JSON.stringify(alert), "--json", ...extra],
      {
        cwd: dir,
        env,
        stdin,
      },
    ).finished;

  it("a critical alert pauses for approval; approving posts the model's message to Slack", async () => {
    const done = await runCli(CRITICAL, [], "y\n");
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toMatchObject({
      triage: { decision: "post", severity: "critical" },
      decide: { taken: "then" },
      review: { approved: true },
      post: { ok: true },
    });
    const posts = messagePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toContain("Checkout is failing 38% of payments");
    expect(posts[0]!.body).toContain("#oncall");
    expect(done.stdout + done.stderr).not.toContain(SECRETS.SLACK_BOT_TOKEN);
  });

  it("rejecting posts nothing to Slack", async () => {
    const done = await runCli(CRITICAL, [], "n:not worth waking anyone\n");
    expect(done.code).toBe(2);
    expect(outcomeOf(done.stdout).status).toBe("rejected");
    expect(messagePosts()).toEqual([]);
  });

  it("a noisy alert stops quietly: no approval is asked and nothing is posted", async () => {
    const done = await runCli(NOISY);
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.skipped).toMatchObject({ step: "quiet" });
    expect(outcome.output).not.toHaveProperty("review");
    expect(messagePosts()).toEqual([]);
    expect(ollama.requests()).toBe(1);
  });

  it("replays its recorded fixtures with no model, no credentials and no network", async () => {
    const bare = { ...process.env } as NodeJS.ProcessEnv;
    for (const name of Object.keys(SECRETS)) delete bare[name];
    const replay = (alert: unknown) =>
      spawnProcess(
        process.execPath,
        [
          CLI,
          "run",
          join(TEMPLATE_DIR, "agent.yaml"),
          "--input",
          JSON.stringify(alert),
          "--json",
          "--tools",
          "replay",
          "--fixtures",
          join(TEMPLATE_DIR, "fixtures"),
          "--approve-all",
        ],
        { cwd: dir, env: bare },
      ).finished;
    const posted = await replay(CRITICAL);
    expect(posted.code, posted.stderr).toBe(0);
    expect(outcomeOf(posted.stdout).output).toMatchObject({
      review: { approved: true },
      post: { ok: true, channel: "C0ONCALXX" },
    });
    const skipped = await replay(NOISY);
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(outcomeOf(skipped.stdout).skipped).toMatchObject({ step: "quiet" });
  });

  it("a webhook needs the bearer token; a resolved alert is ignored; a firing one waits for approval and then posts", async () => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: (await response.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const post = (body: unknown, token?: string) =>
      json("/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });

    const serve = spawnProcess(
      process.execPath,
      [CLI, "serve", spec, "--port", String(port), "--host", "127.0.0.1"],
      { cwd: dir, env },
    );
    try {
      for (let i = 0; ; i++) {
        if (
          await fetch(`${base}/healthz`).then(
            (r) => r.ok,
            () => false,
          )
        )
          break;
        if (i > 150) throw new Error("kampong serve never came up");
        await sleep(200);
      }

      expect((await post(CRITICAL)).status).toBe(401);
      expect((await post(CRITICAL, "wrong-token")).status).toBe(401);
      expect(ollama.requests()).toBe(0);

      const resolved = await post({ ...CRITICAL, status: "resolved" }, SECRETS.ALERT_WEBHOOK_TOKEN);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ success: true, ignored: true });
      expect(ollama.requests()).toBe(0);

      const started = await post(CRITICAL, SECRETS.ALERT_WEBHOOK_TOKEN);
      expect(started.status).toBe(201);
      const runId = started.body.id as string;
      for (let i = 0; ; i++) {
        const state = (await json(`/runs/${runId}`)).body.state as { status: string };
        if (state.status === "awaiting_approval") break;
        if (i > 150) throw new Error(`the run never paused: ${JSON.stringify(state)}`);
        await sleep(200);
      }
      // Paused: the approval buttons went to Slack, and the alert itself has not.
      const before = slackPosts();
      expect(before).toHaveLength(1);
      expect(before[0]!.body).toContain("kampong_approve");
      expect(before[0]!.body).toContain("#oncall-approvals");
      expect(before[0]!.body).not.toContain('"channel":"#oncall"');

      const approved = await json(`/runs/${runId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.state.status).toBe("completed");
      const alerts = messagePosts().filter((p) => p.body?.includes('"channel":"#oncall"'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.body).toContain("Checkout is failing 38% of payments");
    } finally {
      serve.child.kill("SIGKILL");
      await serve.finished;
    }
  }, 120_000);
});
