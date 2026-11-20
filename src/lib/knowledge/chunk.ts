export type KnowledgeSegment = {
  text: string;
  locator?: string | null;
};

export type KnowledgeChunk = {
  ordinal: number;
  content: string;
  locator: string | null;
};

const CHUNK_SIZE = 900;
const CHUNK_STRIDE = 750;

function splitLongText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + CHUNK_SIZE / 2) end = boundary;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;
    start = Math.max(start + 1, end - (CHUNK_SIZE - CHUNK_STRIDE));
  }
  return chunks;
}

export function chunkSegments(segments: KnowledgeSegment[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const segment of segments) {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const content of splitLongText(text)) {
      chunks.push({ ordinal: chunks.length, content, locator: segment.locator?.trim() || null });
    }
  }
  return chunks;
}

export function chunkMarkdown(markdown: string): KnowledgeChunk[] {
  const blocks = markdown.split(/\n\s*\n/);
  const segments: KnowledgeSegment[] = [];
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (text) segments.push({ text, locator: heading });
    body = [];
  };

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const headingMatch = /^(#{1,6})\s+(.+)$/m.exec(block);
    if (headingMatch) {
      flush();
      heading = headingMatch[2].trim().slice(0, 240);
      const rest = block.slice(headingMatch[0].length).trim();
      if (rest) body.push(rest);
      continue;
    }
    body.push(block);
  }
  flush();

  if (segments.length === 0 && markdown.trim()) {
    segments.push({ text: markdown.trim(), locator: null });
  }
  return chunkSegments(segments);
}

export function buildSearchableChunks(input: {
  markdown: string;
  title?: string;
  segments?: KnowledgeSegment[];
}): KnowledgeChunk[] {
  const chunks = input.segments
    ? chunkSegments([
        ...(input.title ? [{ text: input.title, locator: "Title" }] : []),
        ...input.segments,
      ])
    : chunkMarkdown(input.title ? `# ${input.title}\n\n${input.markdown}` : input.markdown);
  return chunks.map((chunk) => {
    const parts = [
      input.title?.trim(),
      chunk.locator === "Title" ? null : chunk.locator?.trim(),
      chunk.content.trim(),
    ].filter((part): part is string => Boolean(part));
    return { ...chunk, content: [...new Set(parts)].join("\n") };
  });
}
