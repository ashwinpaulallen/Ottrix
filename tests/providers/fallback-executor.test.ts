import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionProvider,
  CompletionResult,
} from '../../src/types/provider.js';
import { ensureCompletionLatency } from '../../src/providers/latency.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import {
  AggregateProviderError,
  ProviderError,
} from '../../src/providers/errors.js';
import {
  classifyProviderError,
  computeProviderBackoffMs,
} from '../../src/providers/fallback-executor.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { StreamChunk } from '../../src/types/provider.js';
import { Telemetry } from '../../src/observability/telemetry.js';

function mockResult(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return ensureCompletionLatency({
    content: [{ type: 'text', text: 'ok' }],
    model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    stopReason: 'stop',
    ...overrides,
  });
}

function createMockProvider(
  handlers: {
    complete?: () => Promise<CompletionResult>;
    stream?: () => AsyncIterable<StreamChunk>;
  } = {},
): CompletionProvider {
  return {
    complete: handlers.complete ?? vi.fn(async () => mockResult()),
    stream:
      handlers.stream ??
      (async function* () {
        yield { type: 'text_delta', data: { text: 'ok' } };
        yield { type: 'done', data: { stopReason: 'stop' } };
      }),
    countTokens: vi.fn(async () => 1),
  };
}

class TestBaseProvider extends BaseProvider {
  constructor(
    config: BaseProviderConfig,
    private readonly failComplete?: () => Promise<never>,
  ) {
    super(config);
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    if (this.failComplete) return this.failComplete() as never;
    return mockResult({ model: this.config.defaultModel });
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected async _countTokens(): Promise<number> {
    return 1;
  }
}

describe('classifyProviderError', () => {
  it('classifies retryable server errors as retry when attempts remain', () => {
    expect(
      classifyProviderError(
        new ProviderError('down', { code: 'server_error', retryable: true }),
        { retriesRemaining: 1 },
      ),
    ).toBe('retry');
  });

  it('classifies auth as immediate fallback', () => {
    expect(
      classifyProviderError(
        new ProviderError('unauthorized', { code: 'auth', retryable: false }),
        { retriesRemaining: 2 },
      ),
    ).toBe('fallback');
  });

  it('classifies invalid_request as terminal', () => {
    expect(
      classifyProviderError(
        new ProviderError('bad request', { code: 'invalid_request', retryable: false }),
        { retriesRemaining: 2 },
      ),
    ).toBe('terminal');
  });
});

describe('ProviderRegistry hardened fallback chain', () => {
  it('primary succeeds with no fallback', async () => {
    const primaryComplete = vi.fn(async () => mockResult({ model: 'primary' }));
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    registry
      .register('primary', createMockProvider({ complete: primaryComplete }))
      .register('backup', createMockProvider())
      .setFallbackChain([{ provider: 'primary', retries: 2 }, { provider: 'backup' }]);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.model).toBe('primary');
    expect(result.metadata?.provider).toBe('primary');
    expect(result.metadata?.attempt).toBe(1);
    expect(result.metadata?.fallbacksTriggered).toBe(0);
    expect(primaryComplete).toHaveBeenCalledOnce();
  });

  it('retries on retryable errors then succeeds on the same provider', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const primaryComplete = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new ProviderError('rate limited', { code: 'rate_limit', retryable: true });
      }
      return mockResult({ model: 'primary' });
    });

    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      sleep: vi.fn(async () => undefined),
      random: () => 0,
    });

    registry
      .register('primary', createMockProvider({ complete: primaryComplete }))
      .setFallbackChain([
        {
          provider: 'primary',
          retries: 2,
          backoff: { base: 100, max: 1000, jitter: false },
        },
      ]);

    const pending = registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.model).toBe('primary');
    expect(result.metadata?.provider).toBe('primary');
    expect(result.metadata?.attempt).toBe(3);
    expect(primaryComplete).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('exhausts primary retries then falls back to secondary', async () => {
    const primaryComplete = vi.fn(async () => {
      throw new ProviderError('overloaded', { code: 'server_error', retryable: true });
    });
    const secondaryComplete = vi.fn(async () => mockResult({ model: 'secondary' }));

    const events: string[] = [];
    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      onFallbackEvent: (e) => events.push(e.type),
    });

    registry
      .register('primary', createMockProvider({ complete: primaryComplete }))
      .register('secondary', createMockProvider({ complete: secondaryComplete }))
      .setFallbackChain([
        { provider: 'primary', retries: 1, backoff: { base: 0, max: 0, jitter: false } },
        { provider: 'secondary', retries: 0 },
      ]);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.model).toBe('secondary');
    expect(result.metadata?.provider).toBe('secondary');
    expect(result.metadata?.fallbacksTriggered).toBe(1);
    expect(primaryComplete).toHaveBeenCalledTimes(2);
    expect(secondaryComplete).toHaveBeenCalledOnce();
    expect(events).toContain('retry');
    expect(events).toContain('fallback');
    expect(events).toContain('success');
  });

  it('throws AggregateProviderError when all providers fail', async () => {
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    registry
      .register(
        'primary',
        createMockProvider({
          complete: async () => {
            throw new ProviderError('down', { code: 'server_error', retryable: true });
          },
        }),
      )
      .register(
        'secondary',
        createMockProvider({
          complete: async () => {
            throw new ProviderError('also down', { code: 'timeout', retryable: true });
          },
        }),
      )
      .setFallbackChain([
        { provider: 'primary', retries: 0 },
        { provider: 'secondary', retries: 0 },
      ]);

    try {
      await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
      expect.fail('expected AggregateProviderError');
    } catch (error) {
      expect(AggregateProviderError.isAggregateProviderError(error)).toBe(true);
      const aggregate = error as AggregateProviderError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]?.provider).toBe('primary');
      expect(aggregate.errors[1]?.provider).toBe('secondary');
      expect(aggregate.getLastError()?.message).toBe('also down');
    }
  });

  it('throws AggregateProviderError on terminal invalid_request without trying fallbacks', async () => {
    const secondaryComplete = vi.fn(async () => mockResult());
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    registry
      .register(
        'primary',
        createMockProvider({
          complete: async () => {
            throw new ProviderError('bad request', {
              code: 'invalid_request',
              retryable: false,
            });
          },
        }),
      )
      .register('secondary', createMockProvider({ complete: secondaryComplete }))
      .setFallbackChain([{ provider: 'primary' }, { provider: 'secondary' }]);

    await expect(
      registry.complete({ messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toBeInstanceOf(AggregateProviderError);

    expect(secondaryComplete).not.toHaveBeenCalled();
  });

  it('falls back immediately on auth without retrying the same provider', async () => {
    const primaryComplete = vi.fn(async () => {
      throw new ProviderError('invalid key', { code: 'auth', retryable: false });
    });
    const secondaryComplete = vi.fn(async () => mockResult({ model: 'secondary' }));

    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    registry
      .register('primary', createMockProvider({ complete: primaryComplete }))
      .register('secondary', createMockProvider({ complete: secondaryComplete }))
      .setFallbackChain([
        { provider: 'primary', retries: 3 },
        { provider: 'secondary' },
      ]);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.metadata?.provider).toBe('secondary');
    expect(primaryComplete).toHaveBeenCalledOnce();
    expect(secondaryComplete).toHaveBeenCalledOnce();
  });

  it('skips a provider with an open circuit without calling it', async () => {
    const failing = new TestBaseProvider(
      {
        defaultModel: 'primary-model',
        providerId: 'primary',
        requestsPerMinute: 1_000_000,
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      },
      async () => {
        throw new ProviderError('down', { code: 'server_error', retryable: true });
      },
    );

    await expect(
      failing.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
    expect(failing.isCircuitOpen()).toBe(true);

    const backupComplete = vi.fn(async () => mockResult({ model: 'backup' }));
    const registry = new ProviderRegistry({ unhealthyFailureThreshold: 10 });

    registry
      .register('primary', failing)
      .register('backup', createMockProvider({ complete: backupComplete }))
      .setFallbackChain([{ provider: 'primary' }, { provider: 'backup' }]);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(backupComplete).toHaveBeenCalledOnce();
    expect(result.metadata?.provider).toBe('backup');
    expect(result.metadata?.fallbacksTriggered).toBe(1);
  });

  it('records metadata for provider, attempt, fallbacks, and latency', async () => {
    let now = 0;
    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      random: () => 0,
    });

    let calls = 0;
    registry
      .register(
        'primary',
        createMockProvider({
          complete: async () => {
            calls += 1;
            if (calls === 1) {
              throw new ProviderError('busy', { code: 'rate_limit', retryable: true });
            }
            return mockResult();
          },
        }),
      )
      .setFallbackChain([
        { provider: 'primary', retries: 1, backoff: { base: 100, max: 500, jitter: false } },
      ]);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.metadata?.provider).toBe('primary');
    expect(result.metadata?.attempt).toBe(2);
    expect(result.metadata?.fallbacksTriggered).toBe(0);
    expect(result.metadata?.totalLatencyMs).toBeGreaterThanOrEqual(100);
  });

  it('records telemetry span events and error metrics', async () => {
    const telemetry = new Telemetry();
    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      telemetry,
    });

    registry
      .register(
        'primary',
        createMockProvider({
          complete: async () => {
            throw new ProviderError('down', { code: 'server_error', retryable: true });
          },
        }),
      )
      .register('secondary', createMockProvider({ complete: async () => mockResult() }))
      .setFallbackChain([{ provider: 'primary', retries: 0 }, { provider: 'secondary' }]);

    const span = telemetry.startSpan('test');
    await telemetry.withActiveSpan(span, async () => {
      await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });
    });
    span.end();

    const hasFallbackEvent = telemetry.finishedSpans.some((span) =>
      span.events.some((e) => e.name === 'provider.fallback'),
    );
    expect(hasFallbackEvent).toBe(true);
    expect(telemetry.counter('provider.errors', { provider: 'primary', code: 'server_error' }).get()).toBe(1);
  });
});

describe('computeProviderBackoffMs', () => {
  it('applies jitter when enabled', () => {
    expect(
      computeProviderBackoffMs(1, { base: 500, max: 5000, jitter: true }, () => 0.5),
    ).toBeGreaterThan(500);
  });
});
