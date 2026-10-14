// `node --import` preload for the support-triage tests (KAM-126): swaps in the fake imapflow, and answers Slack
// from a fake so a paused `kampong serve` can post its approval buttons with no network. It works for
// `kampong run`, `kampong serve` and an exported project alike. The model is a local fake Ollama server, which
// is reached as usual.
//
// KAMPONG_FAKE_SLACK_LOG names a file that receives one JSON line per Slack request (url and body, never the
// token), so a test can read the approval message that was posted.
import { appendFileSync } from "node:fs";
import { register } from "node:module";

register("./support-triage-imap-loader.mjs", import.meta.url);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  if (url.hostname !== "slack.com") return realFetch(input, init);
  if (process.env.KAMPONG_FAKE_SLACK_LOG) {
    appendFileSync(
      process.env.KAMPONG_FAKE_SLACK_LOG,
      `${JSON.stringify({ url: url.href, body: typeof init?.body === "string" ? init.body : undefined })}\n`,
    );
  }
  return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1700000000.000100" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
