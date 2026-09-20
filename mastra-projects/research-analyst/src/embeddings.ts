import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Real embeddings, computed locally -- not mocked, not a hashed
// pseudo-vector stand-in. OpenRouter (the model provider every demo
// otherwise uses, ADR-0005) has no embeddings endpoint at all: it only
// implements the chat/completions API. Rather than pull in a second paid
// provider (OpenAI/Cohere) just for embeddings, this demo runs a real
// sentence-transformer model locally via Transformers.js -- genuine
// 384-dimension vectors, no API key, no network call per embedding after
// the model weights are downloaded once. See README gap-analysis.
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", MODEL_NAME) as Promise<FeatureExtractionPipeline>;
  return extractorPromise;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
