import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { resolveModel } from "../model.js";
import type { MatchedChunk } from "../supabase-client.js";

export const answerSchema = z.object({
  answer: z.string().describe("A complete answer to the question, grounded only in the provided sources."),
  citedPaths: z
    .array(z.string())
    .describe("The document paths (from the provided sources) actually drawn on to answer -- omit any source not used."),
});
export type Answer = z.infer<typeof answerSchema>;

// Pure, network-free (unit-testable per SLICES.md's V4 test plan): turns
// retrieved chunks into the numbered source list the agent is shown and
// the citation markers the dashboard renders.
export function formatSourcesForPrompt(chunks: MatchedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const heading = chunk.heading ? ` – ${chunk.heading}` : "";
      return `[${index + 1}] ${chunk.document_path}${heading}\n${chunk.content}`;
    })
    .join("\n\n");
}

export const analystAgent = new Agent({
  id: "research-analyst",
  name: "kampong-agents Research Analyst",
  instructions: `You answer questions about the kampong-agents codebase using
only the numbered sources you're given -- real chunks retrieved from its own
docs/ADRs via a real vector search. Never use outside knowledge about the
product. If the sources don't actually answer the question, say so plainly
instead of guessing. Cite which source document paths you actually drew on;
if a question needs synthesizing more than one document, cite all of them.`,
  model: resolveModel(),
});

export async function answerFromChunks(question: string, chunks: MatchedChunk[]): Promise<Answer> {
  const prompt = `Question: ${question}

Sources:
${formatSourcesForPrompt(chunks)}`;

  const result = await analystAgent.generate(prompt, {
    structuredOutput: { schema: answerSchema },
  });
  return result.object;
}
