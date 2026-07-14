import { describe, expect, it } from 'vitest';

import { TokenAccumulator } from '../../../src/observability/token-accounting/accumulator.js';
import { CAPABILITY } from '../../../src/observability/token-accounting/types.js';

describe('TokenAccumulator', () => {
  it('enterScope / exitScope: currentScope changes correctly', () => {
    const acc = new TokenAccumulator('run-1');

    expect(acc.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);

    acc.enterScope(CAPABILITY.LLM);
    expect(acc.getCurrentScope()).toBe(CAPABILITY.LLM);

    acc.exitScope();
    expect(acc.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);
  });

  it('nested scopes: scopeStack behaves like a stack', () => {
    const acc = new TokenAccumulator('run-2');

    acc.enterScope(CAPABILITY.LLM);
    acc.enterScope(`${CAPABILITY.TOOL_PREFIX}web_search`);
    expect(acc.getCurrentScope()).toBe('tool:web_search');

    acc.enterScope(CAPABILITY.EVALUATION);
    expect(acc.getCurrentScope()).toBe(CAPABILITY.EVALUATION);

    acc.exitScope();
    expect(acc.getCurrentScope()).toBe('tool:web_search');

    acc.exitScope();
    expect(acc.getCurrentScope()).toBe(CAPABILITY.LLM);

    acc.exitScope();
    expect(acc.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);
  });

  it('withScope: enters and exits even when fn throws', async () => {
    const acc = new TokenAccumulator('run-3');

    await expect(
      acc.withScope(CAPABILITY.LLM, async () => {
        expect(acc.getCurrentScope()).toBe(CAPABILITY.LLM);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(acc.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);
  });

  it('record: increments global totals correctly', () => {
    const acc = new TokenAccumulator('run-4');

    acc.record({ inputTokens: 10, outputTokens: 5 });
    acc.record({ inputTokens: 20, outputTokens: 7 });

    const breakdown = acc.getBreakdown();
    expect(breakdown.totalInputTokens).toBe(30);
    expect(breakdown.totalOutputTokens).toBe(12);
    expect(breakdown.totalTokens).toBe(42);
    expect(breakdown.totalCalls).toBe(2);
  });

  it('record: increments per-capability totals for current scope', () => {
    const acc = new TokenAccumulator('run-5');

    acc.enterScope(CAPABILITY.LLM);
    acc.record({ inputTokens: 100, outputTokens: 40 });
    acc.exitScope();

    acc.enterScope(CAPABILITY.EVALUATION);
    acc.record({ inputTokens: 15, outputTokens: 8 });
    acc.exitScope();

    const llm = acc.getBreakdown().byCapability[CAPABILITY.LLM]!;
    const evaluation = acc.getBreakdown().byCapability[CAPABILITY.EVALUATION]!;

    expect(llm.inputTokens).toBe(100);
    expect(llm.outputTokens).toBe(40);
    expect(llm.calls).toBe(1);
    expect(evaluation.inputTokens).toBe(15);
    expect(evaluation.outputTokens).toBe(8);
    expect(evaluation.calls).toBe(1);
  });

  it('record with cacheReadTokens: tracked in both global and per-capability', () => {
    const acc = new TokenAccumulator('run-6');

    acc.enterScope(CAPABILITY.LLM);
    acc.record({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 30,
    });
    acc.exitScope();

    const breakdown = acc.getBreakdown();
    expect(breakdown.totalCacheReadTokens).toBe(200);
    expect(breakdown.totalCacheWriteTokens).toBe(30);

    const llm = breakdown.byCapability[CAPABILITY.LLM]!;
    expect(llm.cacheReadTokens).toBe(200);
    expect(llm.cacheWriteTokens).toBe(30);
  });

  it('getBreakdown: returns correct structure', () => {
    const acc = new TokenAccumulator('run-7');
    acc.record({ inputTokens: 1, outputTokens: 2 });

    const breakdown = acc.getBreakdown();

    expect(breakdown.runId).toBe('run-7');
    expect(breakdown).toMatchObject({
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalTokens: 3,
      totalCalls: 1,
    });
    expect(breakdown.byCapability).toBeTypeOf('object');
    expect(breakdown.byCapability[CAPABILITY.UNSCOPED]).toBeDefined();
  });

  it('getBreakdown: topCapabilityByTokens is the highest-usage capability', () => {
    const acc = new TokenAccumulator('run-8');

    acc.enterScope(CAPABILITY.LLM);
    acc.record({ inputTokens: 10, outputTokens: 5 });
    acc.exitScope();

    acc.enterScope(CAPABILITY.EVALUATION);
    acc.record({ inputTokens: 100, outputTokens: 50 });
    acc.exitScope();

    expect(acc.getBreakdown().topCapabilityByTokens).toBe(CAPABILITY.EVALUATION);
  });

  it('ensureCapability: creates entry on first use', () => {
    const acc = new TokenAccumulator('run-9');

    expect(acc.hasScope(CAPABILITY.SUMMARIZATION)).toBe(false);

    acc.enterScope(CAPABILITY.SUMMARIZATION);
    expect(acc.hasScope(CAPABILITY.SUMMARIZATION)).toBe(true);
    expect(acc.getBreakdown().byCapability[CAPABILITY.SUMMARIZATION]).toEqual({
      capability: CAPABILITY.SUMMARIZATION,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 0,
    });

    acc.exitScope();
  });

  it('multiple capabilities: each tracked independently', async () => {
    const acc = new TokenAccumulator('run-10');

    await acc.withScope(CAPABILITY.LLM, async () => {
      acc.record({ inputTokens: 40, outputTokens: 10 });
    });
    await acc.withScope(`${CAPABILITY.TOOL_PREFIX}web_search`, async () => {
      acc.record({ inputTokens: 5, outputTokens: 1 });
    });
    await acc.withScope(CAPABILITY.EVALUATION, async () => {
      acc.record({ inputTokens: 8, outputTokens: 4 });
    });

    const { byCapability, totalCalls, totalInputTokens } = acc.getBreakdown();

    expect(totalCalls).toBe(3);
    expect(totalInputTokens).toBe(53);
    expect(byCapability[CAPABILITY.LLM]?.calls).toBe(1);
    expect(byCapability['tool:web_search']?.inputTokens).toBe(5);
    expect(byCapability[CAPABILITY.EVALUATION]?.outputTokens).toBe(4);
  });

  it('parallel withScope calls: do not interfere (each has own scope stack)', async () => {
    const left = new TokenAccumulator('run-11a');
    const right = new TokenAccumulator('run-11b');

    await Promise.all([
      left.withScope(CAPABILITY.LLM, async () => {
        await new Promise((r) => setTimeout(r, 5));
        left.record({ inputTokens: 100, outputTokens: 20 });
        expect(left.getCurrentScope()).toBe(CAPABILITY.LLM);
      }),
      right.withScope(`${CAPABILITY.TOOL_PREFIX}calculator`, async () => {
        await new Promise((r) => setTimeout(r, 5));
        right.record({ inputTokens: 3, outputTokens: 1 });
        expect(right.getCurrentScope()).toBe('tool:calculator');
      }),
    ]);

    expect(left.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);
    expect(right.getCurrentScope()).toBe(CAPABILITY.UNSCOPED);

    expect(left.getBreakdown().byCapability[CAPABILITY.LLM]?.inputTokens).toBe(100);
    expect(left.hasScope('tool:calculator')).toBe(false);

    expect(right.getBreakdown().byCapability['tool:calculator']?.inputTokens).toBe(3);
    expect(right.hasScope(CAPABILITY.LLM)).toBe(false);
  });
});
