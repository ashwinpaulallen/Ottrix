import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore } from '../../src/memory/vector-store.js';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { NoOpEmbeddingProvider } from '../../src/memory/embeddings.js';
import { TopicEmbeddingProvider } from './fixtures/topic-embedding.js';

describe('SemanticMemory', () => {
  it('ingests documents as chunks and retrieves relevant passages', async () => {
    const store = new InMemoryVectorStore();
    const memory = new SemanticMemory({
      embeddings: new TopicEmbeddingProvider(),
      vectorStore: store,
      maxChunkSize: 200,
      chunkOverlap: 0,
    });

    await memory.ingest([
      {
        id: 'doc-cats',
        content: 'Cats are small carnivorous mammals. They are popular pets.',
      },
      {
        id: 'doc-cars',
        content: 'Cars are motor vehicles with four wheels used for transport.',
      },
    ]);

    const results = await memory.retrieve('cats and kittens as pets', { limit: 2 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content.toLowerCase()).toContain('cat');
    expect(results[0]?.metadata?.memoryType).toBe('semantic');
    expect(results[0]?.metadata?.documentId).toBe('doc-cats');
  });

  it('clears ingested chunks', async () => {
    const store = new InMemoryVectorStore();
    const memory = new SemanticMemory({
      embeddings: new NoOpEmbeddingProvider(),
      vectorStore: store,
    });

    await memory.ingest([{ id: 'doc-1', content: 'Sample knowledge.' }]);
    expect(store.size()).toBeGreaterThan(0);

    await memory.clear();
    expect(store.size()).toBe(0);
  });
});
