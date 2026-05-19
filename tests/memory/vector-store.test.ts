import { describe, expect, it } from 'vitest';
import {
  InMemoryVectorStore,
  cosineSimilarity,
} from '../../src/memory/vector-store.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 when a vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/dimension mismatch/);
  });
});

describe('InMemoryVectorStore', () => {
  it('ranks results by cosine similarity', async () => {
    const store = new InMemoryVectorStore();

    await store.upsert([
      { id: 'a', vector: [1, 0, 0], content: 'cats', metadata: {} },
      { id: 'b', vector: [0.9, 0.1, 0], content: 'kittens', metadata: {} },
      { id: 'c', vector: [0, 1, 0], content: 'cars', metadata: {} },
    ]);

    const results = await store.search([1, 0, 0], { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('a');
    expect(results[1]?.id).toBe('b');
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score ?? 0);
  });

  it('applies metadata filters', async () => {
    const store = new InMemoryVectorStore();

    await store.upsert([
      {
        id: 'a',
        vector: [1, 0],
        content: 'alpha',
        metadata: { category: 'animals' },
      },
      {
        id: 'b',
        vector: [1, 0],
        content: 'beta',
        metadata: { category: 'vehicles' },
      },
    ]);

    const results = await store.search([1, 0], {
      filter: { category: 'animals' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('a');
  });

  it('deletes entries by id', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: 'a', vector: [1], content: 'a', metadata: {} },
    ]);
    await store.delete(['a']);
    expect(store.size()).toBe(0);
  });
});
