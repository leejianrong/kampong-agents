import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

// Secret API key, never exposed to a browser -- this process is the only
// consumer, calling Supabase's REST/RPC interface server-side only. RLS is
// enabled with no policies on both tables (see the migration this demo
// applied), so the publishable/anon key genuinely cannot read this data;
// only a secret (or legacy service_role) key can.
export function getSupabaseClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false },
  });
}

export interface MatchedChunk {
  chunk_id: string;
  document_path: string;
  document_title: string;
  heading: string | null;
  content: string;
  similarity: number;
}

export async function matchDocumentChunks(embedding: number[], matchCount = 6): Promise<MatchedChunk[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: embedding,
    match_count: matchCount,
  });
  if (error) throw new Error(`Supabase match_document_chunks failed: ${error.message}`);
  return data as MatchedChunk[];
}
