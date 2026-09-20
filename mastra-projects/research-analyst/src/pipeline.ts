import { randomUUID } from "node:crypto";
import { embed } from "./embeddings.js";
import { matchDocumentChunks } from "./supabase-client.js";
import { answerFromChunks } from "./agents/analyst.js";
import { emitResearchEvent } from "./events.js";

export interface AskResult {
  answer: string;
  citedPaths: string[];
}

/** The real end-to-end chain: embed the question locally -> real pgvector similarity search -> a cited answer grounded only in what was actually retrieved. */
export async function ask(question: string): Promise<AskResult> {
  const queryId = randomUUID();
  emitResearchEvent({ type: "query_received", query: queryId, question, at: Date.now() });

  try {
    const embedding = await embed(question);
    const chunks = await matchDocumentChunks(embedding);
    emitResearchEvent({ type: "chunks_retrieved", query: queryId, chunks, at: Date.now() });

    const { answer, citedPaths } = await answerFromChunks(question, chunks);
    emitResearchEvent({ type: "answer_ready", query: queryId, answer, citedPaths, at: Date.now() });

    return { answer, citedPaths };
  } catch (err) {
    emitResearchEvent({
      type: "query_error",
      query: queryId,
      message: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    });
    throw err;
  }
}
