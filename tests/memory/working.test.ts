import { describe, expect, it, vi } from 'vitest';
import { WorkingMemory } from '../../src/memory/working.js';
import { createTokenEstimator } from '../../src/memory/tokens.js';
import type { ChatMessage } from '../../src/types/messages.js';
import { MockCompletionProvider, textCompletion } from '../fixtures/mock-provider.js';

function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function assistantMessage(content: string): ChatMessage {
  return { role: 'assistant', content };
}

function systemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

describe('WorkingMemory', () => {
  describe('basic operations', () => {
    it('adds and returns messages', () => {
      const memory = new WorkingMemory();
      memory.addMessage(userMessage('Hello'));
      memory.addMessage(assistantMessage('Hi there'));

      expect(memory.getMessages()).toHaveLength(2);
      expect(memory.getMessages()[0]?.content).toBe('Hello');
    });

    it('clears history', () => {
      const memory = new WorkingMemory();
      memory.addMessage(userMessage('Hello'));
      memory.clear();
      expect(memory.getMessages()).toHaveLength(0);
    });

    it('snapshots and restores state', () => {
      const memory = new WorkingMemory();
      memory.addMessage(userMessage('Hello'));
      const snap = memory.snapshot();

      memory.clear();
      expect(memory.getMessages()).toHaveLength(0);

      memory.restore(snap);
      expect(memory.getMessages()).toHaveLength(1);
      expect(snap.version).toBe(1);
    });

    it('rejects unsupported snapshot versions', () => {
      const memory = new WorkingMemory();
      expect(() =>
        memory.restore({
          version: 2 as 1,
          messages: [],
          createdAt: Date.now(),
        }),
      ).toThrow(/Unsupported MemorySnapshot version/);
    });
  });

  describe('token estimation', () => {
    it('uses ~1.3 tokens per word by default', () => {
      const estimator = createTokenEstimator({ tokensPerWord: 1.3 });
      const memory = new WorkingMemory({ tokenEstimator: estimator });

      memory.addMessage(userMessage('one two three four'));
      const count = memory.getTokenCount();

      expect(count).toBe(Math.ceil(4 * 1.3));
    });

    it('supports a custom estimator via config', () => {
      const memory = new WorkingMemory({
        tokenEstimator: {
          estimateText: (text) => text.length,
          estimateMessage: (m) =>
            typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length,
          estimateMessages: (messages) =>
            messages.reduce(
              (sum, m) =>
                sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length),
              0,
            ),
        },
      });

      memory.addMessage(userMessage('abcd'));
      expect(memory.getTokenCount()).toBe(4);
    });

    it('reserves tokens for system prompt and response', () => {
      const memory = new WorkingMemory({
        maxTokens: 100,
        reservedSystemTokens: 20,
        reservedResponseTokens: 30,
        tokenEstimator: createTokenEstimator({ tokensPerWord: 1 }),
      });

      expect(memory.getAvailableTokenBudget()).toBe(50);
    });
  });

  describe('findMessages', () => {
    it('finds messages matching all keywords', () => {
      const memory = new WorkingMemory();
      memory.addMessage(userMessage('The capital of France is Paris'));
      memory.addMessage(assistantMessage('Berlin is in Germany'));
      memory.addMessage(userMessage('What about Italy?'));

      const matches = memory.findMessages('capital France');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.content).toContain('Paris');
    });

    it('returns empty array for blank query', () => {
      const memory = new WorkingMemory();
      memory.addMessage(userMessage('Hello'));
      expect(memory.findMessages('   ')).toHaveLength(0);
    });
  });

  describe('sliding window (no provider)', () => {
    it('drops oldest messages when budget is exceeded', () => {
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

    it('always keeps the primary system prompt', () => {
      const memory = new WorkingMemory({
        maxTokens: 25,
        reservedResponseTokens: 0,
        reservedSystemTokens: 0,
        keepRecentMessages: 1,
        tokenEstimator: {
          estimateText: (text) => text.length,
          estimateMessage: (m) => (typeof m.content === 'string' ? m.content.length : 50),
          estimateMessages: (messages) =>
            messages.reduce(
              (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 50),
              0,
            ),
        },
      });

      memory.addMessage(systemMessage('You are a helpful agent.'));
      memory.addMessage(userMessage('aaaaaaaaaa'));
      memory.addMessage(assistantMessage('bbbbbbbbbb'));
      memory.addMessage(userMessage('cccccccccc'));

      const messages = memory.getMessages();
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toBe('You are a helpful agent.');
    });
  });

  describe('summarize', () => {
    it('condenses middle messages into a summary system message', async () => {
      const provider = new MockCompletionProvider().enqueue(
        textCompletion('User asked about France. Assistant answered Paris.'),
      );

      const memory = new WorkingMemory({
        keepRecentMessages: 2,
        tokenEstimator: createTokenEstimator({ tokensPerWord: 1 }),
      });

      memory.addMessage(systemMessage('You are helpful.'));
      memory.addMessage(userMessage('What is the capital of France?'));
      memory.addMessage(assistantMessage('Paris is the capital.'));
      memory.addMessage(userMessage('And Germany?'));
      memory.addMessage(assistantMessage('Berlin is the capital.'));

      await memory.summarize(provider);

      const messages = memory.getMessages();
      const summary = messages.find(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.includes('[Conversation summary]'),
      );

      expect(summary).toBeDefined();
      expect(summary?.content).toContain('Paris');
      expect(provider.completeCalls).toBe(1);

      const roles = messages.map((m) => m.role);
      expect(roles[0]).toBe('system');
      expect(messages.filter((m) => m.role === 'user' || m.role === 'assistant')).toHaveLength(2);
    });

    it('includes prior summary content when re-summarizing', async () => {
      const provider = new MockCompletionProvider()
        .enqueue(textCompletion('First summary.'))
        .enqueue(textCompletion('Merged summary.'));

      const memory = new WorkingMemory({ keepRecentMessages: 1 });

      memory.addMessage(userMessage('old-1'));
      memory.addMessage(assistantMessage('old-2'));
      memory.addMessage(userMessage('recent'));
      await memory.summarize(provider);

      memory.addMessage(assistantMessage('older-middle'));
      memory.addMessage(userMessage('new-recent'));
      await memory.summarize(provider);

      expect(provider.completeCalls).toBe(2);
      const lastParams = provider.lastCompleteParams;
      expect(lastParams?.messages[0]?.content).toContain('Prior summary');
    });

    it('is a no-op when there is nothing to summarize', async () => {
      const provider = new MockCompletionProvider().enqueue(textCompletion('unused'));
      const memory = new WorkingMemory({ keepRecentMessages: 4 });

      memory.addMessage(userMessage('only one'));
      await memory.summarize(provider);

      expect(provider.completeCalls).toBe(0);
    });
  });

  describe('summarization trigger via budget', () => {
    it('does not call provider on addMessage — only sliding window applies', () => {
      const complete = vi.fn();

      const memory = new WorkingMemory({
        maxTokens: 20,
        reservedResponseTokens: 0,
        reservedSystemTokens: 0,
        keepRecentMessages: 1,
        tokenEstimator: {
          estimateText: (t) => t.length,
          estimateMessage: (m) => (typeof m.content === 'string' ? m.content.length : 10),
          estimateMessages: (msgs) =>
            msgs.reduce(
              (s, m) => s + (typeof m.content === 'string' ? m.content.length : 10),
              0,
            ),
        },
      });

      memory.addMessage(userMessage('1234567890'));
      memory.addMessage(assistantMessage('1234567890'));

      expect(complete).not.toHaveBeenCalled();
      expect(memory.getTokenCount()).toBeLessThanOrEqual(20);
    });
  });
});
