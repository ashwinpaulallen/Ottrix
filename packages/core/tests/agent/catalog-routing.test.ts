import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent/agent.js';
import { ModelCatalog, ModelDescriptorSchema } from '../../src/providers/index.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { InMemoryExporter, Telemetry } from '../../src/observability/telemetry.js';
import { FunctionTool } from '../../src/tools/function-tool.js';
import type { CompletionParams } from '../../src/types/provider.js';
import {
  MockCompletionProvider,
  textCompletion,
  toolUseCompletion,
} from '../fixtures/mock-provider.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const ping = new FunctionTool({
  name: 'ping',
  description: 'Ping',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => 'pong',
});

function promptText(params: CompletionParams): string {
  return params.messages
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
}

function spyCompletes(provider: MockCompletionProvider): CompletionParams[] {
  const seen: CompletionParams[] = [];
  const original = provider.complete.bind(provider);
  provider.complete = async (params) => {
    seen.push(params);
    return original(params);
  };
  return seen;
}

function economyCatalog(cheap: MockCompletionProvider): ModelCatalog {
  const registry = new ProviderRegistry().register('cheap', cheap);
  return new ModelCatalog(registry, {
    models: [
      ModelDescriptorSchema.parse({
        key: 'haiku',
        provider: 'cheap',
        model: 'claude-haiku',
        displayName: 'Haiku',
        costTier: 'low',
        preferredFor: ['summarization', 'evaluation'],
      }),
    ],
    intentMap: { 'summarization:economy': 'haiku' },
  });
}

function primaryProvider(): MockCompletionProvider {
  return new MockCompletionProvider()
    .setTokenCount(1_000)
    .enqueue(toolUseCompletion([{ id: 't1', name: 'ping', input: {} }], usage))
    .enqueue(toolUseCompletion([{ id: 't2', name: 'ping', input: {} }], usage))
    .enqueue(textCompletion('finished', usage));
}

describe('Agent catalog model selection', () => {
  it('uses the catalog provider for summarization when compaction.provider is omitted', async () => {
    const primary = primaryProvider();
    const cheap = new MockCompletionProvider().enqueue(textCompletion('Earlier turns covered billing.', usage));
    const cheapCalls = spyCompletes(cheap);

    const agent = new Agent({
      name: 'catalog-summary',
      provider: primary,
      tools: [ping],
      contextLimitTokens: 100,
      catalog: economyCatalog(cheap),
      compaction: { strategy: 'prose', recentMessagesToPreserve: 2 },
    });

    const result = await agent.run('Plan the release');

    expect(result.response).toBe('finished');
    expect(cheap.completeCalls).toBe(1);
    expect(cheapCalls[0]?.model).toBe('claude-haiku');
    expect(cheapCalls[0]?.intent).toMatchObject({ role: 'summarization', prefer: 'economy' });
    expect(cheapCalls[0]?.intentResolution).toContain('explicit intent map: summarization:economy → haiku');
    expect(promptText(cheapCalls[0]!).includes('CONCISE DIGEST')).toBe(true);
    expect(primary.completeCalls).toBe(3);
  });

  it('keeps an explicit compaction provider when a catalog is also configured', async () => {
    const primary = primaryProvider();
    const explicit = new MockCompletionProvider().enqueue(
      textCompletion('Explicit summary.', usage),
    );
    const cheap = new MockCompletionProvider().enqueue(textCompletion('Catalog summary.', usage));

    const agent = new Agent({
      name: 'explicit-compaction',
      provider: primary,
      tools: [ping],
      contextLimitTokens: 100,
      catalog: economyCatalog(cheap),
      compaction: {
        strategy: 'prose',
        recentMessagesToPreserve: 2,
        provider: explicit,
      },
    });

    const result = await agent.run('Plan the release');

    expect(result.response).toBe('finished');
    expect(explicit.completeCalls).toBe(1);
    expect(cheap.completeCalls).toBe(0);
    expect(primary.completeCalls).toBe(3);
  });

  it('records the intent resolution reason on a telemetry span', () => {
    const exporter = new InMemoryExporter();
    const telemetry = new Telemetry({ exporters: [exporter] });
    const cheap = new MockCompletionProvider();

    new Agent({
      name: 'catalog-span',
      provider: new MockCompletionProvider(),
      telemetry,
      catalog: economyCatalog(cheap),
      compaction: { strategy: 'prose' },
    });

    const span = exporter.spans.find((candidate) => candidate.name === 'ottrix.intent.resolve');
    expect(span?.attributes['ottrix.intent.resolution']).toBe(
      'explicit intent map: summarization:economy → haiku',
    );
    expect(span?.attributes['ottrix.intent.role']).toBe('summarization');
    expect(span?.attributes['ottrix.intent.model']).toBe('claude-haiku');
  });

  it('summarizes with the primary provider when no catalog is configured', async () => {
    const primary = new MockCompletionProvider()
      .setTokenCount(1_000)
      .enqueue(toolUseCompletion([{ id: 't1', name: 'ping', input: {} }], usage))
      .enqueue(toolUseCompletion([{ id: 't2', name: 'ping', input: {} }], usage))
      .enqueue(textCompletion('Earlier turns covered billing.', usage))
      .enqueue(textCompletion('finished', usage));
    const prompts = spyCompletes(primary);

    const agent = new Agent({
      name: 'no-catalog',
      provider: primary,
      tools: [ping],
      contextLimitTokens: 100,
      compaction: { strategy: 'prose', recentMessagesToPreserve: 2 },
    });

    const result = await agent.run('Plan the release');

    expect(result.response).toBe('finished');
    expect(primary.completeCalls).toBe(4);
    expect(prompts.some((params) => promptText(params).includes('CONCISE DIGEST'))).toBe(true);
    expect(prompts.some((params) => params.intentResolution)).toBe(false);
  });
});
