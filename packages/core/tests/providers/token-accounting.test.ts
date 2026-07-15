import { afterEach, describe, expect, it, vi } from 'vitest';

import * as tokenContext from '../../src/observability/token-accounting/context.js';
import {
  withCapabilityScope,
  withTokenAccounting,
} from '../../src/observability/token-accounting/context.js';
import { CAPABILITY } from '../../src/observability/token-accounting/types.js';
import {
  ANTHROPIC_DEFAULT_MODEL,
  createAnthropicProvider,
} from '../../src/providers/anthropic.js';
import { BaseProvider, type BaseProviderConfig } from '../../src/providers/base.js';
import {
  computeCompletionLatency,
  stampStreamChunk,
} from '../../src/providers/latency.js';
import type { CompletionResult, StreamChunk } from '../../src/types/provider.js';

class AccountingTestProvider extends BaseProvider {
  constructor(
    private readonly handlers: {
      complete?: () => Promise<CompletionResult>;
      stream?: () => AsyncIterable<StreamChunk>;
    } = {},
    config: BaseProviderConfig = {
      defaultModel: 'test-model',
      providerId: 'test-provider',
    },
  ) {
    super({ ...config, circuitBreakerDisabled: true, requestsPerMinute: 10_000 });
  }

  protected async _rawComplete(): Promise<CompletionResult> {
    if (this.handlers.complete) {
      return this.handlers.complete();
    }
    return {
      content: [{ type: 'text', text: 'ok' }],
      model: 'test-model',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: 'stop',
      latency: computeCompletionLatency({ ttftMs: 1, totalTimeMs: 2, outputTokens: 5 }),
    };
  }

  protected async *_rawStream(): AsyncGenerator<StreamChunk> {
    if (this.handlers.stream) {
      yield* this.handlers.stream();
      return;
    }
    yield stampStreamChunk({ type: 'text_delta', data: { text: 'hi' } });
    yield stampStreamChunk({
      type: 'done',
      data: {
        stopReason: 'stop',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
    });
  }

  protected async _countTokens(): Promise<number> {
    return 1;
  }
}

describe('BaseProvider token accounting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('after complete(), recordTokens is called with correct values', async () => {
    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = new AccountingTestProvider();

    await withTokenAccounting('run-complete', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 10,
          outputTokens: 5,
          model: 'test-model',
          provider: 'test-provider',
        }),
      );
      expect(acc.getBreakdown().byCapability[CAPABILITY.LLM]?.inputTokens).toBe(10);
    });
  });

  it('after stream(), recordTokens is called with correct values', async () => {
    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = new AccountingTestProvider();

    await withTokenAccounting('run-stream', async (acc) => {
      await withCapabilityScope(CAPABILITY.EVALUATION, async () => {
        for await (const chunk of provider.stream({
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          void chunk;
        }
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 8,
          outputTokens: 3,
          model: 'test-model',
          provider: 'test-provider',
        }),
      );
      expect(acc.getBreakdown().byCapability[CAPABILITY.EVALUATION]?.calls).toBe(1);
    });
  });

  it('cacheReadTokens mapped correctly from Anthropic response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'msg_01',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            model: ANTHROPIC_DEFAULT_MODEL,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_read_input_tokens: 200,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      requestsPerMinute: 10_000,
      maxRetries: 0,
      providerId: 'anthropic',
    });

    await withTokenAccounting('run-cache-read', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        const result = await provider.complete({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(result.usage.cacheReadTokens).toBe(200);
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheReadTokens: 200,
          inputTokens: 12,
          outputTokens: 4,
        }),
      );
      expect(acc.getBreakdown().totalCacheReadTokens).toBe(200);
    });
  });

  it('cacheWriteTokens mapped correctly from Anthropic response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'msg_02',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello!' }],
            model: ANTHROPIC_DEFAULT_MODEL,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_creation_input_tokens: 90,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      requestsPerMinute: 10_000,
      maxRetries: 0,
      providerId: 'anthropic',
    });

    await withTokenAccounting('run-cache-write', async (acc) => {
      await withCapabilityScope(CAPABILITY.LLM, async () => {
        const result = await provider.complete({
          messages: [{ role: 'user', content: 'Hi' }],
        });
        expect(result.usage.cacheWriteTokens).toBe(90);
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheWriteTokens: 90,
          inputTokens: 12,
          outputTokens: 4,
        }),
      );
      expect(acc.getBreakdown().totalCacheWriteTokens).toBe(90);
    });
  });

  it('no accumulator active → recordTokens is called but is a no-op (no crash)', async () => {
    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = new AccountingTestProvider();

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).resolves.toBeDefined();

    expect(spy).toHaveBeenCalledOnce();

    for await (const chunk of provider.stream({
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void chunk;
    }

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('provider name is included in the token record', async () => {
    const spy = vi.spyOn(tokenContext, 'recordTokens');
    const provider = new AccountingTestProvider(
      {},
      { defaultModel: 'test-model', providerId: 'anthropic-test' },
    );

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic-test',
        model: 'test-model',
      }),
    );
  });
});
