// A deterministic stand-in for the model behind the support-triage `triage` step (KAM-126). It reads the email
// out of the prompt, so each scenario gets its own category, confidence and reply. No model fixtures exist yet
// (see the template README), so offline tests use this where the engine takes a model, and a fake Ollama
// server built on it where a separate process does.
export function decide(prompt) {
  if (/password/i.test(prompt)) {
    return {
      category: "how_to",
      confidence: 0.94,
      reply:
        "Hi,\n\nYou can reset your password under Settings, then Security, then Reset password. The link is valid for one hour.\n\nThe Support Team",
    };
  }
  if (/email address|verify/i.test(prompt)) {
    return {
      category: "other",
      confidence: 0.35,
      reply:
        "Hi,\n\nThanks for getting in touch. A teammate will confirm your identity and follow up about the change.\n\nThe Support Team",
    };
  }
  throw new Error(`fake model: unexpected prompt: ${prompt}`);
}

export const fakeModel = {
  async generateText() {
    return "ok";
  },
  async generateStructured({ prompt }) {
    return decide(prompt);
  },
};
