import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/types/messages.js';
import type { CompletionResult, StreamChunk } from '../../src/types/provider.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { ensureCompletionLatency } from '../../src/providers/latency.js';
import { checkHealth } from '../../src/http/health.js';

class HealthyProvider extends BaseProvider {
  constructor(config: BaseProviderConfig) {
    super(config);
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    return ensureCompletionLatency({
      content: [{ type: 'text', text: 'ok' }],
      model: this.config.defaultModel,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'stop',
    });
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected async _countTokens(_messages: ChatMessage[]): Promise<number> {
    return 1;
  }
}

class FailingCountProvider extends BaseProvider {
  constructor(config: BaseProviderConfig) {
    super({ ...config, circuitBreaker: { failureThreshold: 5 } });
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    return ensureCompletionLatency({
      content: [{ type: 'text', text: 'ok' }],
      model: this.config.defaultModel,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'stop',
    });
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      yield { type: 'done', data: { stopReason: 'stop' } };
    })();
  }

  protected async _countTokens(_messages: ChatMessage[]): Promise<number> {
    throw new ProviderError('provider down', { code: 'server_error', retryable: true });
  }
}

class CircuitOpenProvider extends BaseProvider {
  constructor(config: BaseProviderConfig) {
    super({ ...config, circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 } });
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    throw new ProviderError('fail', { code: 'server_error', retryable: true });
  }

  protected _rawStream(): AsyncIterable<StreamChunk> {
    return (async function* () {
      throw new ProviderError('fail', { code: 'server_error', retryable: true });
    })();
  }

  protected async _countTokens(_messages: ChatMessage[]): Promise<number> {
    throw new ProviderError('fail', { code: 'server_error', retryable: true });
  }
}

describe('checkHealth', () => {
  it('returns healthy when all providers are up', async () => {
    const registry = new ProviderRegistry();
    registry.register('alpha', new HealthyProvider({ defaultModel: 'alpha-model' }));
    registry.register('beta', new HealthyProvider({ defaultModel: 'beta-model' }));

    const result = await checkHealth(registry);

    expect(result.status).toBe('healthy');
    expect(result.providers.alpha?.status).toBe('up');
    expect(result.providers.beta?.status).toBe('up');
    expect(result.providers.alpha?.latencyMs).toBeTypeOf('number');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded when some providers are down', async () => {
    const registry = new ProviderRegistry();
    registry.register('good', new HealthyProvider({ defaultModel: 'good-model' }));
    registry.register('bad', new FailingCountProvider({ defaultModel: 'bad-model' }));

    const result = await checkHealth(registry);

    expect(result.status).toBe('degraded');
    expect(result.providers.good?.status).toBe('up');
    expect(result.providers.bad?.status).toBe('down');
  });

  it('returns unhealthy when all providers are down', async () => {
    const registry = new ProviderRegistry();
    registry.register('bad-a', new FailingCountProvider({ defaultModel: 'bad-a-model' }));
    registry.register('bad-b', new FailingCountProvider({ defaultModel: 'bad-b-model' }));

    const result = await checkHealth(registry);

    expect(result.status).toBe('unhealthy');
    expect(result.providers['bad-a']?.status).toBe('down');
    expect(result.providers['bad-b']?.status).toBe('down');
  });

  it('reports circuit_open without pinging the provider', async () => {
    const registry = new ProviderRegistry();
    const provider = new CircuitOpenProvider({ defaultModel: 'circuit-model' });
    registry.register('circuit', provider);

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'ping' }] }),
    ).rejects.toThrow();

    const countTokens = vi.spyOn(provider, 'countTokens');
    const result = await checkHealth(registry);

    expect(result.providers.circuit?.status).toBe('circuit_open');
    expect(countTokens).not.toHaveBeenCalled();
    countTokens.mockRestore();
  });

  it('reports registry unhealthy flag as down', async () => {
    const registry = new ProviderRegistry();
    registry.register('marked', new HealthyProvider({ defaultModel: 'marked-model' }));
    registry.setHealthy('marked', false);

    const result = await checkHealth(registry);

    expect(result.providers.marked?.status).toBe('down');
    expect(result.status).toBe('unhealthy');
  });
});
