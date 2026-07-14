import { afterEach, describe, expect, it } from 'vitest';

import {
  attachCosts,
  createTokenPricing,
  useTokenPricing,
  type PricingResolver,
} from '../../../src/observability/token-accounting/cost-attribution.js';
import { CAPABILITY } from '../../../src/observability/token-accounting/types.js';
import type { TokenBreakdown } from '../../../src/observability/token-accounting/types.js';

function baseBreakdown(overrides: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return {
    runId: 'run-cost',
    totalInputTokens: 1100,
    totalOutputTokens: 150,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalTokens: 1250,
    totalCalls: 2,
    byCapability: {
      [CAPABILITY.LLM]: {
        capability: CAPABILITY.LLM,
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 1,
      },
      [CAPABILITY.EVALUATION]: {
        capability: CAPABILITY.EVALUATION,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 1,
      },
    },
    ...overrides,
  };
}

describe('attachCosts', () => {
  afterEach(() => {
    useTokenPricing(undefined);
  });

  it('correctly calculates costUsd for each capability', () => {
    const pricing = createTokenPricing({
      inputPer1kTokens: 1,
      outputPer1kTokens: 2,
    });

    const result = attachCosts(baseBreakdown(), pricing, 'anthropic', 'claude');

    // LLM: 1000/1000*1 + 100/1000*2 = 1.2
    expect(result.byCapability[CAPABILITY.LLM]?.costUsd).toBeCloseTo(1.2, 6);
    // EVAL: 100/1000*1 + 50/1000*2 = 0.2
    expect(result.byCapability[CAPABILITY.EVALUATION]?.costUsd).toBeCloseTo(0.2, 6);
  });

  it('totalCostUsd is sum of all capabilities', () => {
    const pricing = createTokenPricing({
      inputPer1kTokens: 1,
      outputPer1kTokens: 2,
    });

    const result = attachCosts(baseBreakdown(), pricing, 'anthropic', 'claude');
    expect(result.totalCostUsd).toBeCloseTo(1.4, 6);
  });

  it('topCapabilityByCost is the highest cost capability', () => {
    const pricing = createTokenPricing({
      inputPer1kTokens: 1,
      outputPer1kTokens: 2,
    });

    const result = attachCosts(baseBreakdown(), pricing, 'anthropic', 'claude');
    expect(result.topCapabilityByCost).toBe(CAPABILITY.LLM);
  });

  it('with no Pricing: costUsd undefined, no crash', () => {
    const noPricing: PricingResolver = {
      calculate: () => undefined,
    };

    const result = attachCosts(baseBreakdown(), noPricing, 'anthropic', 'claude');

    expect(result.byCapability[CAPABILITY.LLM]?.costUsd).toBeUndefined();
    expect(result.byCapability[CAPABILITY.EVALUATION]?.costUsd).toBeUndefined();
    expect(result.totalCostUsd).toBeUndefined();
    expect(result.topCapabilityByCost).toBeUndefined();
  });

  it('cache read tokens: priced at 0.1x input rate', () => {
    const pricing = createTokenPricing({
      inputPer1kTokens: 1,
      outputPer1kTokens: 0,
    });

    const breakdown = baseBreakdown({
      byCapability: {
        [CAPABILITY.LLM]: {
          capability: CAPABILITY.LLM,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          calls: 1,
        },
      },
    });

    const result = attachCosts(breakdown, pricing, 'anthropic', 'claude');
    // 1000/1000 * 1 * 0.1 = 0.1
    expect(result.byCapability[CAPABILITY.LLM]?.costUsd).toBeCloseTo(0.1, 6);
  });

  it('cache write tokens: priced at 1.25x input rate', () => {
    const pricing = createTokenPricing({
      inputPer1kTokens: 1,
      outputPer1kTokens: 0,
    });

    const breakdown = baseBreakdown({
      byCapability: {
        [CAPABILITY.LLM]: {
          capability: CAPABILITY.LLM,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 1000,
          calls: 1,
        },
      },
    });

    const result = attachCosts(breakdown, pricing, 'anthropic', 'claude');
    // 1000/1000 * 1 * 1.25 = 1.25
    expect(result.byCapability[CAPABILITY.LLM]?.costUsd).toBeCloseTo(1.25, 6);
  });
});
