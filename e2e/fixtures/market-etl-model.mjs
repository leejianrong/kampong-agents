// A deterministic stand-in for the model behind the market-etl summary step (KAN-1865). It reads the
// symbol and the percent move out of the prompt, so each alert has its own text and a Slack fixture can be
// recorded and replayed per symbol. No model fixtures exist yet (see the template README), so offline
// tests use this where the engine takes a model.
export const fakeModel = {
  async generateText() {
    return "ok";
  },
  async generateStructured({ prompt }) {
    const [, symbol, pct] =
      /(\w+)\s+closed\s+at\s+[\d.]+\s+on\s+[\d-]+,\s+(-?[\d.]+)%\s+versus/.exec(prompt) ?? [];
    if (symbol === undefined) throw new Error(`fake model: unexpected prompt: ${prompt}`);
    return {
      summary: `${symbol} moved ${pct}% on the day.`,
      direction: Number(pct) < 0 ? "down" : "up",
    };
  },
};
