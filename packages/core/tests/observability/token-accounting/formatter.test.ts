import { describe, expect, it } from 'vitest';

import {
  formatTokenBreakdown,
  formatTokenBreakdownTable,
} from '../../../src/observability/token-accounting/formatter.js';
import { CAPABILITY } from '../../../src/observability/token-accounting/types.js';
import type { TokenBreakdown } from '../../../src/observability/token-accounting/types.js';

function sampleBreakdown(overrides: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return {
    runId: 'run-fmt-1',
    totalInputTokens: 1100,
    totalOutputTokens: 150,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalTokens: 1250,
    totalCalls: 3,
    totalCostUsd: 0.0425,
    byCapability: {
      [CAPABILITY.EVALUATION]: {
        capability: CAPABILITY.EVALUATION,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 1,
        costUsd: 0.0025,
      },
      [CAPABILITY.LLM]: {
        capability: CAPABILITY.LLM,
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 2,
        costUsd: 0.04,
      },
    },
    ...overrides,
  };
}

describe('formatTokenBreakdown', () => {
  it('produces a readable multiline string', () => {
    const text = formatTokenBreakdown(sampleBreakdown());

    expect(text).toContain('Token usage for run run-fmt-1:');
    expect(text).toContain('Total: 1,250 tokens');
    expect(text).toContain('(1,100 in, 150 out)');
    expect(text).toContain('$0.0425');
    expect(text).toContain('By capability:');
    expect(text).toContain('_llm: 1,100 tokens × 2 calls ($0.0400)');
    expect(text).toContain('_evaluation: 150 tokens ($0.0025)');
    expect(text.split('\n').length).toBeGreaterThan(3);
  });

  it('shows cache tokens when totalCacheReadTokens > 0', () => {
    const text = formatTokenBreakdown(
      sampleBreakdown({
        totalCacheReadTokens: 500,
        totalCacheWriteTokens: 200,
      }),
    );

    expect(text).toContain('Cache: 500 reads, 200 writes');
  });

  it('omits cache line when cache reads are zero', () => {
    const text = formatTokenBreakdown(sampleBreakdown({ totalCacheReadTokens: 0 }));
    expect(text).not.toContain('Cache:');
  });
});

describe('formatTokenBreakdownTable', () => {
  it('sorts capabilities by tokens descending', () => {
    const table = formatTokenBreakdownTable(sampleBreakdown());
    const lines = table.split('\n');
    const dataRows = lines.slice(2);

    expect(lines[0]).toContain('Capability');
    expect(dataRows[0]).toMatch(/^_llm\b/);
    expect(dataRows[1]).toMatch(/^_evaluation\b/);
  });
});
