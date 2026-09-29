import { describe, expect, it } from 'vitest';

import { ContextManager } from '../../../src/agent/context.js';
import { CompactionConfigSchema } from '../../../src/agent/context/compaction-types.js';
import { DigestCache } from '../../../src/agent/context/digest-cache.js';
import { Agent } from '../../../src/agent/agent.js';
import type { ChatMessage } from '../../../src/types/messages.js';
import { MockCompletionProvider, textCompletion } from '../../fixtures/mock-provider.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe('ContextManager compaction', () => {
  it('honors keepRecentMessages when compaction omits recentMessagesToPreserve', () => {
    const agent = new Agent({
      name: 'keep-recent',
      provider: new MockCompletionProvider(),
      keepRecentMessages: 6,
      compaction: { strategy: 'prose' },
    });

    expect(agent.getCompactionConfig()?.recentMessagesToPreserve).toBe(6);
  });

  it('manageContext is an alias of maybeSummarize', async () => {
    const provider = new MockCompletionProvider().setTokenCount(10);
    const manager = new ContextManager({ provider, contextLimitTokens: 100 });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    await manager.manageContext(messages);
    expect(messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('replaces old tool results at the medium threshold without an LLM call', async () => {
    const provider = new MockCompletionProvider().setTokenCount(80);
    const compaction = CompactionConfigSchema.parse({
      strategy: 'prose',
      recentMessagesToPreserve: 2,
    });
    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'A'.repeat(250) }],
      },
      { role: 'user', content: 'keep-1' },
      { role: 'user', content: 'keep-2' },
    ];

    await manager.maybeSummarize(messages);

    expect(provider.completeCalls).toBe(0);
    const tool = messages.find((message) => message.role === 'tool');
    expect(JSON.stringify(tool)).toContain("[Tool 'search' completed");
    expect(messages.at(-1)?.content).toBe('keep-2');
  });

  it('injects a compacted_context marker at the hard threshold', async () => {
    const provider = new MockCompletionProvider()
      .setTokenCount(90)
      .enqueue(textCompletion('Digest of earlier turns.', usage));
    const compaction = CompactionConfigSchema.parse({
      strategy: 'prose',
      recentMessagesToPreserve: 2,
    });
    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction,
      digestCache: new DigestCache(8),
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old-1' },
      { role: 'user', content: 'old-2' },
      { role: 'user', content: 'keep-1' },
      { role: 'user', content: 'keep-2' },
    ];

    await manager.maybeSummarize(messages);

    const compacted = messages.find(
      (message) => typeof message.content === 'string' && message.content.includes('<compacted_context>'),
    );
    expect(compacted?.role).toBe('assistant');
    expect(compacted?.content).toContain('[COMPACTED CONTEXT]');
    expect(compacted?.content).toContain('Digest of earlier turns.');
  });

  it('uses the cached strategy on a digest cache hit', async () => {
    const provider = new MockCompletionProvider()
      .setTokenCount(90)
      .enqueue(textCompletion('- topic', usage))
      .enqueue(textCompletion('hierarchical digest', usage));
    const cache = new DigestCache(8);
    const hierarchical = CompactionConfigSchema.parse({
      strategy: 'hierarchical',
      recentMessagesToPreserve: 2,
    });
    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction: hierarchical,
      digestCache: cache,
    });
    const seed: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old-1' },
      { role: 'user', content: 'old-2' },
      { role: 'user', content: 'keep-1' },
      { role: 'user', content: 'keep-2' },
    ];

    await manager.maybeSummarize([...seed]);
    expect(provider.completeCalls).toBe(2);

    const proseManager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction: CompactionConfigSchema.parse({
        strategy: 'prose',
        recentMessagesToPreserve: 2,
      }),
      digestCache: cache,
    });
    const again = seed.map((message) => ({ ...message }));
    await proseManager.maybeSummarize(again);

    expect(provider.completeCalls).toBe(2);
    expect(JSON.stringify(again)).toContain('<compacted_context>');
    expect(JSON.stringify(again)).toContain('- topic');
  });

  it('rethrows when failurePolicy is throw', async () => {
    const provider = new MockCompletionProvider().setTokenCount(90);
    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction: CompactionConfigSchema.parse({
        strategy: 'prose',
        recentMessagesToPreserve: 2,
        failurePolicy: 'throw',
      }),
    });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old-1' },
      { role: 'user', content: 'old-2' },
      { role: 'user', content: 'keep-1' },
      { role: 'user', content: 'keep-2' },
    ];

    await expect(manager.maybeSummarize(messages)).rejects.toThrow(/no more complete/);
  });

  it('keeps history when failurePolicy is preserve', async () => {
    const provider = new MockCompletionProvider().setTokenCount(90);
    const original: ChatMessage[] = [
      { role: 'user', content: 'old-1' },
      { role: 'user', content: 'old-2' },
      { role: 'user', content: 'keep-1' },
      { role: 'user', content: 'keep-2' },
    ];
    const messages = original.map((message) => ({ ...message }));
    const manager = new ContextManager({
      provider,
      contextLimitTokens: 100,
      compaction: CompactionConfigSchema.parse({
        strategy: 'prose',
        recentMessagesToPreserve: 2,
        failurePolicy: 'preserve',
      }),
    });

    await manager.maybeSummarize(messages);
    expect(messages).toEqual(original);
  });
});
