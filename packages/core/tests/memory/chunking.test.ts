import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/memory/chunking.js';

describe('chunkText', () => {
  it('returns empty array for blank content', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('keeps short single-paragraph content as one chunk', () => {
    const chunks = chunkText('Hello world.');
    expect(chunks).toEqual(['Hello world.']);
  });

  it('splits on paragraph boundaries before max size', () => {
    const chunks = chunkText('Paragraph one.\n\nParagraph two.', {
      maxChunkSize: 29,
      chunkOverlap: 0,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('Paragraph one');
    expect(chunks[1]).toContain('Paragraph two');
  });

  it('splits oversized paragraphs into fixed windows', () => {
    const long = 'a'.repeat(50);
    const chunks = chunkText(long, { maxChunkSize: 20, chunkOverlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it('applies overlap between consecutive chunks', () => {
    const content = 'abcdefghij'.repeat(5);
    const chunks = chunkText(content, { maxChunkSize: 20, chunkOverlap: 5 });
    if (chunks.length >= 2) {
      const tail = chunks[0]!.slice(-5);
      expect(chunks[1]!.startsWith(tail)).toBe(true);
    }
  });
});
