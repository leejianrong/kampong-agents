import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createFirstPartyRegistry, InProcessModuleRunner, invokeOp } from "@kampong/engine";

// KAM-126: the live smoke test for support-triage, behind real credentials. It is skipped unless you opt in:
//
//   KAMPONG_LIVE_SMOKE=1 GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD=... \
//     npx vitest run --project e2e e2e/support-triage-live.test.ts
//
// It is read-only. It signs in to Gmail with the app password (the doctor probe) and lists unread mail twice;
// it reads no message, marks nothing read and writes no draft. The model and Slack are not touched. A full live
// run is manual: `kampong serve` the template (see its README).

const live =
  process.env.KAMPONG_LIVE_SMOKE === "1" &&
  Boolean(process.env.GMAIL_ADDRESS) &&
  Boolean(process.env.GMAIL_APP_PASSWORD);

const CLI = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));
const TEMPLATE = fileURLToPath(
  new URL("../packages/cli/templates/support-triage/agent.yaml", import.meta.url),
);

describe.skipIf(!live)("support-triage live smoke (real Gmail, read-only)", () => {
  it("the doctor probe signs in with the app password, and imap.gmail.com:993 is reachable", async () => {
    // doctor exits non-zero for anything that would stop a run (the local model not running, say), which this
    // test is not about, so read its report rather than the exit code.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CLI, "doctor", TEMPLATE, "--online", "--probe", "--json"],
      { env: process.env },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    const report = JSON.parse(stdout.split("\n").find((l) => l.trim().startsWith("{"))!) as {
      checks: { status: string; area: string; message: string }[];
    };
    const imap = report.checks.filter(
      (c) => c.message.includes("gmail-imap") || c.message.includes("imap.gmail.com"),
    );
    expect(
      imap.some((c) => c.message.includes("was accepted")),
      JSON.stringify(imap),
    ).toBe(true);
    expect(imap.some((c) => c.message.includes("imap.gmail.com:993 is reachable"))).toBe(true);
    expect(
      imap.filter((c) => c.status === "fail"),
      JSON.stringify(imap),
    ).toEqual([]);
  }, 60_000);

  it("lists unread mail without marking any of it read", async () => {
    const registry = createFirstPartyRegistry();
    const { manifest } = await registry.resolve("kampong/gmail-imap", "1.0.0");
    const list = () =>
      invokeOp(
        manifest,
        "list_unseen",
        { limit: 3 },
        { runner: new InProcessModuleRunner(registry) },
      ) as Promise<{ count: number; messages: unknown[] }>;
    const first = await list();
    expect(typeof first.count).toBe("number");
    expect(first.messages.length).toBeLessThanOrEqual(3);
    // If listing marked anything read, the second count would be lower. (New mail can only raise it.)
    expect((await list()).count).toBeGreaterThanOrEqual(first.count);
  }, 60_000);
});
