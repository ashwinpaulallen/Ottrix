import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionParams,
  CompletionProvider,
  CompletionResult,
  StreamChunk,
} from '../../src/types/provider.js';
import { CircuitOpenError } from '../../src/providers/circuit-breaker.js';
import { ProviderError } from '../../src/providers/errors.js';
import {
  ProviderRegistry,
  computeFallbackBackoffMs,
  estimateCost,
  shouldTryFallback,
} from '../../src/providers/registry.js';

function mockResult(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'stop',
    ...overrides,
  };
}

function createMockProvider(
  name: string,
  handlers: {
    complete?: (params: CompletionParams) => Promise<CompletionResult>;
    stream?: (params: CompletionParams) => AsyncIterable<StreamChunk>;
    countTokens?: (messages: Parameters<CompletionProvider['countTokens']>[0]) => Promise<number>;
  } = {},
): CompletionProvider {
  return {
    complete:
      handlers.complete ??
      vi.fn(async () => mockResult({ model: `${name}-model` as `${string}-model` })),
    stream:
      handlers.stream ??
      (async function* () {
        yield { type: 'text_delta', data: { text: name } };
        yield { type: 'done', data: { stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
      }),
    countTokens: handlers.countTokens ?? vi.fn(async () => 42),
  };
}

describe('ProviderRegistry', () => {
  it('registers and retrieves providers by name', () => {
    const registry = new ProviderRegistry();
    const anthropic = createMockProvider('anthropic');
    registry.register('anthropic', anthropic, { capabilities: { supportsTools: true } });

    expect(registry.get('anthropic')).toBe(anthropic);
  });

  it('sets and uses the default provider', async () => {
    const registry = new ProviderRegistry();
    const primary = createMockProvider('primary');
    const complete = vi.fn(async () => mockResult());
    primary.complete = complete;

    registry.register('primary', primary).setDefault('primary');

    await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(complete).toHaveBeenCalledOnce();
  });

  it('throws when getting an unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('missing')).toThrow('not registered');
  });
});

describe('shouldTryFallback', () => {
  it('returns true for retryable errors', () => {
    expect(
      shouldTryFallback(new ProviderError('rate limited', { code: 'rate_limit', retryable: true })),
    ).toBe(true);
  });

  it('returns true for auth and context_length (fallback to next provider)', () => {
    expect(
      shouldTryFallback(new ProviderError('unauthorized', { code: 'auth', retryable: false })),
    ).toBe(true);
    expect(
      shouldTryFallback(
        new ProviderError('too long', { code: 'context_length', retryable: false }),
      ),
    ).toBe(true);
  });

  it('returns false for non-ProviderError', () => {
    expect(shouldTryFallback(new Error('generic'))).toBe(false);
  });

  it('returns true for CircuitOpenError', () => {
    expect(shouldTryFallback(new CircuitOpenError('open', 'anthropic', 1000))).toBe(true);
  });
});

describe('computeFallbackBackoffMs', () => {
  it('caps delay at maxDelayMs', () => {
    expect(
      computeFallbackBackoffMs(10, {
        baseDelayMs: 500,
        maxDelayMs: 1000,
        maxJitterMs: 0,
        random: () => 0,
      }),
    ).toBe(1000);
  });
});

describe('ProviderRegistry fallback chain', () => {
  it('falls back to the next provider on retryable errors', async () => {
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    const primary = createMockProvider('anthropic', {
      complete: vi.fn(async () => {
        throw new ProviderError('overloaded', { code: 'server_error', retryable: true });
      }),
    });
    const secondary = createMockProvider('openai', {
      complete: vi.fn(async () => mockResult({ model: 'gpt-4o' })),
    });

    registry
      .register('anthropic', primary, { capabilities: { costTier: 'medium' } })
      .register('openai', secondary, { capabilities: { costTier: 'low' } })
      .setFallbackChain(['anthropic', 'openai']);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.model).toBe('gpt-4o');
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(secondary.complete).toHaveBeenCalledOnce();
  });

  it('falls back immediately on auth without retrying the same provider', async () => {
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    const primary = createMockProvider('anthropic', {
      complete: vi.fn(async () => {
        throw new ProviderError('invalid key', { code: 'auth', retryable: false });
      }),
    });
    const secondary = createMockProvider('openai', {
      complete: vi.fn(async () => mockResult()),
    });

    registry
      .register('anthropic', primary)
      .register('openai', secondary)
      .setFallbackChain(['anthropic', 'openai']);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.metadata?.provider).toBe('openai');
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(secondary.complete).toHaveBeenCalledOnce();
  });

  it('skips unhealthy providers in the chain', async () => {
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 1 });

    const failingComplete = vi.fn(async () => {
      throw new ProviderError('down', { code: 'server_error', retryable: true });
    });
    const backupComplete = vi.fn(async () => mockResult({ model: 'llama3.1' }));

    registry
      .register('anthropic', createMockProvider('anthropic', { complete: failingComplete }))
      .register('ollama', createMockProvider('ollama', { complete: backupComplete }))
      .setFallbackChain(['anthropic', 'ollama']);

    await registry.complete({ messages: [{ role: 'user', content: 'a' }] });
    expect(registry.isHealthy('anthropic')).toBe(false);

    await registry.complete({ messages: [{ role: 'user', content: 'b' }] });
    expect(failingComplete).toHaveBeenCalledOnce();
    expect(backupComplete).toHaveBeenCalledTimes(2);
  });

  it('falls back on stream connection errors before the first chunk', async () => {
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    const primary = createMockProvider('anthropic', {
      stream: async function* () {
        throw new ProviderError('connection reset', { code: 'timeout', retryable: true });
      },
    });
    const secondary = createMockProvider('openai', {
      stream: async function* () {
        yield { type: 'text_delta', data: { text: 'fallback' } };
        yield { type: 'done', data: { stopReason: 'stop' } };
      },
    });

    registry.register('anthropic', primary).register('openai', secondary).setFallbackChain(['anthropic', 'openai']);

    const chunks: StreamChunk[] = [];
    for await (const chunk of registry.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({ type: 'text_delta', data: { text: 'fallback' } });
  });
});

describe('ProviderRegistry.selectProvider', () => {
  it('selects by capability and cost tier', () => {
    const registry = new ProviderRegistry();
    const cheap = createMockProvider('ollama');
    const capable = createMockProvider('anthropic');

    registry
      .register('ollama', cheap, {
        capabilities: { supportsTools: false, costTier: 'free', latency: 'medium' },
      })
      .register('anthropic', capable, {
        capabilities: { supportsTools: true, costTier: 'medium', latency: 'fast' },
      });

    const selected = registry.selectProvider({ needsTools: true, maxCost: 'medium' });
    expect(selected).toBe(capable);
  });

  it('excludes unhealthy providers from selection', () => {
    const registry = new ProviderRegistry();
    registry.register('a', createMockProvider('a'), { capabilities: { costTier: 'low' } });
    registry.register('b', createMockProvider('b'), { capabilities: { costTier: 'low' } });
    registry.setHealthy('a', false);

    const selected = registry.selectProvider({ maxCost: 'high' });
    expect(selected).toBe(registry.get('b'));
  });
});

describe('ProviderRegistry cost tracking', () => {
  it('aggregates token usage and estimated cost', async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider('anthropic', {
      complete: vi.fn(async () =>
        mockResult({
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        }),
      ),
    });

    registry
      .register('anthropic', provider, {
        capabilities: { costTier: 'medium' },
        costRates: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
      })
      .setDefault('anthropic');

    await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    const summary = registry.getCostSummary();
    expect(summary.totalInputTokens).toBe(1000);
    expect(summary.totalOutputTokens).toBe(500);
    expect(summary.byProvider.anthropic?.requestCount).toBe(1);
    expect(summary.byProvider.anthropic?.estimatedCostUsd).toBeCloseTo(0.003 + 0.0075, 6);
  });

  it('estimateCost computes USD from token usage', () => {
    const cost = estimateCost(
      { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
      { inputPer1kTokens: 0.001, outputPer1kTokens: 0.002 },
    );
    expect(cost).toBeCloseTo(0.004, 6);
  });
});
