import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "@kampong/spec";
import { createFirstPartyRegistry } from "@kampong/engine";
import { exportProject, type ExportComponent } from "@kampong/exporter";
// @ts-expect-error plain .mjs fakes shared with the fixture recorder; no type declarations
import { decide } from "./fixtures/support-triage-model.mjs";
// @ts-expect-error plain .mjs scenarios shared with the fixture recorder; no type declarations
import { CONFIDENT, UNSURE, EMPTY, USER } from "./fixtures/support-triage-scenarios.mjs";

// KAM-126: the support-triage template, end to end and offline. The real kampong/gmail-imap module runs
// against a scripted mailbox (a loader hook swaps `imapflow` for a fake), the model is a local fake Ollama
// server, and Slack is answered by a fake in the preload. Every run is a separate process, as in real use:
// `kampong run`, `kampong serve` (killed and restarted with an approval pending) and an exported project.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/dist/cli.js");
const TEMPLATE_DIR = join(ROOT, "packages/cli/templates/support-triage");
const TEMPLATE = readFileSync(join(TEMPLATE_DIR, "agent.yaml"), "utf8");
const PRELOAD = fileURLToPath(new URL("./fixtures/support-triage-preload.mjs", import.meta.url));

const SECRETS = {
  GMAIL_ADDRESS: USER as string,
  GMAIL_APP_PASSWORD: "e2e-app-password-1234",
  SLACK_BOT_TOKEN: "xoxb-e2e-slack-token",
  SLACK_SIGNING_SECRET: "e2e-signing-secret",
};

interface Op {
  op: string;
  [key: string]: unknown;
}
interface Outcome {
  success: boolean;
  status: string;
  output?: Record<string, unknown>;
  skipped?: { step: string; reason: string };
  error?: string;
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
        // Only the email (the user message) decides; the system prompt carries the FAQ and the rules.
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

interface Finished {
  stdout: string;
  stderr: string;
  code: number;
}

function spawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
): { child: ChildProcess; finished: Promise<Finished> } {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: process.platform === "win32",
  });
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

describe("support-triage template (KAM-126)", () => {
  let ollama: Awaited<ReturnType<typeof startFakeOllama>>;
  let dir: string;
  let spec: string;
  let n = 0;

  beforeEach(async () => {
    ollama = await startFakeOllama();
    dir = mkdtempSync(join(tmpdir(), "kampong-e2e-support-triage-"));
    spec = join(dir, "agent.yaml");
    const source = TEMPLATE.replace(
      "    provider: ollama\n    name: llama3.1\n",
      `    provider: ollama\n    name: llama3.1\n    base_url: "http://127.0.0.1:${ollama.port}"\n`,
    );
    expect(source).not.toBe(TEMPLATE);
    writeFileSync(spec, source);
  });
  afterEach(async () => {
    await ollama.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A mailbox scenario written to disk, and where that process's operations are logged. */
  function mailbox(scenario: unknown): {
    env: NodeJS.ProcessEnv;
    ops: () => Op[];
    slack: () => { url: string; body?: string }[];
  } {
    n += 1;
    const scenarioPath = join(dir, `scenario-${n}.json`);
    const logPath = join(dir, `ops-${n}.json`);
    const slackPath = join(dir, `slack-${n}.jsonl`);
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    return {
      env: {
        ...process.env,
        ...SECRETS,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${PRELOAD}`.trim(),
        KAMPONG_FAKE_IMAP: scenarioPath,
        KAMPONG_FAKE_IMAP_LOG: logPath,
        KAMPONG_FAKE_SLACK_LOG: slackPath,
      },
      ops: () => (existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as Op[]) : []),
      slack: () =>
        existsSync(slackPath)
          ? readFileSync(slackPath, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l) as { url: string; body?: string })
          : [],
    };
  }

  const runCli = (box: ReturnType<typeof mailbox>, extra: string[] = [], stdin?: string) =>
    spawnProcess(process.execPath, [CLI, "run", spec, "--input", "", "--json", ...extra], {
      cwd: dir,
      env: box.env,
      stdin,
    }).finished;

  const appended = (ops: Op[]) =>
    ops.filter((o) => o.op === "append") as (Op & { raw: string; path: string; flags: string[] })[];
  const flagged = (ops: Op[]) => ops.filter((o) => o.op === "flags");

  it("a confident email is saved as a threaded draft with no approval, and marked read", async () => {
    const box = mailbox(CONFIDENT);
    const done = await runCli(box); // no --approve-all and no stdin: an approval would reject the run
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toMatchObject({
      decide: { taken: "then" },
      triage: { category: "how_to", confidence: 0.94 },
    });
    expect(outcome.output).not.toHaveProperty("review");

    const ops = box.ops();
    const drafts = appended(ops);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ path: "[Gmail]/Drafts", flags: ["\\Draft"] });
    // Threaded under the original, addressed to its sender, never sent anywhere.
    expect(drafts[0]!.raw).toMatch(/^In-Reply-To: <orig-5@client\.example>$/m);
    expect(drafts[0]!.raw).toMatch(
      /^References: <earlier-0@client\.example> <orig-5@client\.example>$/m,
    );
    expect(drafts[0]!.raw).toMatch(/^Subject: Re: How do I reset my password\?$/m);
    expect(drafts[0]!.raw).toMatch(/^To: Ana Cruz <ana@client\.example>$/m);
    expect(flagged(ops)).toEqual([{ op: "flags", uid: 5, flags: ["\\Seen"] }]);
    // Only the one unread message was looked at; reading did not mark anything.
    // (read_message, and create_draft's own look at the original to thread the reply)
    const reads = ops.filter((o) => o.op === "fetch-source");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((o) => o.uid === 5)).toBe(true);
    expect(ops.filter((o) => o.op === "lock" && o.readOnly === false)).toHaveLength(1);
    expect(ollama.requests()).toBe(1);
    expect(done.stdout + done.stderr).not.toContain(SECRETS.GMAIL_APP_PASSWORD);
  });

  it("an unsure email waits for approval; approving saves the draft", async () => {
    const box = mailbox(UNSURE);
    const done = await runCli(box, [], "y\n");
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toMatchObject({
      decide: { taken: "else" },
      triage: { confidence: 0.35 },
    });
    expect(appended(box.ops())).toHaveLength(1);
    expect(appended(box.ops())[0]!.raw).toMatch(/^In-Reply-To: <orig-8@client\.example>$/m);
  });

  it("rejecting writes no draft, and the message stays marked read so it does not come back", async () => {
    const box = mailbox(UNSURE);
    const done = await runCli(box, [], "n:not now\n");
    expect(done.code).toBe(2);
    expect(outcomeOf(done.stdout).status).toBe("rejected");
    const ops = box.ops();
    expect(appended(ops)).toEqual([]);
    expect(flagged(ops)).toEqual([{ op: "flags", uid: 8, flags: ["\\Seen"] }]);
  });

  it("with nothing unread it stops quietly without calling the model or touching the mailbox", async () => {
    const box = mailbox(EMPTY);
    const done = await runCli(box);
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.skipped).toMatchObject({ step: "idle", reason: "no unread mail" });
    expect(ollama.requests()).toBe(0);
    const ops = box.ops();
    expect(appended(ops)).toEqual([]);
    expect(flagged(ops)).toEqual([]);
  });

  it("replays its recorded fixtures with no mailbox, no credentials and no network", async () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const name of Object.keys(SECRETS)) delete env[name];
    const done = await spawnProcess(
      process.execPath,
      [
        CLI,
        "run",
        spec,
        "--input",
        "",
        "--json",
        "--tools",
        "replay",
        "--fixtures",
        join(TEMPLATE_DIR, "fixtures"),
      ],
      { cwd: dir, env },
    ).finished;
    expect(done.code, done.stderr).toBe(0);
    const outcome = outcomeOf(done.stdout);
    expect(outcome.status).toBe("completed");
    expect(outcome.output).toMatchObject({
      decide: { taken: "then" },
      draft_confident: { mailbox: "[Gmail]/Drafts", uid: 101 },
    });
  });

  it("an approval pending across a restart is still resolved by its key, and the draft is then saved", async () => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: (await response.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const waitUp = async () => {
      for (let i = 0; ; i++) {
        if (
          await fetch(`${base}/healthz`).then(
            (r) => r.ok,
            () => false,
          )
        )
          return;
        if (i > 150) throw new Error("kampong serve never came up");
        await sleep(200);
      }
    };
    const serve = (box: ReturnType<typeof mailbox>) =>
      spawnProcess(
        process.execPath,
        [CLI, "serve", spec, "--port", String(port), "--host", "127.0.0.1"],
        {
          cwd: dir,
          env: box.env,
        },
      );

    // First process: start a run, which pauses on the unsure email, then kill it without warning.
    let key: string | undefined;
    const first = mailbox(UNSURE);
    const one = serve(first);
    try {
      await waitUp();
      const started = await json("/schedule/run-now", { method: "POST" });
      expect(started.status).toBe(201);
      const runId = started.body.id as string;
      for (let i = 0; ; i++) {
        const state = (await json(`/runs/${runId}`)).body.state as { status: string };
        if (state.status === "awaiting_approval") break;
        if (i > 150) throw new Error(`the run never paused: ${JSON.stringify(state)}`);
        await sleep(200);
      }
      // The buttons went to Slack, with the draft in front of the approver.
      const posts = first.slack();
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toContain("kampong_approve");
      expect(posts[0]!.body).toContain("ben@client.example");
      expect(posts[0]!.body).toContain("A teammate will confirm your identity");
      const waiting = (await json("/approvals")).body.approvals as { key: string }[];
      expect(waiting).toHaveLength(1);
      key = waiting[0]!.key;
    } finally {
      one.child.kill("SIGKILL");
      await one.finished;
    }
    expect(appended(first.ops())).toEqual([]);

    // Second process on the same directory (the same .kampong/state.db): the approval is still there.
    const second = mailbox(UNSURE);
    const two = serve(second);
    try {
      await waitUp();
      const listed = (await json("/approvals")).body.approvals as { key: string }[];
      expect(listed.map((a) => a.key)).toEqual([key]);
      const resolved = await json(`/approvals/${key}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.state.status).toBe("completed");
      expect((await json("/approvals")).body.approvals).toEqual([]);
    } finally {
      two.child.kill("SIGKILL");
      await two.finished;
    }
    const drafts = appended(second.ops());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.raw).toMatch(/^In-Reply-To: <orig-8@client\.example>$/m);
    // The model was asked once, by the first process; the resumed run did not ask again.
    expect(ollama.requests()).toBe(1);
  }, 120_000);

  it("an exported project behaves exactly like the engine: same outcome, same mailbox operations", async () => {
    const parsed = parseSpec(readFileSync(spec, "utf8"));
    expect(parsed.success, JSON.stringify(parsed.errors)).toBe(true);
    const registry = createFirstPartyRegistry();
    const resolved = await registry.resolve("kampong/gmail-imap", "1.0.0");
    const components: ExportComponent[] = [
      {
        manifest: resolved.manifest,
        digest: resolved.digest,
        files: Object.fromEntries(resolved.files ?? []),
      },
    ];
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    exportProject(parsed.spec!, exportDir, { components });
    const install = await spawnProcess("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: exportDir,
      env: process.env,
    }).finished;
    expect(install.code, `npm install failed:\n${install.stdout}\n${install.stderr}`).toBe(0);
    const typecheck = await spawnProcess("npm", ["run", "typecheck"], {
      cwd: exportDir,
      env: process.env,
    }).finished;
    expect(typecheck.code, `typecheck failed:\n${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);

    for (const [name, scenario, extra, stdin] of [
      ["confident", CONFIDENT, [], ""],
      ["unsure, approved", UNSURE, [], "y\n"],
      ["unsure, rejected", UNSURE, [], "n:no\n"],
      ["nothing unread", EMPTY, [], ""],
    ] as [string, unknown, string[], string][]) {
      const engineBox = mailbox(scenario);
      const engine = await runCli(engineBox, extra, stdin);
      const exportBox = mailbox(scenario);
      const exported = await spawnProcess(
        "npm",
        ["start", "--silent", "--", "--input", "", "--json", ...extra],
        { cwd: exportDir, env: exportBox.env, stdin },
      ).finished;
      expect(exported.code, `${name}: ${exported.stderr}`).toBe(engine.code);
      const a = outcomeOf(engine.stdout);
      const b = outcomeOf(exported.stdout);
      // The draft's own Message-ID is random per run; everything else must match.
      const scrub = (o: Outcome) =>
        JSON.parse(JSON.stringify(o).replace(/<[0-9a-f-]{36}@[^>]*>/g, "<id>")) as Outcome;
      expect(scrub(b), name).toEqual(scrub(a));
      expect(exportBox.ops(), name).toEqual(engineBox.ops());
    }
  }, 360_000);
});
