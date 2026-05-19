import { describe, expect, it } from 'vitest';
import type {
  CompletionResult,
  StreamChunk,
} from '../../src/types/provider.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import {
  computeCompletionLatency,
  stampStreamChunk,
} from '../../src/providers/latency.js';
import { setMetricsCollector } from '../../src/observability/global.js';
import { MetricsCollector } from '../../src/observability/metrics.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LatencyTestProvider extends BaseProvider {
  constructor(
    private readonly handlers: {
      complete?: () => Promise<CompletionResult>;
      stream?: () => AsyncIterable<StreamChunk>;
    } = {},
    config: BaseProviderConfig = { defaultModel: 'test-model', providerId: 'latency-test' },
  ) {
    super({ ...config, circuitBreakerDisabled: true, requestsPerMinute: 10_000 });
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    if (this.handlers.complete) {
      return this.handlers.complete();
    }
    await delay(25);
    return {
      content: [{ type: 'text', text: 'ok' }],
      model: 'test-model',
      usage: { inputTokens: 1, outputTokens: 4, totalTokens: 5 },
      stopReason: 'stop',
      latency: computeCompletionLatency({ ttftMs: 0, totalTimeMs: 0, outputTokens: 4 }),
    };
  }

  protected async *_rawStream(): AsyncGenerator<StreamChunk> {
    if (this.handlers.stream) {
      yield* this.handlers.stream();
      return;
    }

    await delay(40);
    yield stampStreamChunk({ type: 'text_delta', data: { text: 'hello' } });
    await delay(20);
    yield stampStreamChunk({
      type: 'done',
      data: {
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 10, totalTokens: 11 },
      },
    });
  }

  protected async _countTokens(): Promise<number> {
    return 1;
  }
}

describe('provider latency tracking', () => {
  it('captures TTFT and total time in streaming mode', async () => {
    const provider = new LatencyTestProvider();
    const chunks: StreamChunk[] = [];

    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk);
    }

    const first = chunks.find((chunk) => chunk.type === 'text_delta');
    const done = chunks.find((chunk) => chunk.type === 'done');

    expect(first?.timestamp).toBeTypeOf('number');
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') {
      throw new Error('expected done chunk');
    }

    expect(done.data.latency?.ttft).toBeGreaterThanOrEqual(35);
    expect(done.data.latency?.totalTime).toBeGreaterThanOrEqual(55);
    expect(done.data.latency?.tokensPerSecond).toBeCloseTo(
      10 / ((done.data.latency?.totalTime ?? 1) / 1000),
      5,
    );
  });

  it('sets ttft equal to totalTime for non-streaming complete()', async () => {
    const provider = new LatencyTestProvider();
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.latency.ttft).toBeGreaterThanOrEqual(20);
    expect(result.latency.totalTime).toBeGreaterThanOrEqual(20);
    expect(result.latency.ttft).toBeCloseTo(result.latency.totalTime, 5);
    expect(result.latency.tokensPerSecond).toBeCloseTo(
      result.usage.outputTokens / (result.latency.totalTime / 1000),
      5,
    );
  });

  it('records provider metrics after each call', async () => {
    const metrics = new MetricsCollector();
    setMetricsCollector(metrics);
    const provider = new LatencyTestProvider();

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(metrics.getStats('requests_total', { provider: 'latency-test', status: 'success' }).count).toBe(1);
    expect(metrics.getStats('ttft_ms', { provider: 'latency-test' }).count).toBe(1);
    expect(metrics.getStats('token_usage_output', { provider: 'latency-test' }).count).toBe(1);
  });
});

describe('computeCompletionLatency', () => {
  it('computes tokens per second from total request time', () => {
    const latency = computeCompletionLatency({
      ttftMs: 100,
      totalTimeMs: 500,
      outputTokens: 50,
    });

    expect(latency.tokensPerSecond).toBe(100);
  });
});
