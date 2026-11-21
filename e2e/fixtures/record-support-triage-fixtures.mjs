// Regenerates packages/cli/templates/support-triage/fixtures (KAM-126). The fixtures are what
// `kampong run --tools record` writes, taken against a scripted mailbox (the fake imapflow) and a stand-in model,
// not captured from a live account. To record from a real mailbox instead, run the template with
// `--tools record` and your own credentials (see the template's README).
//
// One scenario only: a fixture is keyed by the op and its input, so two mailboxes would answer the same
// `list_unseen` differently. This one is an unsure ticket (KAM-283), so the recorded run stops at the approval
// step and a replay shows it: the first thing a person sees is the trust feature. The confident, rejected and
// empty-inbox cases are covered against scripted mailboxes in e2e/support-triage-template.test.ts.
//
//   npm run build && node e2e/fixtures/record-support-triage-fixtures.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "../../packages/cli/templates/support-triage");
const fixtures = join(template, "fixtures");

register("./support-triage-imap-loader.mjs", import.meta.url);
const { UNSURE } = await import("./support-triage-scenarios.mjs");
const { fakeModel } = await import("./support-triage-model.mjs");
const { runCli } = await import("../../packages/cli/dist/cli.js");
const { createModelFixtures } = await import("../../packages/engine/dist/index.js");

const dir = mkdtempSync(join(tmpdir(), "kampong-record-support-triage-"));
const scenario = join(dir, "scenario.json");
writeFileSync(scenario, JSON.stringify(UNSURE));
Object.assign(process.env, {
  KAMPONG_FAKE_IMAP: scenario,
  GMAIL_ADDRESS: UNSURE.user,
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
      // The recorded run waits for a person; nobody is at this terminal, so approve it to record the draft too.
      "--approve-all",
    ],
    io,
    {
      // The stand-in's answers are filed as model fixtures (KAM-156), so a replay needs no model at all.
      model: createModelFixtures({
        mode: "record",
        fixturesDir: fixtures,
        inner: fakeModel,
        // The mailbox address is a secret slot, redacted from the tool fixtures; a prompt that carries it is too.
        secrets: [UNSURE.user],
      }),
    },
  );
  if (code !== 0) throw new Error(`recording run failed with exit code ${code}`);
  // The repo's format check covers these files, so leave them in the repo's format.
  execFileSync("npx", ["prettier", "--write", fixtures], { stdio: "ignore" });
  console.error(`recorded into ${fixtures}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
