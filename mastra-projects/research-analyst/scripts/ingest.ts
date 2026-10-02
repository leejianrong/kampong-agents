import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { chunkMarkdown } from "../src/chunking.js";
import { embed } from "../src/embeddings.js";
import { getSupabaseClient } from "../src/supabase-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> research-analyst/ -> mastra-projects/ -> kampong-agents/
const REPO_ROOT = join(__dirname, "..", "..", "..");

// Real corpus: kampong-agents' own product docs -- root planning docs plus
// everything under docs/ (ADRs, reference, tutorial). Excludes CLAUDE.md
// (a one-line `@AGENTS.md` pointer with no content of its own) and
// mastra-projects/ itself (this initiative's own planning docs, not the
// product being asked about).
const ROOT_DOC_ALLOWLIST = ["PLAN.md", "SLICES.md", "AGENTS.md", "QUESTIONS.md", "README.md", "ideation.md"];

async function collectDocPaths(): Promise<string[]> {
  const rootDocs = ROOT_DOC_ALLOWLIST.map((name) => join(REPO_ROOT, name));

  const docsDirDocs: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
        docsDirDocs.push(full);
      }
    }
  }
  await walk(join(REPO_ROOT, "docs"));

  return [...rootDocs, ...docsDirDocs];
}

function deriveTitle(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match ? match[1].trim() : fallback;
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  const paths = await collectDocPaths();
  console.log(`Ingesting ${paths.length} real documents from ${REPO_ROOT}...`);

  let totalChunks = 0;
  for (const absolutePath of paths) {
    const relativePath = relative(REPO_ROOT, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    const title = deriveTitle(content, relativePath);
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) continue;

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .upsert({ path: relativePath, title }, { onConflict: "path" })
      .select("id")
      .single();
    if (documentError) throw new Error(`Upserting document ${relativePath} failed: ${documentError.message}`);

    // Real embeddings per chunk (see src/embeddings.ts) -- no shortcuts,
    // sequential is fine at this corpus size and keeps the local model's
    // memory footprint predictable.
    const rows = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.content);
      rows.push({
        document_id: document.id,
        chunk_index: chunk.chunkIndex,
        heading: chunk.heading,
        content: chunk.content,
        embedding: JSON.stringify(embedding),
      });
    }

    const { error: chunksError } = await supabase
      .from("document_chunks")
      .upsert(rows, { onConflict: "document_id,chunk_index" });
    if (chunksError) throw new Error(`Upserting chunks for ${relativePath} failed: ${chunksError.message}`);

    totalChunks += rows.length;
    console.log(`  ${relativePath}: ${rows.length} chunks`);
  }

  console.log(`Done: ${paths.length} documents, ${totalChunks} chunks embedded and stored in Supabase.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
