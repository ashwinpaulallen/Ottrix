import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../../../src/config.js';
import { createAgent } from '../../../src/factory.js';
import type { CompletionParams } from '../../../src/types/provider.js';
import { FunctionTool } from '../../../src/tools/function-tool.js';
import { MockCompletionProvider, textCompletion, toolUseCompletion } from '../../fixtures/mock-provider.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function promptText(params: CompletionParams): string {
  return params.messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
}

function spyPrompts(provider: MockCompletionProvider): string[] {
  const seen: string[] = [];
  const original = provider.complete.bind(provider);
  provider.complete = async (params) => {
    seen.push(promptText(params));
    return original(params);
  };
  return seen;
}

const ping = new FunctionTool({
  name: 'ping',
  description: 'Ping',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => 'pong',
});

describe('createAgent compaction', () => {
  afterEach(() => {
    resetConfigCache();
  });

  it('uses hierarchical compaction when configured', async () => {
    const primary = new MockCompletionProvider()
      .setTokenCount(1_000)
      .enqueue(toolUseCompletion([{ id: 't1', name: 'ping', input: {} }], usage))
      .enqueue(toolUseCompletion([{ id: 't2', name: 'ping', input: {} }], usage))
      .enqueue(textCompletion('finished', usage));
    const compaction = new MockCompletionProvider()
      .enqueue(textCompletion('- ship the billing fix', usage))
      .enqueue(textCompletion('Billing retry stays open.', usage));
    const primaryPrompts = spyPrompts(primary);
    const compactionPrompts = spyPrompts(compaction);

    const agent = createAgent({
      provider: primary,
      tools: [ping],
      telemetry: false,
      guardrails: false,
      memory: false,
      contextLimitTokens: 100,
      compaction: {
        strategy: 'hierarchical',
        recentMessagesToPreserve: 2,
        provider: compaction,
      },
    });

    const result = await agent.run('Plan the release');

    expect(agent.getCompactionConfig()?.strategy).toBe('hierarchical');
    expect(result.response).toBe('finished');
    expect(compaction.completeCalls).toBe(2);
    expect(compactionPrompts[0]).toContain('TOPIC INDEX');
    expect(compactionPrompts[1]).toContain('CONCISE DIGEST');
    expect(compactionPrompts[1]).toContain('- ship the billing fix');
    expect(primaryPrompts.some((prompt) => prompt.includes('TOPIC INDEX'))).toBe(false);
    expect(primaryPrompts.some((prompt) => prompt.includes('CONCISE DIGEST'))).toBe(false);
  });

  it('keeps single-threshold summarization when compaction is omitted', async () => {
    const primary = new MockCompletionProvider()
      .setTokenCount(1_000)
      .enqueue(toolUseCompletion([{ id: 't1', name: 'ping', input: {} }], usage))
      .enqueue(toolUseCompletion([{ id: 't2', name: 'ping', input: {} }], usage))
      .enqueue(textCompletion('Summary of earlier turns.', usage))
      .enqueue(textCompletion('finished', usage));
    const prompts = spyPrompts(primary);

    const agent = createAgent({
      provider: primary,
      tools: [ping],
      telemetry: false,
      guardrails: false,
      memory: false,
      contextLimitTokens: 100,
      keepRecentMessages: 2,
    });

    const result = await agent.run('Plan the release');

    expect(agent.getCompactionConfig()).toBeUndefined();
    expect(result.response).toBe('finished');
    expect(prompts.some((prompt) => prompt.includes('Summarize the following conversation segment'))).toBe(
      true,
    );
  });

  it('throws a Zod error when softThreshold is not below hardThreshold', () => {
    const provider = new MockCompletionProvider();

    expect(() =>
      createAgent({
        provider,
        telemetry: false,
        guardrails: false,
        memory: false,
        compaction: {
          strategy: 'hierarchical',
          softThreshold: 0.88,
          mediumThreshold: 0.9,
          hardThreshold: 0.8,
        },
      }),
    ).toThrow(/softThreshold < mediumThreshold < hardThreshold must hold/);
  });

  it('sends compaction LLM calls to the compaction provider', async () => {
    const primary = new MockCompletionProvider()
      .setTokenCount(1_000)
      .enqueue(toolUseCompletion([{ id: 't1', name: 'ping', input: {} }], usage))
      .enqueue(toolUseCompletion([{ id: 't2', name: 'ping', input: {} }], usage))
      .enqueue(textCompletion('finished', usage));
    const compaction = new MockCompletionProvider().enqueue(
      textCompletion('Prose digest of the thread.', usage),
    );
    const primaryPrompts = spyPrompts(primary);

    const agent = createAgent({
      provider: primary,
      tools: [ping],
      telemetry: false,
      guardrails: false,
      memory: false,
      contextLimitTokens: 100,
      compaction: {
        strategy: 'prose',
        recentMessagesToPreserve: 2,
        provider: compaction,
        model: 'claude-haiku-3.5',
      },
    });

    await agent.run('Plan the release');

    expect(compaction.completeCalls).toBe(1);
    expect(compaction.lastCompleteParams?.model).toBe('claude-haiku-3.5');
    const compactionPrompt = compaction.lastCompleteParams
      ? promptText(compaction.lastCompleteParams)
      : '';
    expect(compactionPrompt).toContain('CONCISE DIGEST');
    expect(primary.completeCalls).toBe(3);
    expect(primaryPrompts.some((prompt) => prompt.includes('CONCISE DIGEST'))).toBe(false);
  });
});
