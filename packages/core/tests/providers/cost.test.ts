import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { estimateAgentResultCost, estimateResultCost } from '../../src/providers/cost.js';

describe('estimateResultCost', () => {
  it('computes USD from token usage and rates', () => {
    const cost = estimateResultCost(
      { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    );
    expect(cost).toBeCloseTo(0.0105);
  });
});

describe('estimateAgentResultCost', () => {
  it('uses provider rates from the registry', () => {
    const registry = new ProviderRegistry();
    const provider = {
      complete: async () => ({
        message: { role: 'assistant' as const, content: 'ok' },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: 'end_turn' as const,
      }),
      stream: async function* () {},
      countTokens: async () => 0,
    };
    registry.register('anthropic', provider, {
      costRates: { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015 },
    });

    const cost = estimateAgentResultCost(
      { totalTokens: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } },
      registry,
      'anthropic',
    );
    expect(cost).toBeCloseTo(0.018);
  });
});
