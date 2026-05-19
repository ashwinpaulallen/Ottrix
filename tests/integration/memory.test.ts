import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/types/messages.js';
import { WorkingMemory } from '../../src/memory/working.js';
import { createTokenEstimator } from '../../src/memory/tokens.js';
import { SemanticMemory } from '../../src/memory/semantic.js';
import { InMemoryVectorStore, cosineSimilarity } from '../../src/memory/vector-store.js';
import { TopicEmbeddingProvider } from '../memory/fixtures/topic-embedding.js';
import { MockProvider, textCompletion } from '../helpers/mock-provider.js';

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function assistantMessage(content: string): ChatMessage {
  return { role: 'assistant', content };
}

describe('integration: memory', () => {
  describe('WorkingMemory', () => {
    it('drops oldest messages when the context window is exceeded', () => {
      const memory = new WorkingMemory({
        maxTokens: 30,
        reservedResponseTokens: 0,
        reservedSystemTokens: 0,
        keepRecentMessages: 2,
        tokenEstimator: {
          estimateText: (text) => text.length,
          estimateMessage: (m) => (typeof m.content === 'string' ? m.content.length : 100),
          estimateMessages: (messages) =>
            messages.reduce(
              (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 100),
              0,
            ),
        },
      });

      memory.addMessage(userMessage('message-1'));
      memory.addMessage(assistantMessage('message-2'));
      memory.addMessage(userMessage('message-3'));
      memory.addMessage(assistantMessage('message-4'));

      const contents = memory.getMessages().map((m) => m.content);
      expect(contents).not.toContain('message-1');
      expect(contents).toContain('message-4');
      expect(memory.getTokenCount()).toBeLessThanOrEqual(30);
    });

    it('summarizes middle messages via an LLM provider', async () => {
      const provider = new MockProvider().enqueue(
        textCompletion('Summary of earlier conversation about capitals.', {
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
        }),
      );

      const memory = new WorkingMemory({
        keepRecentMessages: 2,
        tokenEstimator: createTokenEstimator({ tokensPerWord: 1 }),
      });

      memory.addMessage(userMessage('What is the capital of France?'));
      memory.addMessage(assistantMessage('Paris is the capital.'));
      memory.addMessage(userMessage('And Germany?'));
      memory.addMessage(assistantMessage('Berlin is the capital.'));

      await memory.summarize(provider);

      const summary = memory.getMessages().find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('[Conversation summary]'),
      );

      expect(summary).toBeDefined();
      expect(provider.completeCalls).toBe(1);
    });
  });

  describe('SemanticMemory', () => {
    it('ingests documents and retrieves semantically relevant chunks', async () => {
      const memory = new SemanticMemory({
        embeddings: new TopicEmbeddingProvider(),
        vectorStore: new InMemoryVectorStore(),
        maxChunkSize: 200,
        chunkOverlap: 0,
      });

      await memory.ingest([
        {
          id: 'doc-cats',
          content: 'Cats are small carnivorous mammals. They are popular pets worldwide.',
        },
        {
          id: 'doc-cars',
          content: 'Cars are motor vehicles with four wheels used for personal transport.',
        },
      ]);

      const results = await memory.retrieve('information about cats as pets', { limit: 2 });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.content.toLowerCase()).toContain('cat');
      expect(results[0]?.metadata?.memoryType).toBe('semantic');
    });
  });

  describe('InMemoryVectorStore', () => {
    it('ranks vectors by cosine similarity', async () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);

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
  });
});
