import { describe, expect, it } from 'vitest';

import {
  applyTokenBreakdownAttributes,
  sanitizeOtelAttributeSegment,
  Telemetry,
} from '../../../src/observability/telemetry.js';
import { CAPABILITY } from '../../../src/observability/token-accounting/types.js';
import type { TokenBreakdown } from '../../../src/observability/token-accounting/types.js';

function breakdownWithTools(): TokenBreakdown {
  return {
    runId: 'run-otel-1',
    totalInputTokens: 120,
    totalOutputTokens: 30,
    totalCacheReadTokens: 10,
    totalCacheWriteTokens: 5,
    totalTokens: 150,
    totalCalls: 3,
    totalCostUsd: 0.01,
    byCapability: {
      [CAPABILITY.LLM]: {
        capability: CAPABILITY.LLM,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        calls: 1,
        costUsd: 0.008,
      },
      'tool:web_search': {
        capability: 'tool:web_search',
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 2,
        costUsd: 0.002,
      },
    },
  };
}

describe('applyTokenBreakdownAttributes', () => {
  it('attaches overall and per-capability attributes to the span', () => {
    const telemetry = new Telemetry();
    const span = telemetry.startSpan('agent.run');
    const breakdown = breakdownWithTools();

    applyTokenBreakdownAttributes(span, breakdown);
    span.end();

    const attrs = telemetry.finishedSpans[0]!.attributes;
    expect(attrs['ottrix.tokens.total']).toBe(150);
    expect(attrs['ottrix.tokens.input']).toBe(120);
    expect(attrs['ottrix.tokens.output']).toBe(30);
    expect(attrs['ottrix.tokens.cache_read']).toBe(10);
    expect(attrs['ottrix.tokens.cache_write']).toBe(5);
    expect(attrs['ottrix.cost.usd']).toBe(0.01);
    expect(attrs['ottrix.tokens.by._llm.total']).toBe(120);
    expect(attrs['ottrix.tokens.by._llm.calls']).toBe(1);
    expect(attrs['ottrix.tokens.by._llm.cost_usd']).toBe(0.008);
    expect(attrs['ottrix.tokens.by.tool_web_search.total']).toBe(30);
    expect(attrs['ottrix.tokens.by.tool_web_search.calls']).toBe(2);
  });

  it('sanitizes OTel attribute names (no colons or slashes)', () => {
    expect(sanitizeOtelAttributeSegment('tool:web_search')).toBe('tool_web_search');
    expect(sanitizeOtelAttributeSegment('ns/capability')).toBe('ns_capability');
    expect(sanitizeOtelAttributeSegment('tool:web/search')).toBe('tool_web_search');

    const telemetry = new Telemetry();
    const span = telemetry.startSpan('agent.run');
    applyTokenBreakdownAttributes(span, breakdownWithTools());
    span.end();

    const keys = Object.keys(telemetry.finishedSpans[0]!.attributes);
    const byKeys = keys.filter((key) => key.startsWith('ottrix.tokens.by.'));
    expect(byKeys.every((key) => !key.includes(':') && !key.includes('/'))).toBe(true);
    expect(byKeys.some((key) => key.includes('tool_web_search'))).toBe(true);
  });
});
