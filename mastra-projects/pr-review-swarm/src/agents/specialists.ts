import { Agent } from "@mastra/core/agent";
import { resolveModel } from "../model.js";
import { reviewSchema, type Review, type Specialist } from "./schema.js";

const INSTRUCTIONS: Record<Specialist, string> = {
  security: `You are a security reviewer for a real GitHub pull request. Flag
hardcoded secrets/credentials, injection risks (SQL, command, eval/exec of
untrusted input), unsafe deserialization, missing input validation on
externally-reachable endpoints, and authorization/authentication changes.
Say nothing if the diff has no security-relevant surface.`,
  style: `You are a style reviewer for a real GitHub pull request. Flag
inconsistent naming, dead/commented-out code, obviously duplicated logic, and
places the diff doesn't match the surrounding file's existing conventions.
Do not nitpick formatting a linter would already catch.`,
  "test-coverage": `You are a test-coverage reviewer for a real GitHub pull
request. Flag new or materially changed logic (branches, edge cases, error
paths) that has no corresponding test change in this same diff. Say nothing
if the diff is test-only, docs-only, or trivial.`,
};

function buildSpecialistAgent(specialist: Specialist): Agent {
  return new Agent({
    id: `reviewer-${specialist}`,
    name: `${specialist} reviewer`,
    instructions: INSTRUCTIONS[specialist],
    model: resolveModel(),
  });
}

const AGENTS: Record<Specialist, Agent> = {
  security: buildSpecialistAgent("security"),
  style: buildSpecialistAgent("style"),
  "test-coverage": buildSpecialistAgent("test-coverage"),
};

export async function runSpecialist(
  specialist: Specialist,
  diff: string,
  files: string[],
): Promise<Review> {
  const prompt = `Files changed:\n${files.join("\n")}\n\nDiff:\n${diff}`;
  const result = await AGENTS[specialist].generate(prompt, {
    structuredOutput: { schema: reviewSchema },
  });
  return result.object;
}
