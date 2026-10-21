import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec, specWarnings } from "@kampong/spec";
import { EXIT_SUCCESS, EXIT_USAGE_ERROR, runCli } from "../../src/cli.js";
import { capture } from "../unit/test-helpers.js";

// KAM-126: the support-triage template, spec-only, runs offline on its recorded fixtures. Nothing here touches
// the network, a mailbox or a credential; the model's answer replays from a recorded
// fixture too (KAM-156). The
// full behaviour (an unsure email, a rejection, a restart with an approval pending, an exported project) is in
// e2e/support-triage-template.test.ts; this is the fast check that the shipped template and fixtures agree.

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/support-triage/", import.meta.url));
const SPEC_PATH = `${TEMPLATE_DIR}agent.yaml`;
const FIXTURES = `${TEMPLATE_DIR}fixtures`;

describe("the support-triage template", () => {
  beforeEach(() => {
    // No mailbox credentials and no network: replay needs neither.
    vi.stubEnv("GMAIL_ADDRESS", "");
    vi.stubEnv("GMAIL_APP_PASSWORD", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("the offline template test reached the network");
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is a valid version 1.1 spec with no warnings, and writes no literal secret", () => {
    const source = readFileSync(SPEC_PATH, "utf8");
    const parsed = parseSpec(source);
    expect(parsed.errors).toEqual([]);
    expect(specWarnings(parsed.spec!)).toEqual([]);
    expect(parsed.spec!.version).toBe("1.1");
    expect(source).not.toMatch(/xoxb-|app[ _-]?password:\s*\S/i);
  });

  it("replays the recorded confident ticket to a saved draft: no approval, the model answered from its fixture, nothing sent", async () => {
    const { io, out, err } = capture();
    const code = await runCli(
      ["run", SPEC_PATH, "--input", "", "--json", "--tools", "replay", "--fixtures", FIXTURES],
      io,
    );
    expect(code, out.join("\n") + err.join("\n")).toBe(EXIT_SUCCESS);
    const outcome = JSON.parse(out.join("\n")) as {
      status: string;
      output: Record<
        string,
        { taken?: string; uid?: number; mailbox?: string; confidence?: number }
      >;
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.output.decide!.taken).toBe("then");
    expect(outcome.output.triage!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(outcome.output.claim).toMatchObject({ ok: true, uid: 5 });
    expect(outcome.output.draft_confident).toMatchObject({ mailbox: "[Gmail]/Drafts", uid: 101 });
    expect(outcome.output).not.toHaveProperty("review");
    // The recorded answer is keyed on the whole prompt, so a hit means the email reached the model as data
    // and the FAQ rode in the system prompt, exactly as recorded.
  });

  it("kampong doctor finds a recorded fixture for every Gmail operation the spec calls", async () => {
    const { io, out, err } = capture();
    const code = await runCli(
      ["doctor", SPEC_PATH, "--tools", "replay", "--fixtures", FIXTURES],
      io,
    );
    expect(code, out.join("\n") + err.join("\n")).toBe(EXIT_SUCCESS);
    const text = out.join("\n");
    for (const tool of ["list_unread", "read_message", "mark_read", "save_draft"]) {
      expect(text, tool).toContain(`tool ${tool} has a recorded fixture`);
    }
    expect(text).toMatch(/recorded model answer\(s\)/);
  });

  it("is listed by kampong templates, with its description and folder", async () => {
    const plain = capture();
    expect(await runCli(["templates"], plain.io)).toBe(EXIT_SUCCESS);
    expect(plain.out.join("\n")).toMatch(/support-triage\s+.*customer email/);

    const json = capture();
    expect(await runCli(["templates", "--json"], json.io)).toBe(EXIT_SUCCESS);
    const list = JSON.parse(json.out.join("\n")) as {
      name: string;
      description: string;
      path: string;
    }[];
    const entry = list.find((t) => t.name === "support-triage");
    expect(entry).toMatchObject({ description: expect.stringContaining("customer email") });
    expect(readFileSync(`${entry!.path}/agent.yaml`, "utf8")).toBe(readFileSync(SPEC_PATH, "utf8"));
    expect(await runCli(["templates", "--nope"], capture().io)).toBe(EXIT_USAGE_ERROR);
  });
});
