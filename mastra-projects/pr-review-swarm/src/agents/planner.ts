import { Agent } from "@mastra/core/agent";
import { resolveModel } from "../model.js";
import { routingSchema } from "./schema.js";

export const plannerAgent = new Agent({
  id: "planner",
  name: "PR Review Planner",
  instructions: `You triage a real GitHub pull request diff and decide which
specialist reviewers actually need to look at it: "security" (secrets,
injection, unsafe eval/exec, auth/authorization changes), "style" (naming,
formatting, dead code, inconsistent conventions), "test-coverage" (new or
changed logic with no corresponding test change). Only pick a specialist if
the diff plausibly touches their concern -- routing everything to everyone
defeats the point.`,
  model: resolveModel(),
});

export async function planReview(diff: string, files: string[]) {
  const prompt = `Files changed:\n${files.join("\n")}\n\nDiff:\n${diff}`;
  const result = await plannerAgent.generate(prompt, { structuredOutput: { schema: routingSchema } });
  return result.object.specialists;
}
