// Pure, network-free logic (unit-testable per SLICES.md's V4 test plan):
// split a markdown document into heading-aware chunks small enough to
// embed and cite individually, without ever calling out to a model or a
// database.

export interface Chunk {
  chunkIndex: number;
  heading: string | null;
  content: string;
}

const MAX_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 150;

function splitLongSection(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    parts.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return parts.filter(Boolean);
}

/** Splits on markdown headings first (so a chunk stays under one topic), then hard-wraps any section still too long for one embedding. */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split("\n");
  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];

  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      sections.push({ heading: headingMatch[1].trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.body.join("\n").trim();
    if (!text) continue;
    for (const part of splitLongSection(text)) {
      chunks.push({ chunkIndex: chunks.length, heading: section.heading, content: part });
    }
  }
  return chunks;
}
