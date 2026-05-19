import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/memory/chunking.js';
import { FetchEmbeddingProvider } from '../../src/memory/embeddings.js';
import { InMemoryVectorStore } from '../../src/memory/vector-store.js';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { TopicEmbeddingProvider } from './fixtures/topic-embedding.js';

describe('memory regressions', () => {
  it('chunk overlap does not exceed maxChunkSize', () => {
    const content = 'abcdefghij'.repeat(8);
    const chunks = chunkText(content, { maxChunkSize: 25, chunkOverlap: 10 });
    expect(chunks.every((chunk) => chunk.length <= 25)).toBe(true);
  });

  it('re-ingesting a document replaces prior chunks', async () => {
    const store = new InMemoryVectorStore();
    const memory = new SemanticMemory({
      embeddings: new TopicEmbeddingProvider(),
      vectorStore: store,
      maxChunkSize: 100,
      chunkOverlap: 0,
    });

    await memory.ingest([{ id: 'doc-1', content: 'cats and kittens' }]);
    const firstSize = store.size();

    await memory.ingest([{ id: 'doc-1', content: 'cars and trucks' }]);
    expect(store.size()).toBe(firstSize);

    const results = await memory.retrieve('cars and motor vehicles', { limit: 3 });
    expect(results[0]?.content.toLowerCase()).toContain('car');
    expect(results.some((r) => r.content.toLowerCase().includes('kitten'))).toBe(false);
  });

  it('InMemoryVectorStore rejects dimension mismatches', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: 'a', vector: [1, 0], content: 'a', metadata: {} },
    ]);

    await expect(
      store.upsert([{ id: 'b', vector: [1, 0, 0], content: 'b', metadata: {} }]),
    ).rejects.toThrow(/dimension mismatch/);
  });

  it('FetchEmbeddingProvider validates embedding count', async () => {
    const provider = new FetchEmbeddingProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1], index: 0 }],
          }),
          { status: 200 },
        ),
    });

    await expect(provider.embedBatch(['a', 'b'])).rejects.toThrow(/expected 2 embeddings/);
  });
});
