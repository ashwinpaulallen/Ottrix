import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore } from '../../src/memory/vector-store.js';
import { EpisodicMemory } from '../../src/memory/episodic.js';
import { DeterministicEmbeddingProvider } from './fixtures/deterministic-embeddings.js';

describe('EpisodicMemory', () => {
  it('stores and retrieves past interactions by semantic query', async () => {
    const store = new InMemoryVectorStore();
    const memory = new EpisodicMemory({
      embeddings: new DeterministicEmbeddingProvider(),
      vectorStore: store,
    });

    await memory.store(
      EpisodicMemory.createEntry('ep-1', {
        task: 'Deploy the staging API',
        toolsUsed: ['deploy', 'kubectl'],
        outcome: 'Deployment failed due to missing secret',
        success: false,
      }),
    );

    await memory.store(
      EpisodicMemory.createEntry('ep-2', {
        task: 'Summarize quarterly report',
        toolsUsed: ['search'],
        outcome: 'Produced a two-page summary for the user',
        success: true,
      }),
    );

    const results = await memory.retrieve('remember when deployment failed', { limit: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('Deploy the staging API');
    expect(results[0]?.metadata?.toolsUsed).toContain('deploy');
    expect(results[0]?.metadata?.success).toBe(false);
  });

  it('formats interaction text for embedding', () => {
    const text = EpisodicMemory.formatInteraction({
      task: 'Fix login bug',
      toolsUsed: ['grep', 'test'],
      outcome: 'Patched session cookie handling',
      success: true,
    });

    expect(text).toContain('Task: Fix login bug');
    expect(text).toContain('grep');
    expect(text).toContain('succeeded');
  });

  it('clears stored episodes', async () => {
    const store = new InMemoryVectorStore();
    const memory = new EpisodicMemory({
      embeddings: new DeterministicEmbeddingProvider(),
      vectorStore: store,
    });

    await memory.store(
      EpisodicMemory.createEntry('ep-1', {
        task: 'Test task',
        outcome: 'Done',
      }),
    );

    await memory.clear();
    expect(store.size()).toBe(0);
  });
});
