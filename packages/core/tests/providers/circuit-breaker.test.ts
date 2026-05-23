import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/messages.js';
import type {
  CompletionParams,
  CompletionResult,
  StreamChunk,
} from '../../src/types/provider.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import {
  CircuitBreaker,
  CircuitOpenError,
} from '../../src/providers/circuit-breaker.js';
import {
  computeFallbackBackoffMs,
  ProviderRegistry,
  shouldTryFallback,
} from '../../src/providers/registry.js';
import { ensureCompletionLatency } from '../../src/providers/latency.js';
import { ProviderError } from '../../src/providers/errors.js';

function createMockProvider(
  name: string,
  handlers: {
    complete?: (params: CompletionParams) => Promise<CompletionResult>;
  } = {},
) {
  return {
    complete:
      handlers.complete ??
      vi.fn(async () =>
        ensureCompletionLatency({
          content: [{ type: 'text' as const, text: 'ok' }],
          model: name,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: 'stop',
        }),
      ),
    stream: async function* () {
      yield { type: 'text_delta' as const, data: { text: name } };
      yield { type: 'done' as const, data: { stopReason: 'stop' } };
    },
    countTokens: vi.fn(async () => 1),
  };
}

class TestBaseProvider extends BaseProvider {
  constructor(
    config: BaseProviderConfig,
    private readonly handlers: {
      complete?: () => Promise<CompletionResult>;
      stream?: () => AsyncIterable<StreamChunk>;
    } = {},
  ) {
    super(config);
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    if (this.handlers.complete) return this.handlers.complete();
    return ensureCompletionLatency({
      content: [{ type: 'text', text: 'ok' }],
      model: this.config.defaultModel,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'stop',
    });
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    if (this.handlers.stream) return this.handlers.stream();
    return (async function* () {
      yield { type: 'text_delta', data: { text: 'ok' } };
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected async _countTokens(_messages: ChatMessage[]): Promise<number> {
    return 1;
  }
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after consecutive failures reach the threshold', async () => {
    const now = vi.fn(() => 0);
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
      provider: 'test',
      now,
    });

    const fail = () => breaker.execute(async () => {
      throw new Error('down');
    });

    await expect(fail()).rejects.toThrow('down');
    await expect(fail()).rejects.toThrow('down');
    expect(breaker.getState()).toBe('closed');

    await expect(fail()).rejects.toThrow('down');
    expect(breaker.getState()).toBe('open');
    expect(breaker.getStats().failures).toBe(3);
  });

  it('blocks requests while open without running fn', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
      provider: 'blocked',
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    const fn = vi.fn(async () => 'ok');
    await expect(breaker.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('transitions to half-open after reset timeout', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 5_000,
      provider: 'probe',
      now: () => clock,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    expect(breaker.getState()).toBe('open');

    clock = 5_000;
    expect(breaker.getState()).toBe('half_open');
  });

  it('closes after a successful half-open request', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      provider: 'recover',
      now: () => clock,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    clock = 1_000;
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getStats().successes).toBe(1);
  });

  it('wouldRejectRequest when half-open probe slots are full', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      halfOpenMaxAttempts: 1,
      now: () => clock,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    clock = 1_000;
    expect(breaker.getState()).toBe('half_open');

    breaker.beforeRequest();
    expect(breaker.wouldRejectRequest()).toBe(true);
    breaker.afterRequest(false);
  });

  it('reopens when a half-open probe fails', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
      provider: 'flaky',
      now: () => clock,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    clock = 1_000;
    await expect(
      breaker.execute(async () => {
        throw new Error('still down');
      }),
    ).rejects.toThrow('still down');

    expect(breaker.getState()).toBe('open');
  });

  it('reset() forces CLOSED', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    await expect(
      breaker.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();

    breaker.reset();
    expect(breaker.getState()).toBe('closed');
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('CircuitOpenError', () => {
  it('is treated as retryable for fallback', () => {
    const error = new CircuitOpenError('open', 'anthropic', 30_000);
    expect(shouldTryFallback(error)).toBe(true);
    expect(error.provider).toBe('anthropic');
    expect(error.retryAfterMs).toBe(30_000);
  });
});

describe('computeFallbackBackoffMs', () => {
  it('applies exponential backoff capped by maxDelay with jitter', () => {
    vi.useRealTimers();
    const random = vi.fn().mockReturnValue(0.5);
    expect(
      computeFallbackBackoffMs(0, {
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        maxJitterMs: 200,
        random,
      }),
    ).toBe(600);

    expect(
      computeFallbackBackoffMs(2, {
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        maxJitterMs: 200,
        random,
      }),
    ).toBe(2_100);
  });

  it('waits between retries on the same provider using fake timers', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const primaryComplete = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw new ProviderError('down', { code: 'server_error', retryable: true });
      }
      return ensureCompletionLatency({
        content: [{ type: 'text' as const, text: 'backup' }],
        model: 'secondary',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'stop',
      });
    });

    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    registry
      .register('primary', createMockProvider('primary', { complete: primaryComplete }))
      .setFallbackChain([
        { provider: 'primary', retries: 1, backoff: { base: 500, max: 5000, jitter: false } },
      ]);

    const pending = registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    await vi.advanceTimersByTimeAsync(499);
    expect(primaryComplete).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ model: 'secondary' });
    expect(primaryComplete).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe('ProviderRegistry circuit breaker integration', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('skips providers with an open circuit in the fallback chain', async () => {
    const failing = new TestBaseProvider(
      {
        defaultModel: 'primary-model',
        providerId: 'primary',
        requestsPerMinute: 1_000_000,
        circuitBreaker: {
          failureThreshold: 1,
          resetTimeoutMs: 60_000,
          halfOpenMaxAttempts: 1,
        },
      },
      {
        complete: async () => {
          throw new ProviderError('down', { code: 'server_error', retryable: true });
        },
      },
    );

    // Open the circuit on the primary provider.
    await expect(
      failing.complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();

    expect(failing.isCircuitOpen()).toBe(true);

    const backupComplete = vi.fn(async () =>
      ensureCompletionLatency({
        content: [{ type: 'text' as const, text: 'backup' }],
        model: 'backup-model',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'stop',
      }),
    );

    const onProviderFallback = vi.fn();
    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      onProviderFallback,
    });

    registry
      .register('primary', failing)
      .register('backup', createMockProvider('backup', { complete: backupComplete }))
      .setFallbackChain(['primary', 'backup']);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(backupComplete).toHaveBeenCalledOnce();
    expect(result.metadata?.provider).toBe('backup');
    expect(onProviderFallback).toHaveBeenCalledWith({
      event: 'provider_fallback',
      from: 'primary',
      to: 'backup',
      reason: 'circuit_open',
    });
  });

  it('falls back on CircuitOpenError when the circuit opens mid-chain', async () => {
    const primary = createMockProvider('primary', {
      complete: async () => {
        throw new CircuitOpenError('open', 'primary', 1_000);
      },
    });

    const onProviderFallback = vi.fn();
    const registry = new ProviderRegistry({
      unhealthyFailureThreshold: 10,
      fallbackBackoff: { baseDelayMs: 0, maxJitterMs: 0, random: () => 0 },
      onProviderFallback,
    });

    registry
      .register('primary', primary)
      .register('backup', createMockProvider('backup'))
      .setFallbackChain(['primary', 'backup']);

    const result = await registry.complete({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.metadata?.provider).toBe('backup');
    expect(onProviderFallback).toHaveBeenCalledWith({
      event: 'provider_fallback',
      from: 'primary',
      to: 'backup',
      reason: 'circuit_open',
    });
  });
});
