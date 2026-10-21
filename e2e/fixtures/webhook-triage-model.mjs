// A deterministic stand-in for the model behind the webhook-triage `triage` step (KAM-217). It reads the alert
// name out of the prompt, so each sample alert gets its own decision. Used to record the template's model
// fixtures, and behind a fake Ollama server where a separate process needs a model.
import { DECISIONS } from "./webhook-triage-scenarios.mjs";

export function decide(prompt) {
  const name = Object.keys(DECISIONS).find((n) => prompt.includes(`Alert group: ${n}`));
  if (name === undefined) throw new Error(`fake model: unexpected prompt: ${prompt}`);
  return DECISIONS[name];
}

export const fakeModel = {
  async generateText() {
    return "ok";
  },
  async generateStructured({ prompt }) {
    return decide(prompt);
  },
};
