// Regenerates packages/cli/templates/webhook-triage/fixtures (KAM-217). The fixtures are what
// `kampong run --tools record` writes, taken against a stand-in model and a fake Slack, not captured from a
// live workspace. To record from the real services instead, run the template with `--tools record`, a model and
// a Slack bot token (see the template's README).
//
//   npm run build && node e2e/fixtures/record-webhook-triage-fixtures.mjs
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModelFixtures } from "../../packages/engine/dist/index.js";
import { runCli } from "../../packages/cli/dist/cli.js";
import { CRITICAL, NOISY } from "./webhook-triage-scenarios.mjs";
import { fakeModel } from "./webhook-triage-model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "../../packages/cli/templates/webhook-triage");
const fixtures = join(template, "fixtures");

// Slack answers a post with { ok, channel, ts }; this is all the template calls.
globalThis.fetch = async (url) => {
  if (String(url) !== "https://slack.com/api/chat.postMessage") {
    throw new Error(`fake network: unexpected request to ${url}`);
  }
  return new Response(JSON.stringify({ ok: true, channel: "C0ONCALXX", ts: "1760000000.000100" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
Object.assign(process.env, { SLACK_BOT_TOKEN: "xoxb-fake-slack-token" });

rmSync(fixtures, { recursive: true, force: true });
const io = {
  stdout: (line) => process.env.DEBUG_RECORD && console.error(line),
  stderr: console.error,
  stdin: process.stdin,
};
for (const alert of [CRITICAL, NOISY]) {
  const code = await runCli(
    [
      "run",
      join(template, "agent.yaml"),
      "--input",
      JSON.stringify(alert),
      "--json",
      "--tools",
      "record",
      "--fixtures",
      fixtures,
      "--approve-all",
    ],
    io,
    {
      // The stand-in's answers are filed as model fixtures (KAM-156), so a replay needs no model at all.
      model: createModelFixtures({ mode: "record", fixturesDir: fixtures, inner: fakeModel }),
    },
  );
  if (code !== 0) throw new Error(`recording run failed with exit code ${code}`);
}
console.error(`recorded into ${fixtures}`);
