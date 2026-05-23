/** Options for document chunking. */
export interface ChunkingOptions {
  /** Maximum characters per chunk. @defaultValue 800 */
  maxChunkSize?: number;
  /** Overlap in characters between consecutive chunks. @defaultValue 100 */
  chunkOverlap?: number;
}

const DEFAULT_MAX_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;

/**
 * Split text into overlapping chunks, preferring paragraph boundaries.
 */
export function chunkText(content: string, options: ChunkingOptions = {}): string[] {
  const maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const chunkOverlap = Math.min(
    options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
    Math.max(0, maxChunkSize - 1),
  );

  const normalized = content.trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const merged = mergeParagraphs(paragraphs, maxChunkSize);
  const sized = merged.flatMap((block) =>
    splitOversizedBlock(block, maxChunkSize, chunkOverlap),
  );

  if (sized.length <= 1 || chunkOverlap === 0) {
    return sized;
  }

  return applyOverlap(sized, chunkOverlap, maxChunkSize);
}

function mergeParagraphs(paragraphs: string[], maxChunkSize: number): string[] {
  const blocks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChunkSize) {
      if (current) {
        blocks.push(current);
        current = '';
      }
      blocks.push(paragraph);
      continue;
    }

    if (!current) {
      current = paragraph;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChunkSize) {
      current = candidate;
    } else {
      blocks.push(current);
      current = paragraph;
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function splitOversizedBlock(
  block: string,
  maxChunkSize: number,
  chunkOverlap: number,
): string[] {
  if (block.length <= maxChunkSize) {
    return [block];
  }

  const chunks: string[] = [];
  const step = Math.max(1, maxChunkSize - chunkOverlap);
  let start = 0;
  while (start < block.length) {
    chunks.push(block.slice(start, start + maxChunkSize));
    start += step;
  }
  return chunks;
}

function applyOverlap(chunks: string[], overlap: number, maxChunkSize: number): string[] {
  if (chunks.length === 0) {
    return [];
  }

  const first = chunks[0];
  if (!first) {
    return [];
  }

  const result: string[] = [first];

  for (let i = 1; i < chunks.length; i++) {
    const previous = result[result.length - 1] ?? '';
    const current = chunks[i] ?? '';
    const tail = previous.slice(-overlap);
    result.push((tail + current).slice(0, maxChunkSize));
  }

  return result;
}
