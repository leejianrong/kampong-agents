// Regenerates packages/cli/templates/support-triage/fixtures (KAM-126). The fixtures are what
// `kampong run --tools record` writes, taken against a scripted mailbox (the fake imapflow) and a stand-in model,
// not captured from a live account. To record from a real mailbox instead, run the template with
// `--tools record` and your own credentials (see the template's README).
//
// One scenario only: a fixture is keyed by the op and its input, so two mailboxes would answer the same
// `list_unseen` differently. This one is a confident ticket, so the draft is saved without an approval.
//
//   npm run build && node e2e/fixtures/record-support-triage-fixtures.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "../../packages/cli/templates/support-triage");
const fixtures = join(template, "fixtures");

register("./support-triage-imap-loader.mjs", import.meta.url);
const { CONFIDENT } = await import("./support-triage-scenarios.mjs");
const { fakeModel } = await import("./support-triage-model.mjs");
const { runCli } = await import("../../packages/cli/dist/cli.js");

const dir = mkdtempSync(join(tmpdir(), "kampong-record-support-triage-"));
const scenario = join(dir, "scenario.json");
writeFileSync(scenario, JSON.stringify(CONFIDENT));
Object.assign(process.env, {
  KAMPONG_FAKE_IMAP: scenario,
  GMAIL_ADDRESS: CONFIDENT.user,
  GMAIL_APP_PASSWORD: "fake-app-password",
  SLACK_BOT_TOKEN: "xoxb-fake-slack-token",
});

rmSync(fixtures, { recursive: true, force: true });
const io = {
  stdout: (line) => process.env.DEBUG_RECORD && console.error(line),
  stderr: console.error,
  stdin: process.stdin,
};
try {
  const code = await runCli(
    [
      "run",
      join(template, "agent.yaml"),
      "--input",
      "",
      "--json",
      "--tools",
      "record",
      "--fixtures",
      fixtures,
    ],
    io,
    { model: fakeModel },
  );
  if (code !== 0) throw new Error(`recording run failed with exit code ${code}`);
  console.error(`recorded into ${fixtures}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
